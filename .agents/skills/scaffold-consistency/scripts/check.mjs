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

async function validateReport(root, report) {
  const schema = await readJson(resolve(root, '.psp/harness/schemas/consistency-report.schema.json'));
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (validate(report)) return report;
  const details = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
  throw Object.assign(new Error('Consistency Report 不符合登记 Schema：' + details), { code: 'AIH_SCHEMA_INVALID' });
}

export async function checkScaffoldConsistency(root) {
  const diagnostics = [];
  const [project, templateProject, manifest, templateManifest, packageJson, dispatch, standardContent] = await Promise.all([
    readFile(resolve(root, 'psp.project.yaml'), 'utf8').then(parseYaml),
    readFile(resolve(root, 'templates/workspace/psp.project.yaml'), 'utf8').then(parseYaml),
    readJson(resolve(root, '.psp/harness/harness.manifest.json')),
    readJson(resolve(root, 'templates/workspace/.psp/harness/harness.manifest.json')),
    readJson(resolve(root, 'package.json')),
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
  const dependencies = [...structuralDependencies, ...projections.dependencies];
  return validateReport(root, {
    protocol: PROTOCOL,
    status: diagnostics.length === 0 ? 'PASS' : 'BLOCKED',
    scope: { requested: ['scaffold-repository'], selected: [...facts.map(([id]) => id), ...projections.selected] },
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
