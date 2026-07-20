import { access, readFile, readdir, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import picomatch from 'picomatch';
import { parse as parseToml } from 'toml';
import { parse as parseYaml } from 'yaml';
import { resolveHarness, selectorPatterns } from './lib/routing.mjs';
import {
  artifactPaths,
  loadProjectAndManifest,
  normalizeRepositoryPath,
  readJson,
  repositoryFile,
  repositoryRootFrom,
} from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const json = process.argv.includes('--json');
const blockers = [];
const REQUIRED_CODES = [
  'AIH_PROJECT_BINDING_INVALID',
  'AIH_CONTRACT_INVALID',
  'AIH_ARTIFACT_SCHEMA_FAILED',
  'AIH_ARTIFACT_INCOMPLETE',
  'AIH_REFERENCE_UNRESOLVED',
  'AIH_GENERATED_DRIFT',
  'AIH_UPSTREAM_NOT_READY',
  'AIH_SCOPE_UNRESOLVED',
  'AIH_PATH_INVALID',
  'AIH_PATH_OUTSIDE_ROOT',
  'AIH_MANIFEST_UNREADABLE',
  'AIH_SCHEMA_INVALID',
  'AIH_ENTRYPOINT_MISSING',
  'AIH_COMMAND_INVALID',
  'AIH_PROFILE_INVALID',
  'AIH_SCOPE_INVALID',
  'AIH_CODEX_ADAPTER_INVALID',
  'AIH_HARNESS_COUPLED',
  'AIH_HOOK_DEGRADED',
  'AIH_RUNTIME_UNAVAILABLE',
  'AIH_RUNTIME_INCOMPATIBLE',
  'AIH_VALIDATION_FAILED',
  'AIH_ARTIFACT_TRANSACTION_FAILED',
  'AIH_USER_CHANGE_COLLISION',
  'AIH_WORKSPACE_NOT_EMPTY',
  'AIH_STAGE_UNINITIALIZED',
  'AIH_PARTIAL_INITIALIZATION',
  'AIH_STAGE_ALREADY_INITIALIZED',
  'AIH_DOMAIN_BOUNDARY_INVALID',
  'AIH_HANDOFF_EDGE_INVALID',
];

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

async function requirePath(path, location = path) {
  try {
    await access(repositoryFile(root, path));
  } catch (error) {
    const code = typeof error.code === 'string' && error.code.startsWith('AIH_')
      ? error.code
      : 'AIH_ENTRYPOINT_MISSING';
    block(code, '声明路径不存在：' + path, location);
  }
}

async function requireDirectory(path, location = path) {
  try {
    if (!(await stat(repositoryFile(root, path))).isDirectory()) {
      block('AIH_PROJECT_BINDING_INVALID', '声明的阶段根路径不是目录：' + path, location);
    }
  } catch (error) {
    const code = typeof error.code === 'string' && error.code.startsWith('AIH_')
      ? error.code
      : 'AIH_ENTRYPOINT_MISSING';
    block(code, '声明的阶段根目录不存在：' + path, location);
  }
}

function unique(items, label, code) {
  const values = new Map();
  for (const item of items || []) {
    if (values.has(item.id)) block(code, label + ' id 重复：' + item.id, item.id);
    else values.set(item.id, item);
  }
  return values;
}

function schemaErrors(validate, code, location) {
  for (const error of validate.errors || []) {
    block(code, (error.instancePath || '/') + ' ' + error.message, location + (error.instancePath || ''));
  }
}

async function allTextFiles(directory, prefix = '') {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    const absolute = repositoryFile(root, '.psp/harness/' + relative);
    if (entry.isDirectory()) output.push(...await allTextFiles(absolute, relative));
    else output.push('.psp/harness/' + relative);
  }
  return output;
}

