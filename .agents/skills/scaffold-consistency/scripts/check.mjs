import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';

const PROTOCOL = 'pre-sdd-harness/v3';
const PROJECTION_BLOCKER = 'AIH_SCAFFOLD_CONSISTENCY_FAILED';
const CLAUSE_MARKER = /<!--\s*clause:(AIH-STD-[A-Z0-9]+(?:-[A-Z0-9]+)*)\s*-->/g;

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function diagnostic(code, message, location) {
  return { code, message, location, gateClass: 'safety-structure' };
}

function duplicateValues(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

function dependencyClosureIds(manifest, sourceId) {
  const selected = new Set([sourceId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of manifest.projectDag?.edges || []) {
      if (edge.type === 'dependency' && selected.has(edge.to) && !selected.has(edge.from)) {
        selected.add(edge.from);
        changed = true;
      }
    }
  }
  return selected;
}

function dependencyArtifactIds(manifest, sourceId) {
  const scopes = new Map((manifest.scopes || []).map((scope) => [scope.id, scope]));
  return new Set([...dependencyClosureIds(manifest, sourceId)].flatMap((scopeId) => {
    const selector = scopes.get(scopeId)?.selector;
    return selector?.type === 'artifact' ? selector.artifacts || [] : [];
  }));
}

async function projectionAnalysis(root, manifest, standardContent) {
  const diagnostics = [];
  const dependencies = [];
  const registry = manifest.standardProjectionRegistry;
  if (!registry) {
    diagnostics.push(diagnostic(PROJECTION_BLOCKER, '根 Manifest 缺少 Standard Projection Registry。', '.psp/harness/harness.manifest.json'));
    return { diagnostics, dependencies, selected: [] };
  }

  if (registry.authority !== manifest.standard?.authority) {
    diagnostics.push(diagnostic(PROJECTION_BLOCKER, '投影注册表的规范权威与 Manifest standard.authority 不一致。', 'standardProjectionRegistry.authority'));
  }

  const owners = registry.enforcementOwners || [];
  const ownerIds = owners.map((owner) => owner.id);
  for (const id of duplicateValues(ownerIds)) {
    diagnostics.push(diagnostic(PROJECTION_BLOCKER, '投影执行所有者 id 重复：' + id, 'standardProjectionRegistry.enforcementOwners'));
  }
  const ownerById = new Map(owners.map((owner) => [owner.id, owner]));
  for (const owner of owners) {
    try {
      await readFile(resolve(root, owner.path));
    } catch {
      diagnostics.push(diagnostic(PROJECTION_BLOCKER, '投影执行所有者路径不存在：' + owner.path, owner.path));
    }
  }

  const authorityMarkers = [...standardContent.matchAll(CLAUSE_MARKER)].map((match) => match[1]);
  for (const clauseId of duplicateValues(authorityMarkers)) {
    diagnostics.push(diagnostic(PROJECTION_BLOCKER, '上位规范 clause marker 重复：' + clauseId, registry.authority));
  }

  const clauses = registry.clauses || [];
  const registeredClauseIds = clauses.map((clause) => clause.clauseId);
  for (const clauseId of duplicateValues(registeredClauseIds)) {
    diagnostics.push(diagnostic(PROJECTION_BLOCKER, '投影注册 clauseId 重复：' + clauseId, 'standardProjectionRegistry.clauses'));
  }
  for (const clauseId of authorityMarkers) {
    if (!registeredClauseIds.includes(clauseId)) diagnostics.push(diagnostic(PROJECTION_BLOCKER, '上位规范条款未登记下游投影：' + clauseId, registry.authority));
  }
  for (const clauseId of registeredClauseIds) {
    if (!authorityMarkers.includes(clauseId)) diagnostics.push(diagnostic(PROJECTION_BLOCKER, '投影注册条款缺少上位规范 marker：' + clauseId, registry.authority));
  }

  const contractsByPath = new Map();
  for (const clause of clauses) {
    const clauseDiagnostics = [];
    if (clause.authorityAnchor !== clause.clauseId?.toLowerCase()) {
      clauseDiagnostics.push(diagnostic(PROJECTION_BLOCKER, 'authorityAnchor 必须由 clauseId 小写化得到：' + clause.clauseId, 'standardProjectionRegistry.clauses'));
    }
    if (!standardContent.includes('<a id="' + clause.authorityAnchor + '"></a>')) {
      clauseDiagnostics.push(diagnostic(PROJECTION_BLOCKER, '投影注册条款缺少可链接的 authorityAnchor：' + clause.authorityAnchor, registry.authority));
    }
    const referencedOwners = (clause.enforcementOwnerIds || []).map((id) => ownerById.get(id)).filter(Boolean);
    for (const ownerId of clause.enforcementOwnerIds || []) {
      if (!ownerById.has(ownerId)) clauseDiagnostics.push(diagnostic(PROJECTION_BLOCKER, '条款引用未知执行所有者：' + ownerId, clause.clauseId));
    }
    for (const kind of ['schema', 'validator', 'test']) {
      if (!referencedOwners.some((owner) => owner.kind === kind)) {
        clauseDiagnostics.push(diagnostic(PROJECTION_BLOCKER, '条款缺少 ' + kind + ' 执行所有者：' + clause.clauseId, clause.clauseId));
      }
    }

    const targetPaths = (clause.targets || []).map((target) => target.path);
    for (const path of duplicateValues(targetPaths)) {
      clauseDiagnostics.push(diagnostic(PROJECTION_BLOCKER, '同一条款重复登记下游目标：' + path, clause.clauseId));
    }
    for (const [index, target] of (clause.targets || []).entries()) {
      const targetDiagnostics = [];
      if (target.path === registry.authority) {
        targetDiagnostics.push(diagnostic(PROJECTION_BLOCKER, '上位规范不得登记为自己的下游投影：' + clause.clauseId, target.path));
      }
      let content = '';
      try {
        content = await readFile(resolve(root, target.path), 'utf8');
      } catch {
        targetDiagnostics.push(diagnostic(PROJECTION_BLOCKER, '下游投影路径不存在：' + target.path, target.path));
      }
      for (const required of target.requiredText || []) {
        if (!content.includes(required)) targetDiagnostics.push(diagnostic(PROJECTION_BLOCKER, clause.clauseId + ' 下游投影缺少声明文本：' + required, target.path));
      }
      for (const forbidden of target.forbiddenText || []) {
        if (content.includes(forbidden)) targetDiagnostics.push(diagnostic(PROJECTION_BLOCKER, clause.clauseId + ' 下游投影含矛盾或越权文本：' + forbidden, target.path));
      }
      const contract = contractsByPath.get(target.path) || { required: new Set(), forbidden: new Set() };
      for (const text of target.requiredText || []) contract.required.add(text);
      for (const text of target.forbiddenText || []) contract.forbidden.add(text);
      contractsByPath.set(target.path, contract);
      clauseDiagnostics.push(...targetDiagnostics);
      dependencies.push({
        id: 'projection-' + clause.clauseId.toLowerCase().replace(/^aih-std-/, '') + '-' + (index + 1),
        from: registry.authority + '#' + clause.authorityAnchor,
        to: target.path,
        status: targetDiagnostics.length === 0 ? 'PASS' : 'BLOCKED',
      });
    }
    diagnostics.push(...clauseDiagnostics);
  }

  for (const [path, contract] of contractsByPath) {
    for (const text of contract.required) {
      if (contract.forbidden.has(text)) diagnostics.push(diagnostic(PROJECTION_BLOCKER, '同一下游路径同时要求并禁止相同文本：' + text, path));
    }
  }
  return { diagnostics, dependencies, selected: [...new Set(registeredClauseIds)] };
}

async function workspaceLivenessAnalysis(root, project, manifest, packageJson, dispatch) {
  const diagnostics = [];
  const dependencies = [];
  const profiles = new Map((manifest.validationProfiles || []).map((item) => [item.id, item]));
  const scopes = new Map((manifest.scopes || []).map((item) => [item.id, item]));
  for (const edge of (manifest.projectDag?.edges || []).filter((item) => item.type === 'handoff')) {
    const location = edge.from + '->' + edge.to + ':handoff';
    const profile = profiles.get(edge.profile);
    const sourceScope = scopes.get(edge.from);
    const readiness = profiles.get(sourceScope?.readinessProfile);
    const expectedCommands = readiness
      ? ['harness', 'project-consistency', ...readiness.commands.filter((id) => !['harness', 'project-consistency'].includes(id))]
      : [];
    let valid = Boolean(
      profile
      && profile.handoffSource === edge.from
      && profile.allowedContexts?.includes('handoff')
      && sourceScope?.handoffProfile === profile.id
      && JSON.stringify(profile.commands) === JSON.stringify(expectedCommands),
    );
    if (valid) {
      const commands = new Map((manifest.commands || []).map((item) => [item.id, item]));
      const sourceNode = (manifest.projectDag?.nodes || []).find((item) => item.id === edge.from);
      const allowedArtifacts = dependencyArtifactIds(manifest, edge.from);
      const stageArtifacts = new Set(
        (manifest.artifactRegistry || []).filter((item) => item.stage === sourceNode?.stage).map((item) => item.id),
      );
      for (const commandId of profile.commands.filter((id) => !['harness', 'project-consistency'].includes(id))) {
        const command = commands.get(commandId);
        if (command?.executor?.kind !== 'module') {
          valid = false;
          break;
        }
        const executorPath = command.executor.path;
        const domainValidator = executorPath.endsWith('/scripts/validate.mjs');
        const args = command.executor.args || [];
        const stepIndex = args.indexOf('--step');
        const wholeStageAllowed = stageArtifacts.size === allowedArtifacts.size
          && [...stageArtifacts].every((id) => allowedArtifacts.has(id));
        if (
          domainValidator
          && (
            (stepIndex >= 0 && args[stepIndex + 1] !== edge.from)
            || ((args.includes('--strict') || stepIndex < 0) && !wholeStageAllowed)
          )
        ) {
          valid = false;
          break;
        }
        if (!domainValidator && ![...allowedArtifacts].some((artifactId) => executorPath.includes('/' + artifactId + '/'))) {
          valid = false;
          break;
        }
        if (domainValidator) {
          try {
            const executor = await readFile(resolve(root, 'templates/workspace', executorPath), 'utf8');
            if (!executor.includes('collectDependencyArtifactIds')) {
              valid = false;
              break;
            }
          } catch {
            valid = false;
            break;
          }
        }
      }
    }
    if (!valid) {
      diagnostics.push(diagnostic(
        PROJECTION_BLOCKER,
        'Handoff 边必须使用只验证来源 readiness 与 dependency closure 的来源特定 Profile：' + location,
        'templates/workspace/.psp/harness/harness.manifest.json',
      ));
    }
    dependencies.push({
      id: 'handoff-liveness-' + edge.from + '-' + edge.to,
      from: edge.from,
      to: edge.to,
      status: valid ? 'PASS' : 'BLOCKED',
    });
  }

  const refreshOperations = manifest.operations || [];
  for (const [stageId, stage] of Object.entries(project.stages || {})) {
    for (const [artifactId, binding] of Object.entries(stage.artifacts || {})) {
      const generatedSupport = [
        ...(binding.outputs || []),
        ...(binding.projections || []),
        ...(binding.memberOutputs || []),
        ...(binding.memberProjections || []),
      ].filter((item) => item.role === 'generated-support');
      if (generatedSupport.length === 0) continue;
      const maintainers = refreshOperations.filter((operation) => (
        operation.kind === 'projection-refresh'
        && operation.stage === stageId
        && operation.artifact === artifactId
        && generatedSupport.some((item) => item.role === operation.outputRole)
      ));
      let valid = maintainers.length === 1;
      const operation = maintainers[0];
      if (operation) {
        const registry = (manifest.artifactRegistry || []).find((item) => item.id === artifactId);
        const domain = (manifest.domainRegistry || []).find((item) => item.id === registry?.domain);
        const generatedSupportOperation = operation.outputRole === 'generated-support';
        const projectionName = artifactId.endsWith('-prototype')
          ? artifactId.slice(0, -'-prototype'.length)
          : artifactId;
        const expectedId = 'refresh-' + projectionName + '-projections';
        const expectedScript = 'refresh:' + projectionName + '-projections';
        const expectedExecutor = [domain?.root, artifactId, 'scripts/refresh-projections.mjs'].filter(Boolean).join('/');
        const expectedArgs = ['--operation', operation.id, '--json'];
        valid = valid
          && operation.run === 'npm run ' + operation.npmScript
          && Boolean(packageJson.scripts?.[operation.npmScript])
          && operation.executor?.kind === 'module'
          && (!generatedSupportOperation || (
            operation.id === expectedId
            && operation.npmScript === expectedScript
            && operation.executor.path === expectedExecutor
            && JSON.stringify(operation.executor.args || []) === JSON.stringify(expectedArgs)
          ));
        try {
          const executor = await readFile(resolve(root, 'templates/workspace', operation.executor.path), 'utf8');
          valid = valid
            && executor.includes('commitManagedWrites')
            && executor.includes('AIH_STAGE_LOCKED')
            && executor.includes('--dry-run');
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        diagnostics.push(diagnostic(
          PROJECTION_BLOCKER,
          'generated-support 缺少 active 可达、published 锁定的确定性刷新入口：' + stageId + '/' + artifactId,
          'templates/workspace/.psp/harness/harness.manifest.json',
        ));
      }
      dependencies.push({
        id: 'projection-liveness-' + artifactId,
        from: stageId + '/' + artifactId,
        to: operation?.executor?.path || 'missing-projection-refresh',
        status: valid ? 'PASS' : 'BLOCKED',
      });
    }
  }
  if (!dispatch.includes('loaded.manifest.operations') || !dispatch.includes('executor.args')) {
    diagnostics.push(diagnostic(
      PROJECTION_BLOCKER,
      '打包运行时没有闭合 Manifest operation 与 executor args 分发。',
      'runtime/dispatch.mjs',
    ));
  }
  return {
    diagnostics,
    dependencies,
    selected: ['workspace-handoff-liveness', 'workspace-projection-liveness'],
  };
}

async function validateReport(root, report) {
  const schema = await readJson(resolve(root, '.psp/harness/schemas/consistency-report.schema.json'));
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (validate(report)) return report;
  const details = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
  throw Object.assign(new Error('Consistency Report 不符合登记 Schema：' + details), { code: 'AIH_SCHEMA_INVALID' });
}

export async function checkScaffoldConsistency(root) {
  const diagnostics = [];
  const [project, templateProject, manifest, templateManifest, packageJson, templatePackageJson, dispatch, standardContent] = await Promise.all([
    readFile(resolve(root, 'psp.project.yaml'), 'utf8').then(parseYaml),
    readFile(resolve(root, 'templates/workspace/psp.project.yaml'), 'utf8').then(parseYaml),
    readJson(resolve(root, '.psp/harness/harness.manifest.json')),
    readJson(resolve(root, 'templates/workspace/.psp/harness/harness.manifest.json')),
    readJson(resolve(root, 'package.json')),
    readJson(resolve(root, 'templates/workspace/package.json')),
    readFile(resolve(root, 'runtime/dispatch.mjs'), 'utf8'),
    readFile(resolve(root, '.psp/harness/HARNESS-BOUNDARY.md'), 'utf8'),
  ]);
  const facts = [
    ['root-project', project.kind === 'PSPScaffoldProject' && project.harness?.protocol === PROTOCOL, '根项目绑定不是 v3 Maintainer Harness。', 'psp.project.yaml'],
    ['root-manifest', manifest.standard?.protocol === PROTOCOL && manifest.standard?.profile === 'maintainer', '根 Manifest 未绑定 v3 Maintainer Profile。', '.psp/harness/harness.manifest.json'],
    ['template-project', templateProject.kind === 'PSPProject' && templateProject.harness?.protocol === PROTOCOL, '模板项目绑定不是 v3 User Harness。', 'templates/workspace/psp.project.yaml'],
    ['template-manifest', templateManifest.standard?.protocol === PROTOCOL && templateManifest.standard?.profile === 'user', '模板 Manifest 未绑定 v3 User Profile。', 'templates/workspace/.psp/harness/harness.manifest.json'],
    ['runtime-dispatch', [...dispatch.matchAll(/pre-sdd-harness\/v\d+/g)].every((match) => match[0] === PROTOCOL), '运行时分发器未仅支持 v3。', 'runtime/dispatch.mjs'],
    ['package-template', packageJson.files?.includes('templates/workspace/'), 'npm 包清单未包含工作区模板。', 'package.json'],
  ];
  for (const [id, pass, message, location] of facts) {
    if (!pass) diagnostics.push(diagnostic(PROJECTION_BLOCKER, message, location));
  }
  const structuralDependencies = facts.map(([id, pass, , location]) => ({
    id,
    from: location,
    to: id.includes('template') ? 'generated-workspace' : 'scaffold-package',
    status: pass ? 'PASS' : 'BLOCKED',
  }));
  const projections = await projectionAnalysis(root, manifest, standardContent);
  diagnostics.push(...projections.diagnostics);
  const liveness = await workspaceLivenessAnalysis(root, templateProject, templateManifest, templatePackageJson, dispatch);
  diagnostics.push(...liveness.diagnostics);
  const dependencies = [...structuralDependencies, ...projections.dependencies, ...liveness.dependencies];
  return validateReport(root, {
    protocol: PROTOCOL,
    status: diagnostics.length === 0 ? 'PASS' : 'BLOCKED',
    scope: { requested: ['scaffold-repository'], selected: [...facts.map(([id]) => id), ...projections.selected, ...liveness.selected] },
    dependencies,
    diagnostics,
    acceptedRisks: [],
    suggestedOperations: diagnostics.length === 0 ? [] : ['显式修改拥有该投影的模板、运行时或 Manifest，再重新执行 scaffold-consistency。'],
    changes: [],
    validation: dependencies.map((item) => ({ id: item.id, status: item.status })),
    residuals: diagnostics,
    sideEffects: { status: 'PASS', changedPaths: [] },
    handoff: 'NOT_RUN',
    publication: 'NOT_RUN',
  });
}

async function main() {
  const root = resolve(process.env.PSP_REPOSITORY_ROOT || process.cwd());
  let result;
  try {
    result = await checkScaffoldConsistency(root);
  } catch (error) {
    result = {
      protocol: PROTOCOL,
      status: 'BLOCKED',
      scope: { requested: ['scaffold-repository'], selected: [] },
      dependencies: [],
      diagnostics: [diagnostic(error.code || PROJECTION_BLOCKER, error.message, 'scaffold-consistency')],
      acceptedRisks: [],
      suggestedOperations: [],
      changes: [],
      validation: [],
      residuals: [],
      sideEffects: { status: 'NOT_RUN', changedPaths: [] },
      handoff: 'NOT_RUN',
      publication: 'NOT_RUN',
    };
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('[' + result.status + '] scaffold-consistency');
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