let project;
let manifest;
try {
  ({ project, manifest } = await loadProjectAndManifest(root));
} catch (error) {
  block(error.code || 'AIH_PROJECT_BINDING_INVALID', error.message, 'psp.project.yaml');
}
let ajv;
let manifestValid = false;
let projectValid = false;
if (project && manifest) {
  try {
    ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const [manifestSchema, projectSchema, contractSchema] = await Promise.all([
      readJson(root, manifest.schemas.manifest),
      readJson(root, manifest.schemas.project),
      readJson(root, manifest.schemas.contract),
    ]);
    const validateManifest = ajv.compile(manifestSchema);
    manifestValid = validateManifest(manifest);
    if (!manifestValid) schemaErrors(validateManifest, 'AIH_SCHEMA_INVALID', manifest.entrypoints?.manifest || 'harness manifest');
    const validateProject = ajv.compile(projectSchema);
    projectValid = validateProject(project);
    if (!projectValid) schemaErrors(validateProject, 'AIH_PROJECT_BINDING_INVALID', 'psp.project.yaml');

    const validateContract = ajv.compile(contractSchema);
    for (const registry of manifest.artifactRegistry || []) {
      try {
        const contract = parseYaml(await readFile(repositoryFile(root, registry.contract), 'utf8'));
        if (!validateContract(contract)) schemaErrors(validateContract, 'AIH_CONTRACT_INVALID', registry.contract);
        if (
          contract?.metadata?.id !== registry.id
          || contract?.spec?.stage !== registry.stage
          || contract?.spec?.internalModelFormat !== registry.format
        ) {
          block('AIH_CONTRACT_INVALID', 'Contract identity 与 Artifact Registry 不一致。', registry.contract);
        }
        const binding = project?.stages?.[registry.stage]?.artifacts?.[registry.id];
        const declaredInputs = contract?.spec?.inputs?.artifacts || [];
        if (contract?.spec?.inputs && !binding?.inputRoot) {
          block('AIH_CONTRACT_INVALID', 'Contract 声明输入但项目 Artifact binding 缺少 inputRoot。', registry.contract);
        }
        if (!contract?.spec?.inputs && binding?.inputRoot) {
          block('AIH_CONTRACT_INVALID', '项目 Artifact binding 声明 inputRoot 但 Contract 未声明 inputs。', registry.contract);
        }
        for (const inputArtifact of declaredInputs) {
          if (!manifest.artifactRegistry.some((item) => item.id === inputArtifact)) {
            block('AIH_CONTRACT_INVALID', 'Contract inputs 引用未知 Artifact：' + inputArtifact, registry.contract);
          }
        }
        const boundOutputs = projectValid
          ? [...(binding?.projections || binding?.outputs || []), ...(binding?.memberOutputs || binding?.memberProjections || [])]
          : [];
        if (projectValid && !boundOutputs.some((output) => output.role === contract?.spec?.outputRole)) {
          block('AIH_CONTRACT_INVALID', 'Contract outputRole 与项目 Artifact binding 不一致。', registry.contract);
        }
        const registeredProjections = new Map((registry.projections || []).map((item) => [item.id, item]));
        const contractProjections = new Map((contract?.spec?.projections || []).map((item) => [item.id, item]));
        if (registry.renderer && registry.projections) {
          block('AIH_CONTRACT_INVALID', 'Artifact 只能声明 renderer 或 projections，不能同时声明。', registry.id);
        }
        if (registeredProjections.size !== (registry.projections || []).length || contractProjections.size !== (contract?.spec?.projections || []).length) {
          block('AIH_CONTRACT_INVALID', 'Projection id 必须唯一。', registry.contract);
        }
        if (registry.projections) {
          if (
            registeredProjections.size !== contractProjections.size
            || [...registeredProjections.keys()].some((id) => !contractProjections.has(id))
          ) {
            block('AIH_CONTRACT_INVALID', 'Manifest 与 Contract 的 projection 声明不一致。', registry.contract);
          }
          for (const output of boundOutputs) {
            const projection = contractProjections.get(output.projection);
            if (!projection) {
              block('AIH_PROJECT_BINDING_INVALID', 'Artifact output 未绑定已登记 projection：' + (output.projection || 'missing'), registry.id);
            } else if (projection.outputRole !== output.role) {
              block('AIH_CONTRACT_INVALID', 'Projection outputRole 与项目绑定不一致：' + output.projection, registry.contract);
            }
          }
          for (const projectionId of registeredProjections.keys()) {
            if (!boundOutputs.some((output) => output.projection === projectionId)) {
              block('AIH_PROJECT_BINDING_INVALID', '已登记 projection 缺少项目输出绑定：' + projectionId, registry.id);
            }
          }
        } else {
          if (contractProjections.size > 0) block('AIH_CONTRACT_INVALID', '单 renderer Artifact 不得声明多 projection Contract。', registry.contract);
          if (boundOutputs.some((output) => output.projection)) block('AIH_PROJECT_BINDING_INVALID', '单 renderer Artifact output 不得声明 projection。', registry.id);
        }
      } catch (error) {
        block('AIH_CONTRACT_INVALID', error.message, registry.contract);
      }
      try {
        const schema = await readJson(root, registry.schema);
        ajv.compile(schema);
      } catch (error) {
        block('AIH_SCHEMA_INVALID', 'Artifact Schema 无法编译：' + error.message, registry.schema);
      }
    }
  } catch (error) {
    block('AIH_SCHEMA_INVALID', 'Harness Schema 无法读取或编译：' + error.message, '.psp/harness/schemas');
  }
}

if (manifest && manifestValid) {
  const catalog = new Map();
  for (const item of manifest.blockers) {
    if (catalog.has(item.code)) block('AIH_CONTRACT_INVALID', 'blocker code 重复：' + item.code, item.code);
    else catalog.set(item.code, item);
  }
  for (const code of REQUIRED_CODES) {
    if (!catalog.has(code)) block('AIH_CONTRACT_INVALID', 'blocker catalog 缺少必需 code：' + code, 'blockers');
  }

  await Promise.all([
    ...Object.entries(manifest.entrypoints).map(([key, path]) => requirePath(path, 'entrypoints.' + key)),
    ...Object.entries(manifest.schemas).map(([key, path]) => requirePath(path, 'schemas.' + key)),
    ...manifest.readOrder.map((path, index) => requirePath(path, 'readOrder[' + index + ']')),
    requirePath(manifest.codex.projectConfig, 'codex.projectConfig'),
    requirePath(manifest.codex.hookConfig, 'codex.hookConfig'),
    ...manifest.codex.hookScripts.map((path) => requirePath(path, 'codex.hookScripts')),
    ...manifest.codex.repositorySkills.map((path) => requirePath(path, 'codex.repositorySkills')),
    ...manifest.domainRegistry.flatMap((item) => [item.root, ...(item.mirrors || [])].flatMap((path) => [
      requirePath(path, item.id),
      requirePath(path + '/SKILL.md', item.id + '.skill'),
      requirePath(path + '/agents/openai.yaml', item.id + '.skillMetadata'),
    ])),
    ...manifest.artifactRegistry.flatMap((item) => [item.contract, item.schema, item.template].filter(Boolean).map((path) => requirePath(path, item.id))),
    ...manifest.operations.flatMap((item) => Object.values(item.areaTemplates || {}).map((path) => requirePath(path, item.id))),
    ...[...manifest.commands, ...manifest.operations]
      .filter((item) => item.executor?.kind === 'module')
      .map((item) => requirePath(item.executor.path, item.id + '.executor.path')),
  ]);

  if (
    manifest.entrypoints.project !== 'psp.project.yaml'
    || manifest.entrypoints.manifest !== project?.harness?.manifest
    || manifest.readOrder.join('|') !== [
      manifest.entrypoints.instructions,
      manifest.entrypoints.protocol,
      manifest.entrypoints.boundary,
      manifest.entrypoints.project,
      manifest.entrypoints.manifest,
    ].join('|')
  ) {
    block('AIH_CONTRACT_INVALID', '入口或 readOrder 与项目绑定不一致。', 'readOrder');
  }

  const commands = unique(manifest.commands, 'command', 'AIH_COMMAND_INVALID');
  const operations = unique(manifest.operations, 'operation', 'AIH_COMMAND_INVALID');
  const profiles = unique(manifest.validationProfiles, 'profile', 'AIH_PROFILE_INVALID');
  const scopes = unique(manifest.scopes, 'scope', 'AIH_SCOPE_INVALID');
  let packageJson;
  try {
    packageJson = await readJson(root, 'package.json');
  } catch (error) {
    block('AIH_COMMAND_INVALID', error.message, 'package.json');
  }
  for (const command of commands.values()) {
    if (!packageJson?.scripts?.[command.npmScript]) {
      block('AIH_COMMAND_INVALID', 'package.json 未声明命令：' + command.npmScript, command.id);
    }
    if (command.run !== 'npm run ' + command.npmScript) {
      block('AIH_COMMAND_INVALID', '命令文本与 npm script 不一致：' + command.id, command.id);
    }
  }
  for (const operation of operations.values()) {
    if (!packageJson?.scripts?.[operation.npmScript]) {
      block('AIH_COMMAND_INVALID', 'package.json 未声明 operation：' + operation.npmScript, operation.id);
    }
    if (operation.run !== 'npm run ' + operation.npmScript) {
      block('AIH_COMMAND_INVALID', 'Operation 文本与 npm script 不一致：' + operation.id, operation.id);
    }
    if (operation.kind === 'workspace' || operation.kind === 'handoff') continue;
    const stage = project?.stages?.[operation.stage];
    if (!stage || !['uninitialized', 'active'].includes(stage.status)) {
      block('AIH_PROJECT_BINDING_INVALID', 'Operation 引用不可执行阶段：' + operation.stage, operation.id);
    }
    if (operation.kind === 'artifact') {
      for (const artifactId of operation.artifacts) {
        const registered = manifest.artifactRegistry.find((item) => item.id === artifactId);
        if (
          !registered
          || registered.stage !== operation.stage
          || registered.domain !== operation.domain
          || !['internal-model', 'internal-model-set'].includes(registered.authorityKind)
          || !stage?.artifacts?.[artifactId]
        ) {
          block('AIH_CONTRACT_INVALID', '产物 operation 引用无效 Artifact：' + artifactId, operation.id);
        }
      }
      continue;
    }
    if (operation.kind === 'repair') {
      const registered = manifest.artifactRegistry.find((item) => item.id === operation.artifact);
      if (
        !registered
        || registered.stage !== operation.stage
        || registered.domain !== operation.domain
        || !['area', 'area-set'].includes(registered.authorityKind)
        || !stage?.artifacts?.[operation.artifact]
      ) {
        block('AIH_CONTRACT_INVALID', '修复 operation 引用无效 Area Artifact：' + operation.artifact, operation.id);
      }
      continue;
    }
    if (operation.upstreamScopes && operation.upstreamHandoff) {
      block('AIH_CONTRACT_INVALID', '阶段初始化不能同时声明 upstreamScopes 与 upstreamHandoff。', operation.id);
    }
    const stageScope = [...scopes.values()].find((scope) =>
      scope.selector?.type === 'stage' && scope.selector.stage === operation.stage,
    );
    for (const scopeId of operation.upstreamScopes || []) {
      const upstream = scopes.get(scopeId);
      if (!upstream || upstream.status !== 'active') {
        block('AIH_SCOPE_INVALID', '阶段初始化引用未知或不可用的上游 Scope：' + scopeId, operation.id);
      } else if (!stageScope?.dependencies?.includes(scopeId)) {
        block('AIH_SCOPE_INVALID', '阶段 Scope 未声明初始化所需上游依赖：' + scopeId, operation.id);
      }
    }
    for (const [areaId, template] of Object.entries(operation.areaTemplates || {})) {
      if (!stage?.areas?.[areaId]) {
        block('AIH_PROJECT_BINDING_INVALID', 'Operation 引用未知 area：' + areaId, operation.id);
      }
      await requirePath(template, operation.id + '.areaTemplates.' + areaId);
    }
  }
  const workspaceOperations = [...operations.values()].filter((operation) => operation.kind === 'workspace');
  const workspaceScopes = [...scopes.values()].filter((scope) => scope.selector?.type === 'workspace');
  if (workspaceOperations.length !== 1) {
    block('AIH_CONTRACT_INVALID', 'Harness 必须声明且只声明一个 workspace operation。', 'operations');
  }
  if (workspaceScopes.length !== 1) {
    block('AIH_SCOPE_INVALID', 'Harness 必须声明且只声明一个 workspace Scope。', 'scopes');
  }
  for (const profile of profiles.values()) {
    if (!profile.commands.includes('harness')) {
      block('AIH_PROFILE_INVALID', 'Profile 缺少 Harness 自检：' + profile.id, profile.id);
    }
    for (const command of profile.commands) {
      if (!commands.has(command)) block('AIH_PROFILE_INVALID', 'Profile 引用未知命令：' + command, profile.id);
    }
  }
  for (const [name, capability] of Object.entries(manifest.capabilities || {})) {
    if (capability.status === 'available' && !packageJson?.scripts?.[capability.command]) {
      block('AIH_COMMAND_INVALID', 'Capability 与 package.json 漂移：' + name, 'capabilities.' + name);
    }
  }

  for (const scope of scopes.values()) {
    if (['domain', 'stage', 'artifact', 'subtree'].includes(scope.kind)) {
      if (!scope.domain || !manifest.domainRegistry.some((domain) => domain.id === scope.domain)) {
        block('AIH_DOMAIN_BOUNDARY_INVALID', '领域 Scope 必须引用已注册 Domain Skill：' + scope.id, scope.id);
      }
    }
    for (const pattern of selectorPatterns(scope.selector, project || { stages: {} }, manifest)) {
      const normalized = normalizeRepositoryPath(pattern, root, { allowGlob: true });
      if (normalized.error) block(normalized.error, normalized.message, scope.id);
      else {
        try {
          picomatch.makeRe(pattern);
        } catch (error) {
          block('AIH_PATH_INVALID', error.message, scope.id);
        }
      }
    }
    if (scope.selector.type === 'domain') {
      if (!manifest.domainRegistry.some((domain) => domain.id === scope.selector.domain)) {
        block('AIH_SCOPE_INVALID', 'Scope 引用未知 Domain Skill：' + scope.selector.domain, scope.id);
      }
    }
    if (['stage', 'area', 'artifact'].includes(scope.selector.type)) {
      const stage = project?.stages?.[scope.selector.stage];
      if (!stage) block('AIH_SCOPE_INVALID', 'Scope 引用未知阶段：' + scope.selector.stage, scope.id);
      if (scope.selector.type === 'area' && !stage?.areas?.[scope.selector.area]) {
        block('AIH_SCOPE_INVALID', 'Scope 引用未知 area：' + scope.selector.area, scope.id);
      }
      if (scope.selector.type === 'artifact') {
        for (const artifact of scope.selector.artifacts) {
          if (!stage?.artifacts?.[artifact]) block('AIH_SCOPE_INVALID', 'Scope 引用未知 artifact：' + artifact, scope.id);
        }
        for (const area of scope.selector.areas || []) {
          if (!stage?.areas?.[area]) block('AIH_SCOPE_INVALID', 'Scope 引用未知 area：' + area, scope.id);
        }
      }
    }
    if (scope.status === 'active') {
      if (!profiles.has(scope.defaultProfile) || !profiles.has(scope.readinessProfile)) {
        block('AIH_SCOPE_INVALID', 'Scope 引用未知 Profile：' + scope.id, scope.id);
      }
      if (scope.uninitializedProfile && !profiles.has(scope.uninitializedProfile)) {
        block('AIH_SCOPE_INVALID', 'Scope 引用未知 uninitialized Profile：' + scope.uninitializedProfile, scope.id);
      }
    } else if (!catalog.has(scope.blockerCode)) {
      block('AIH_SCOPE_INVALID', 'Unsupported Scope 引用未知 blocker：' + scope.blockerCode, scope.id);
    }
    for (const dependency of scope.dependencies || []) {
      if (!scopes.has(dependency)) block('AIH_SCOPE_INVALID', 'Scope 引用未知依赖：' + dependency, scope.id);
    }
    for (const consumerId of scope.handoffConsumers || []) {
      const consumer = scopes.get(consumerId);
      if (!consumer) {
        block('AIH_SCOPE_INVALID', 'Scope 引用未知 handoff consumer：' + consumerId, scope.id);
      } else if (!consumer.dependencies?.includes(scope.id)) {
        block('AIH_SCOPE_INVALID', 'Handoff consumer 未声明对应上游依赖：' + consumerId, scope.id);
      }
    }
  }

  const registry = unique(manifest.artifactRegistry, 'artifact', 'AIH_CONTRACT_INVALID');
  const domains = unique(manifest.domainRegistry, 'domain', 'AIH_DOMAIN_BOUNDARY_INVALID');
  for (const domain of domains.values()) {
    const expectedRoot = '.agents/skills/' + domain.skill;
    if (domain.root !== expectedRoot) {
      block('AIH_DOMAIN_BOUNDARY_INVALID', 'Domain 根目录必须是已登记的仓库 Skill：' + expectedRoot, domain.id);
    }
    if (!manifest.codex.repositorySkills.includes(domain.root + '/SKILL.md')) {
      block('AIH_CODEX_ADAPTER_INVALID', 'Domain Skill 未登记到 codex.repositorySkills：' + domain.skill, domain.id);
    }
    for (const mirror of domain.mirrors || []) {
      if (!mirror.endsWith('/.agents/skills/' + domain.skill)) {
        block('AIH_DOMAIN_BOUNDARY_INVALID', 'Domain Skill mirror 与 skill 名称不一致：' + mirror, domain.id);
      }
    }
  }
  for (const operation of manifest.operations.filter((item) => item.kind === 'artifact' || item.kind === 'repair')) {
    const domain = domains.get(operation.domain);
    if (!domain || operation.executor.kind !== 'module' || !operation.executor.path.startsWith(domain.root + '/')) {
      block('AIH_DOMAIN_BOUNDARY_INVALID', '领域 Operation 执行器越出已注册 Domain Skill：' + operation.id, operation.id);
    }
  }
  for (const item of manifest.artifactRegistry) {
    const domain = domains.get(item.domain);
    if (!domain) {
      block('AIH_DOMAIN_BOUNDARY_INVALID', 'Artifact 引用未知 Domain Skill：' + item.domain, item.id);
      continue;
    }
    for (const path of [item.contract, item.schema, item.template].filter(Boolean)) {
      if (!(path === domain.root || path.startsWith(domain.root + '/'))) {
        block('AIH_DOMAIN_BOUNDARY_INVALID', 'Artifact 垂直文件越出 Domain Skill 根目录：' + path, item.id);
      }
    }
  }
  for (const item of manifest.commands.filter((command) => command.domain)) {
    const domain = domains.get(item.domain);
    const ownedPaths = item.executor.kind === 'module'
      ? [item.executor.path]
      : item.executor.kind === 'node-test' ? item.executor.paths : [];
    if (!domain || ownedPaths.some((path) => !path.startsWith(domain.root + '/'))) {
      block('AIH_DOMAIN_BOUNDARY_INVALID', '领域命令越出已注册 Domain Skill：' + item.id, item.id);
    }
  }
  for (const item of manifest.blockers.filter((blocker) => blocker.domain)) {
    if (!domains.has(item.domain)) block('AIH_DOMAIN_BOUNDARY_INVALID', 'Blocker 引用未知 Domain Skill：' + item.code, item.code);
  }
  if (project && projectValid) {
    const occupied = new Map();
    for (const [stageId, stage] of Object.entries(project.stages)) {
      if (stage.status === 'unavailable') {
        if (!catalog.has(stage.blockerCode)) {
          block('AIH_PROJECT_BINDING_INVALID', 'Unavailable stage 引用未知 blocker：' + stage.blockerCode, stageId);
        }
        continue;
      }
      const requireUserFiles = stage.status === 'active';
      await requireDirectory(stage.root, 'stages.' + stageId + '.root');
      const expected = new Set([...registry.values()].filter((item) => item.stage === stageId).map((item) => item.id));
      const actual = new Set(Object.keys(stage.artifacts));
      if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
        block('AIH_PROJECT_BINDING_INVALID', '阶段 Artifact 绑定与 registry 不一致：' + stageId, stageId);
      }
      for (const [artifactId, binding] of Object.entries(stage.artifacts)) {
        const registered = registry.get(artifactId);
        if (!registered || registered.stage !== stageId) {
          block('AIH_PROJECT_BINDING_INVALID', 'Artifact 未注册到当前阶段：' + artifactId, stageId + '.artifacts.' + artifactId);
          continue;
        }
        const paths = artifactPaths(project, artifactId, stageId);
        for (const path of [paths.authorityPath, ...paths.outputPaths, ...(paths.inputRoot ? [paths.inputRoot] : [])]) {
          if (requireUserFiles) await requirePath(path, stageId + '.artifacts.' + artifactId);
          const owner = occupied.get(path);
          if (owner) block('AIH_PROJECT_BINDING_INVALID', '绑定路径重复：' + path + ' (' + owner + ', ' + artifactId + ')', path);
          else occupied.set(path, artifactId);
        }
      }
      for (const [areaId, area] of Object.entries(stage.areas || {})) {
        if (requireUserFiles) await requirePath(stage.root + '/' + area.root, stageId + '.areas.' + areaId);
      }
    }
  }

  try {
    const roots = Object.values(project?.stages || {}).map((stage) => stage.root);
    for (const path of await allTextFiles(repositoryFile(root, '.psp/harness'))) {
      const content = await readFile(repositoryFile(root, path), 'utf8');
      for (const userRoot of roots) {
        if (content.includes(userRoot)) {
          block('AIH_HARNESS_COUPLED', 'Harness 文件硬编码用户目录：' + userRoot, path);
        }
      }
    }
  } catch (error) {
    block('AIH_HARNESS_COUPLED', error.message, 'harness');
  }

  try {
    const config = parseToml(await readFile(repositoryFile(root, manifest.codex.projectConfig), 'utf8'));
    if (config?.features?.hooks !== true || Object.keys(config).some((key) => key !== 'features')) {
      block('AIH_CODEX_ADAPTER_INVALID', 'Codex config 只允许启用 features.hooks。', manifest.codex.projectConfig);
    }
    const hook = await readJson(root, manifest.codex.hookConfig);
    const handler = hook?.hooks?.SessionStart?.[0]?.hooks?.[0];
    if (
      Object.keys(hook?.hooks || {}).join('|') !== 'SessionStart'
      || hook.hooks.SessionStart.length !== 1
      || hook.hooks.SessionStart[0].hooks.length !== 1
      || !manifest.codex.hookScripts.every((path) => handler?.command?.includes(path) && handler?.commandWindows?.includes(path))
    ) {
      block('AIH_CODEX_ADAPTER_INVALID', 'Hook config 不是唯一的轻量 SessionStart 适配器。', manifest.codex.hookConfig);
    }
    for (const skillPath of manifest.codex.repositorySkills) {
      const content = await readFile(repositoryFile(root, skillPath), 'utf8');
      const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (!match) throw new Error('Skill 缺少 YAML frontmatter');
      const frontmatter = parseYaml(match[1]);
      const folder = skillPath.split('/').at(-2);
      if (frontmatter.name !== folder || content.includes('[TODO')) throw new Error('Skill name 与目录不一致或包含 TODO');
      const metadataPath = skillPath.replace(/SKILL\.md$/, 'agents/openai.yaml');
      const metadata = parseYaml(await readFile(repositoryFile(root, metadataPath), 'utf8'));
      if (!metadata?.interface?.default_prompt?.includes('$' + folder)) throw new Error('Skill default_prompt 未引用自身');
    }
  } catch (error) {
    block('AIH_CODEX_ADAPTER_INVALID', error.message, 'codex');
  }

  if (project && projectValid) {
    const selfChecks = [['AGENTS.md', 'change', 'READY']];
    const workspaceScope = manifest.scopes.find((scope) => scope.selector?.type === 'workspace');
    if (workspaceScope) {
      for (const stage of Object.values(project.stages)) {
        if (stage.status !== 'unavailable') {
          selfChecks.push([stage.root + '/' + workspaceScope.selector.marker, 'change', 'READY']);
        }
      }
    }
    for (const [stageId, stage] of Object.entries(project.stages)) {
      if (stage.status === 'active') {
        const firstId = Object.keys(stage.artifacts)[0];
        selfChecks.push([artifactPaths(project, firstId, stageId).authorityPath, 'change', 'READY']);
        for (const area of Object.values(stage.areas || {})) {
          selfChecks.push([stage.root + '/' + area.root, 'change', 'READY']);
        }
      } else if (stage.status === 'uninitialized') {
        const firstId = Object.keys(stage.artifacts)[0];
        const firstPath = artifactPaths(project, firstId, stageId).authorityPath;
        const stageScope = manifest.scopes.find((scope) =>
          scope.selector?.type === 'stage' && scope.selector.stage === stageId,
        );
        const hasUnreadyUpstream = (stageScope?.dependencies || []).some((dependencyId) => {
          const dependency = manifest.scopes.find((scope) => scope.id === dependencyId);
          const dependencyStage = ['static', 'workspace', 'domain'].includes(dependency?.selector?.type)
            ? null
            : dependency?.selector?.stage;
          return dependencyStage && dependencyStage !== stageId && project.stages?.[dependencyStage]?.status !== 'active';
        });
        selfChecks.push(hasUnreadyUpstream
          ? [firstPath, 'change', 'BLOCKED', 'AIH_UPSTREAM_NOT_READY']
          : [firstPath, 'change', 'READY']);
        selfChecks.push([firstPath, 'readiness', 'BLOCKED', 'AIH_STAGE_UNINITIALIZED']);
      } else {
        selfChecks.push([stage.root + '/README.md', 'change', 'BLOCKED', stage.blockerCode]);
      }
    }
    for (const [path, intent, status, code] of selfChecks) {
      const result = resolveHarness(manifest, project, [path], intent, root);
      if (result.status !== status || (code && !result.blockers.some((item) => item.code === code))) {
        block('AIH_SCOPE_INVALID', 'resolver self-check 失败：' + path, path);
      }
    }
  }
}

const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  blockerCount: blockers.length,
  blockers,
};

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Repository Harness 契约校验通过。');
else for (const item of blockers) console.error('[' + item.code + '] (' + (item.location || 'unknown') + ') ' + item.message);

if (result.status !== 'PASS') process.exitCode = 1;
