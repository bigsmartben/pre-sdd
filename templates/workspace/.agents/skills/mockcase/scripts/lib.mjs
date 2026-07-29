import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactCollectionMembers,
  artifactPaths,
  artifactDefinition,
  loadProject,
  readStructured,
  repositoryFile,
  repositoryRootFrom,
} from '../../../runtime/project.mjs';
import { extractCanonicalUi } from '../../product-design/canonical-ui-prototype/scripts/extract.mjs';

export const MODEL_VERSION = '2.0.0';
export const HOST_API_VERSION = 'psp.review-extension/v1';

export function sha256(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function stableJson(value, pretty = false) {
  return JSON.stringify(canonical(value), null, pretty ? 2 : undefined);
}

export function jsonText(value) {
  return stableJson(value, true) + '\n';
}

export function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function argument(name, argv = process.argv) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

export function argumentsFor(name, argv = process.argv) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) values.push(argv[index + 1]);
  }
  return [...new Set(values)].sort();
}

export function actorArgument(argv = process.argv) {
  const actor = argument('--actor', argv);
  if (!actor || !/^ACTOR-[0-9]{3}$/.test(actor)) fail('AIH_SCOPE_UNRESOLVED', '必须提供 --actor ACTOR-NNN。');
  return actor;
}

export function emptyMockData(actor) {
  return { schemaVersion: MODEL_VERSION, actor, fixtures: [], behaviors: [] };
}

export function emptyMockCases(actor) {
  return { schemaVersion: MODEL_VERSION, actor, cases: [] };
}

export function suiteManifest(actor, upstream, mockdata, mockcases) {
  return {
    schemaVersion: MODEL_VERSION,
    actor,
    inputLock: {
      capabilitiesDigest: upstream.capabilitiesDigest,
      canonicalUiDigest: upstream.canonicalUiDigest,
    },
    files: {
      'mockdata.json': sha256(jsonText(mockdata)),
      'mockcases.json': sha256(jsonText(mockcases)),
    },
  };
}

export function compositeDigest(suite, mockdata, mockcases) {
  return sha256(stableJson({ suite, mockdata, mockcases }));
}

export function suitePaths(paths, actor) {
  const root = `${paths.authorityRoot}/${actor}`;
  return {
    root,
    suite: `${root}/suite.json`,
    mockdata: `${root}/mockdata.json`,
    mockcases: `${root}/mockcases.json`,
    runtime: `${paths.memberOutputs.find((item) => item.role === 'runtime-projection')?.root}/${actor}/mockcase-runtime.json`,
  };
}

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function workspaceContext(actor, { allowMissingSuite = true } = {}) {
  const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
  const project = await loadProject(root);
  if (project.kind !== 'PSPProject') fail('AIH_PROJECT_BINDING_INVALID', 'MockCase 只能在生成工作区 PSPProject 中运行。');
  const stage = project.stages?.mockcase;
  const registry = artifactDefinition(project, 'mockcase-suite', 'mockcase');
  const paths = artifactPaths(project, 'mockcase-suite', 'mockcase');
  if (!stage || !registry || !paths || paths.authorityKind !== 'area-set') {
    fail('AIH_PROJECT_BINDING_INVALID', '项目未完整绑定 mockcase Stage 与 mockcase-suite。');
  }
  const capabilitiesPaths = artifactPaths(project, 'capabilities', 'product-design');
  const canonicalPaths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  if (!capabilitiesPaths || !canonicalPaths) fail('AIH_PROJECT_BINDING_INVALID', 'MockCase 缺少 Product Design 只读依赖。');
  let capabilitiesSource;
  let capabilities;
  try {
    capabilitiesSource = await readFile(repositoryFile(root, capabilitiesPaths.authorityPath), 'utf8');
    capabilities = await readStructured(root, capabilitiesPaths.authorityPath, 'yaml');
  } catch {
    fail('AIH_MOCKCASE_UPSTREAM_GAP', 'Use Cases 权威模型不存在或不可读。');
  }
  const canonicalMember = (await artifactCollectionMembers(root, canonicalPaths)).find((item) => item.actor === actor);
  if (!canonicalMember) fail('AIH_SCOPE_UNRESOLVED', 'Canonical UI Actor 不存在：' + actor);
  const canonicalSource = await readFile(repositoryFile(root, canonicalMember.authorityPath), 'utf8');
  const canonicalUi = await extractCanonicalUi(root, canonicalMember.authorityPath);
  const upstream = {
    capabilitiesDigest: sha256(capabilitiesSource),
    canonicalUiDigest: sha256(canonicalSource),
  };
  const files = suitePaths(paths, actor);
  const suiteExists = await exists(repositoryFile(root, files.suite));
  if (!suiteExists && !allowMissingSuite) fail('AIH_ARTIFACT_INCOMPLETE', 'MockCase Suite 不存在：' + actor);
  let mockdata = emptyMockData(actor);
  let mockcases = emptyMockCases(actor);
  let suite = suiteManifest(actor, upstream, mockdata, mockcases);
  if (suiteExists) {
    try {
      [suite, mockdata, mockcases] = await Promise.all([
        readStructured(root, files.suite, 'json'),
        readStructured(root, files.mockdata, 'json'),
        readStructured(root, files.mockcases, 'json'),
      ]);
    } catch {
      fail('AIH_ARTIFACT_INCOMPLETE', 'MockCase Suite 三个权威 JSON 必须同时存在且可读：' + actor);
    }
  }
  return {
    root,
    project,
    stage,
    registry,
    paths,
    files,
    actor,
    capabilities,
    canonicalUi,
    upstream,
    suite,
    mockdata,
    mockcases,
    suiteExists,
    suiteDigest: compositeDigest(suite, mockdata, mockcases),
  };
}

export async function compileSchemas(root) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const load = async (name) => JSON.parse(await readFile(repositoryFile(root, `.agents/skills/mockcase/${name}.schema.json`), 'utf8'));
  const mockdata = await load('mockdata');
  const mockcases = await load('mockcases');
  ajv.addSchema(mockdata);
  ajv.addSchema(mockcases);
  return {
    ajv,
    suite: ajv.compile(await load('suite')),
    mockdata: ajv.getSchema('mockdata.schema.json'),
    mockcases: ajv.getSchema('mockcases.schema.json'),
    packet: ajv.compile(await load('mockdata-packet')),
    candidate: ajv.compile(await load('candidate')),
    runtime: ajv.compile(await load('runtime')),
    evidence: ajv.compile(await load('evidence')),
  };
}

function schemaFailure(validate, name) {
  const detail = (validate.errors || []).map((item) => `${item.instancePath || '/'} ${item.message}`).join('; ');
  fail('AIH_ARTIFACT_SCHEMA_FAILED', `${name} Schema 校验失败：${detail}`);
}

function valueAtPointer(value, pointer) {
  if (pointer === '') return value;
  let current = value;
  for (const token of pointer.slice(1).split('/').map((item) => item.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (
      current === null
      || typeof current !== 'object'
      || !Object.prototype.hasOwnProperty.call(current, token)
    ) fail('AIH_MOCKCASE_PROPERTY_INVALID', 'Fixture sourcePointer 不存在：' + pointer);
    current = current[token];
  }
  return current;
}

function propertyAccepts(property, value) {
  if (property.type === 'string') return typeof value === 'string';
  if (property.type === 'boolean') return typeof value === 'boolean';
  if (property.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return property.type === 'object' && value !== null && typeof value === 'object';
}

function stateIdsFor(model, matrix) {
  return model.stateAxes.filter((axis) => axis.componentContractId === matrix.componentContractId).flatMap((axis) => {
    const selected = axis.values.find((item) => item.id === matrix.values[axis.id]);
    return selected?.stateId ? [selected.stateId] : [];
  }).sort();
}

function propertyForBinding(contract, binding) {
  if (binding.kind === 'component-state' || binding.kind === 'lit-property') {
    return contract.properties.find((item) => item.name === binding.name);
  }
  if (binding.kind === 'lit-attribute') {
    const attribute = contract.attributes.find((item) => item.name === binding.name);
    return contract.properties.find((item) => item.name === attribute?.propertyName);
  }
  return null;
}

function addAssignment(assignments, property, value, source) {
  if (!property) fail('AIH_MOCKCASE_PROPERTY_INVALID', '投影目标不是 Component Contract 声明的公开 Lit Property。');
  if (!propertyAccepts(property, value)) {
    fail('AIH_MOCKCASE_PROPERTY_INVALID', `投影值类型不匹配：${property.name} / ${property.type}`);
  }
  const previous = assignments.get(property.name);
  if (previous && stableJson(previous.value) !== stableJson(value)) {
    fail('AIH_MOCKCASE_PROJECTION_CONFLICT', '同一公开属性收到冲突投影：' + property.name);
  }
  if (previous) {
    if (!previous.sources.some((item) => stableJson(item) === stableJson(source))) previous.sources.push(source);
    return;
  }
  assignments.set(property.name, { propertyName: property.name, value, sources: [source] });
}

export function compileProjectionEffect(context, effect) {
  const matrix = context.canonicalUi.stateMatrix.find((item) =>
    item.id === effect.stateMatrixEntryId && item.classification === 'legal');
  if (!matrix) fail('AIH_MOCKCASE_TARGET_MISSING', 'Effect 引用的合法 State Matrix Entry 不存在：' + effect.stateMatrixEntryId);
  const contract = context.canonicalUi.componentContracts.find((item) =>
    item.id === matrix.componentContractId
    && item.pageInstances.some((instance) => instance.id === effect.targetInstanceId));
  if (!contract) fail('AIH_MOCKCASE_TARGET_MISSING', 'Effect 目标实例不属于 State Matrix 的 Component Contract：' + effect.targetInstanceId);

  const assignments = new Map();
  const mapping = context.canonicalUi.componentMappings.find((item) => item.id === contract.mappingId);
  for (const axis of context.canonicalUi.stateAxes.filter((item) => item.componentContractId === contract.id)) {
    const selected = axis.values.find((item) => item.id === matrix.values[axis.id]);
    if (!selected) fail('AIH_MOCKCASE_CONTRACT_INVALID', 'State Matrix 缺少轴值：' + matrix.id + ' / ' + axis.id);
    const source = { kind: 'state-matrix', axisId: axis.id, valueId: selected.id };
    if (axis.renderBinding.kind === 'workflow-state') continue;
    if (axis.renderBinding.kind === 'slot-text') {
      if (selected.value === 'default') continue;
      fail('AIH_MOCKCASE_PROJECTION_UNSUPPORTED', '当前页 MockCase 不允许通过 Slot 修改正式 DOM：' + axis.id);
    }
    if (axis.renderBinding.kind === 'mapped-variant') {
      const propertyMapping = mapping?.propertyMappings.find((item) =>
        item.kind === 'variant' && item.figmaProperty === axis.name);
      const mapped = propertyMapping?.values.find((item) => item.figmaValue === selected.value);
      const attribute = contract.attributes.find((item) => item.name === propertyMapping?.litAttribute);
      const propertyName = propertyMapping?.litProperty ?? attribute?.propertyName;
      const property = contract.properties.find((item) => item.name === propertyName);
      if (!propertyMapping || !mapped || !property) {
        fail('AIH_MOCKCASE_PROJECTION_UNSUPPORTED', 'Variant 无法解析为公开 Lit Property：' + axis.id);
      }
      let value = mapped.litValue;
      if (property.type === 'boolean') value = value === '' || value === 'true';
      if (property.type === 'number') value = Number(value);
      if (property.type === 'object') {
        try {
          value = JSON.parse(value);
        } catch {
          fail('AIH_MOCKCASE_PROPERTY_INVALID', 'Variant Object Property 不是合法 JSON：' + property.name);
        }
      }
      addAssignment(assignments, property, value, source);
      continue;
    }
    addAssignment(assignments, propertyForBinding(contract, axis.renderBinding), selected.renderValue, source);
  }

  for (const binding of effect.dataBindings) {
    const behavior = context.mockdata.behaviors.find((item) => item.id === binding.behaviorId);
    const fixture = context.mockdata.fixtures.find((item) => item.id === behavior?.response.fixtureId);
    if (!behavior || !fixture) fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Data Binding 引用不存在的 Behavior 或 Fixture：' + binding.behaviorId);
    const property = contract.properties.find((item) => item.name === binding.propertyName);
    addAssignment(assignments, property, valueAtPointer(fixture.payload, binding.sourcePointer), {
      kind: 'fixture',
      behaviorId: behavior.id,
      fixtureId: fixture.id,
      sourcePointer: binding.sourcePointer,
    });
  }

  return {
    targetInstanceId: effect.targetInstanceId,
    componentContractId: contract.id,
    stateMatrixEntryId: matrix.id,
    behaviorIds: [...effect.behaviorIds].sort(),
    activation: effect.activation,
    assignments: [...assignments.values()]
      .map((item) => ({ ...item, sources: item.sources.sort((left, right) => stableJson(left).localeCompare(stableJson(right))) }))
      .sort((left, right) => left.propertyName.localeCompare(right.propertyName)),
    expectedStateIds: stateIdsFor(context.canonicalUi, matrix),
  };
}

export function coverageFor(context, cases = context.mockcases.cases, scenarioIds = null) {
  const requiredScenarioIds = (scenarioIds ?? context.canonicalUi.scenarios.map((item) => item.id)).slice().sort();
  const coveredScenarioIds = requiredScenarioIds.filter((id) =>
    cases.filter((item) => item.kind === 'business' && item.scenarioId === id).length === 1);
  return {
    requiredScenarioIds,
    coveredScenarioIds,
    missingScenarioIds: requiredScenarioIds.filter((id) => !coveredScenarioIds.includes(id)),
  };
}

export async function validateSuiteData(
  context,
  {
    requireCurrentInputs = true,
    requireCurrentReferences = true,
    requireCoverage = false,
  } = {},
) {
  const schemas = await compileSchemas(context.root);
  if (!schemas.suite(context.suite)) schemaFailure(schemas.suite, 'suite.json');
  if (!schemas.mockdata(context.mockdata)) schemaFailure(schemas.mockdata, 'mockdata.json');
  if (!schemas.mockcases(context.mockcases)) schemaFailure(schemas.mockcases, 'mockcases.json');
  if (context.suite.actor !== context.actor || context.mockdata.actor !== context.actor || context.mockcases.actor !== context.actor) {
    fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Suite 三个文件必须属于同一 Actor。');
  }
  if (
    context.suite.files['mockdata.json'] !== sha256(jsonText(context.mockdata))
    || context.suite.files['mockcases.json'] !== sha256(jsonText(context.mockcases))
  ) fail('AIH_MOCKCASE_CANDIDATE_STALE', 'suite.json 文件摘要与权威 JSON 不匹配。');
  if (requireCurrentInputs && (
    context.suite.inputLock.capabilitiesDigest !== context.upstream.capabilitiesDigest
    || context.suite.inputLock.canonicalUiDigest !== context.upstream.canonicalUiDigest
  )) fail('AIH_MOCKCASE_CANDIDATE_STALE', 'MockCase Suite 的 Product 输入锁已漂移。');

  const fixtureIds = new Set();
  for (const fixture of context.mockdata.fixtures) {
    if (fixtureIds.has(fixture.id)) fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Fixture ID 重复：' + fixture.id);
    fixtureIds.add(fixture.id);
  }
  const behaviorIds = new Set();
  for (const behavior of context.mockdata.behaviors) {
    if (behaviorIds.has(behavior.id)) fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Behavior ID 重复：' + behavior.id);
    behaviorIds.add(behavior.id);
    if (!fixtureIds.has(behavior.response.fixtureId)) {
      fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Behavior 引用不存在 Fixture：' + behavior.id);
    }
  }
  for (const fixtureId of fixtureIds) {
    if (!context.mockdata.behaviors.some((item) => item.response.fixtureId === fixtureId)) {
      fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Fixture 未被任何 Behavior 使用：' + fixtureId);
    }
  }
  const caseIds = new Set();
  const scenarioIds = new Set();
  for (const item of context.mockcases.cases) {
    if (caseIds.has(item.id)) fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Case ID 重复：' + item.id);
    caseIds.add(item.id);
    if (item.kind === 'business') scenarioIds.add(item.scenarioId);
    for (const effect of item.effects) {
      if (
        effect.dataBindings.some((binding) => !behaviorIds.has(binding.behaviorId))
        || effect.behaviorIds.some((behaviorId) => !behaviorIds.has(behaviorId))
      ) {
        fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Effect Data Binding 引用不存在 Behavior：' + item.id);
      }
      if (effect.dataBindings.some((binding) => !effect.behaviorIds.includes(binding.behaviorId))) {
        fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Data Binding 的 Behavior 必须由同一 Effect 激活：' + item.id);
      }
      if (requireCurrentReferences) {
        const route = context.canonicalUi.routes.find((entry) => entry.id === item.routeId);
        const scenario = item.scenarioId && context.canonicalUi.scenarios.find((entry) => entry.id === item.scenarioId);
        if (!route || (item.kind === 'business' && (!scenario || scenario.routeId !== route.id))) {
          fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Case 的 Route 或 Scenario 引用无效：' + item.id);
        }
        const screen = context.canonicalUi.screens.find((entry) => entry.id === route.screenId);
        const contract = context.canonicalUi.componentContracts.find((entry) =>
          entry.pageInstances.some((instance) => instance.id === effect.targetInstanceId && instance.screenId === screen?.id));
        const matrix = context.canonicalUi.stateMatrix.find((entry) =>
          entry.id === effect.stateMatrixEntryId && entry.classification === 'legal');
        if (!contract || !matrix || matrix.componentContractId !== contract.id) {
          fail('AIH_MOCKCASE_TARGET_MISSING', 'Effect 目标实例或 State Matrix 引用无效：' + item.id);
        }
        if (
          effect.activation.controlId
          && !context.canonicalUi.controls.some((control) =>
            control.id === effect.activation.controlId && control.componentId === contract.componentId)
        ) {
          fail('AIH_MOCKCASE_TARGET_MISSING', 'Activation Control 不属于目标组件：' + effect.activation.controlId);
        }
        compileProjectionEffect(context, effect);
      }
    }
  }
  for (const behaviorId of behaviorIds) {
    if (!context.mockcases.cases.some((item) =>
      item.effects.some((effect) => effect.behaviorIds.includes(behaviorId)))) {
      fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Behavior 未被任何 Case 使用：' + behaviorId);
    }
  }
  const routesWithCases = new Set(context.mockcases.cases.map((item) => item.routeId));
  for (const routeId of routesWithCases) {
    if (context.mockcases.cases.filter((item) => item.routeId === routeId && item.isDefault).length !== 1) {
      fail('AIH_MOCKCASE_COVERAGE_FAILED', '每个含 Case 的 Route 必须恰好有一个 Default Case：' + routeId);
    }
  }
  const coverage = coverageFor(context);
  if (requireCurrentReferences) {
    const requiredScenarioIds = new Set(coverage.requiredScenarioIds);
    const unexpected = [...scenarioIds].filter((id) => !requiredScenarioIds.has(id));
    if (unexpected.length > 0) {
      fail(
        'AIH_MOCKCASE_COVERAGE_FAILED',
        `MockCase 包含非当前 Canonical UI Scenario：unexpected=${unexpected.join(',')}`,
      );
    }
  }
  if (requireCoverage && coverage.missingScenarioIds.length > 0) {
    fail(
      'AIH_MOCKCASE_COVERAGE_INCOMPLETE',
      'MockCase 全局覆盖不完整：missing=' + coverage.missingScenarioIds.join(','),
    );
  }
  return { schemas, scenarioIds, coverage };
}

function requestedScope(argv = process.argv) {
  return {
    routeIds: argumentsFor('--route', argv),
    useCaseIds: argumentsFor('--use-case', argv),
    scenarioIds: argumentsFor('--scenario', argv),
  };
}

function scopeScenarios(context, scope) {
  const routes = new Set(scope.routeIds);
  const useCases = new Set(scope.useCaseIds);
  const scenarios = new Set(scope.scenarioIds);
  for (const id of routes) if (!context.canonicalUi.routes.some((item) => item.id === id)) fail('AIH_SCOPE_UNRESOLVED', '未知 Route：' + id);
  for (const id of scenarios) if (!context.canonicalUi.scenarios.some((item) => item.id === id)) fail('AIH_SCOPE_UNRESOLVED', '未知 Scenario：' + id);
  const actorUseCases = (context.capabilities.useCases || []).filter((item) => item.actor === context.actor && item.uiApplicability?.mode === 'required');
  for (const id of useCases) if (!actorUseCases.some((item) => item.id === id)) fail('AIH_SCOPE_UNRESOLVED', '未知或非 UI Use Case：' + id);
  return context.canonicalUi.scenarios.filter((item) => (
    (routes.size === 0 || routes.has(item.routeId))
    && (useCases.size === 0 || useCases.has(item.useCaseId))
    && (scenarios.size === 0 || scenarios.has(item.id))
  )).sort((a, b) => a.id.localeCompare(b.id));
}

function entryStateIds(model, entry) {
  return model.stateAxes.filter((axis) => axis.componentContractId === entry.componentContractId).flatMap((axis) => {
    const value = axis.values.find((candidate) => candidate.id === entry.values[axis.id]);
    return value?.stateId ? [value.stateId] : [];
  });
}

function generateCase(context, scenario, binding) {
  const route = context.canonicalUi.routes.find((item) => item.id === scenario.routeId);
  const screen = context.canonicalUi.screens.find((item) => item.id === route?.screenId);
  const desiredStateIds = [...new Set(
    scenario.recoveryStateIds?.length > 0
      ? scenario.recoveryStateIds
      : scenario.expectedStateIds || [],
  )];
  const matchingMatrices = context.canonicalUi.stateMatrix.filter((item) => {
    if (item.classification !== 'legal') return false;
    const contract = context.canonicalUi.componentContracts.find((candidate) =>
      candidate.id === item.componentContractId && screen?.componentIds.includes(candidate.componentId));
    if (!contract) return false;
    const states = new Set(entryStateIds(context.canonicalUi, item));
    return desiredStateIds.every((id) => states.has(id));
  }).sort((left, right) => left.id.localeCompare(right.id));
  const matrix = binding?.stateMatrixEntryId
    ? matchingMatrices.find((item) => item.id === binding.stateMatrixEntryId)
    : matchingMatrices.length === 1 ? matchingMatrices[0] : null;
  if (!matrix) {
    const detail = binding?.stateMatrixEntryId
      ? `显式 State Matrix Entry 无效：${binding.stateMatrixEntryId}`
      : `合法 State Matrix Entry 匹配数量必须为 1，实际为 ${matchingMatrices.length}`;
    return { gap: `Scenario 无法形成唯一公开属性投影：${scenario.id}；${detail}` };
  }
  const contract = matrix && context.canonicalUi.componentContracts.find((item) =>
    item.id === matrix.componentContractId && screen?.componentIds.includes(item.componentId));
  const instance = contract?.pageInstances.filter((item) => item.screenId === screen?.id).sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!route || !screen || !contract || !instance) return { gap: `Scenario 缺少合法 Route 或组件实例：${scenario.id}` };
  const id = `MOCK-CASE-${scenario.id}`;
  return {
    item: {
      id,
      kind: 'business',
      label: `${scenario.useCaseId} · ${scenario.id}`,
      routeId: scenario.routeId,
      scenarioId: scenario.id,
      effects: [{
        targetInstanceId: instance.id,
        stateMatrixEntryId: matrix.id,
        dataBindings: binding?.dataBindings ?? [],
        behaviorIds: [...new Set((binding?.dataBindings ?? []).map((item) => item.behaviorId))].sort(),
        activation: binding?.activation ?? { kind: 'request' },
      }],
      isDefault: false,
    },
  };
}

async function seedPacket(context, path) {
  if (!path) return { fixtures: [], behaviors: [], bindings: [] };
  let packet;
  try {
    packet = JSON.parse(await readFile(resolve(process.cwd(), path), 'utf8'));
  } catch (error) {
    fail('AIH_ARTIFACT_SCHEMA_FAILED', '显式 MockData Packet 无法读取：' + error.message);
  }
  const schemas = await compileSchemas(context.root);
  if (!schemas.packet(packet)) schemaFailure(schemas.packet, 'MockData Input Packet');
  const candidateData = {
    schemaVersion: MODEL_VERSION,
    actor: context.actor,
    fixtures: packet.fixtures || [],
    behaviors: packet.behaviors || [],
  };
  if (!schemas.mockdata(candidateData)) schemaFailure(schemas.mockdata, 'MockData Packet');
  return { ...candidateData, bindings: packet.bindings || [] };
}

export async function buildCandidate(actor, { argv = process.argv, scope = null, seedPath = null } = {}) {
  const context = await workspaceContext(actor);
  await validateSuiteData(context, {
    requireCurrentInputs: false,
    requireCurrentReferences: false,
    requireCoverage: false,
  });
  const selectedScope = scope || requestedScope(argv);
  const scenarios = scopeScenarios(context, selectedScope);
  const seed = await seedPacket(context, seedPath ?? argument('--mockdata', argv));
  const bindings = new Map(seed.bindings.map((item) => [item.scenarioId, {
    ...(item.stateMatrixEntryId ? { stateMatrixEntryId: item.stateMatrixEntryId } : {}),
    ...(item.activation ? { activation: item.activation } : {}),
    dataBindings: [...item.dataBindings].sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
  }]));
  if (bindings.size !== seed.bindings.length) fail('AIH_MOCKCASE_CONTRACT_INVALID', 'MockData Packet 的 Scenario Binding 必须唯一。');
  const availableBehaviorIds = new Set([...context.mockdata.behaviors, ...seed.behaviors].map((item) => item.id));
  const existingBusiness = context.mockcases.cases
    .filter((item) => item.kind === 'business')
    .sort((a, b) => a.id.localeCompare(b.id));
  const existingByScenario = new Map();
  for (const item of existingBusiness) {
    if (!existingByScenario.has(item.scenarioId)) existingByScenario.set(item.scenarioId, item);
  }
  for (const scenario of scenarios) {
    if (bindings.has(scenario.id)) continue;
    const existing = existingByScenario.get(scenario.id);
    if (!existing) continue;
    bindings.set(scenario.id, {
      stateMatrixEntryId: existing.effects[0]?.stateMatrixEntryId,
      activation: existing.effects[0]?.activation,
      dataBindings: existing.effects.flatMap((effect) => effect.dataBindings)
        .sort((left, right) => stableJson(left).localeCompare(stableJson(right))),
    });
  }
  for (const [scenarioId, binding] of bindings) {
    if (binding.dataBindings.some((item) => !availableBehaviorIds.has(item.behaviorId))) {
      fail('AIH_MOCKCASE_CONTRACT_INVALID', 'Scenario Binding 引用不存在 Behavior：' + scenarioId);
    }
  }
  const generated = [];
  const gaps = [];
  for (const scenario of scenarios) {
    const result = generateCase(context, scenario, bindings.get(scenario.id));
    if (result.gap) gaps.push({
      code: 'AIH_MOCKCASE_UPSTREAM_GAP',
      message: result.gap,
      scenarioId: scenario.id,
      targetDomain: 'product-design',
      targetArtifact: 'capabilities',
      targetOperation: 'apply-product-artifact',
    });
    else {
      const existing = existingByScenario.get(scenario.id);
      generated.push({
        ...result.item,
        id: existing?.id ?? result.item.id,
        isDefault: existing?.isDefault ?? false,
      });
    }
  }
  const selectedScenarioIds = new Set(scenarios.map((item) => item.id));
  const explicitScope = Object.values(selectedScope).some((ids) => ids.length > 0);
  const currentScenarioIds = new Set(context.canonicalUi.scenarios.map((item) => item.id));
  const currentRouteIds = new Set(context.canonicalUi.routes.map((item) => item.id));
  const removeCaseIds = new Set();
  for (const item of context.mockcases.cases) {
    if (!explicitScope && !currentRouteIds.has(item.routeId)) {
      removeCaseIds.add(item.id);
      continue;
    }
    if (item.kind !== 'business') continue;
    if (!explicitScope && !currentScenarioIds.has(item.scenarioId)) {
      removeCaseIds.add(item.id);
      continue;
    }
    if (selectedScenarioIds.has(item.scenarioId) && existingByScenario.get(item.scenarioId)?.id !== item.id) {
      removeCaseIds.add(item.id);
    }
  }
  const byId = new Map(context.mockcases.cases
    .filter((item) => !removeCaseIds.has(item.id))
    .map((item) => [item.id, item]));
  for (const item of generated) byId.set(item.id, item);
  const proposedCases = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  const casesByRoute = new Map();
  for (const item of proposedCases) {
    if (!casesByRoute.has(item.routeId)) casesByRoute.set(item.routeId, []);
    casesByRoute.get(item.routeId).push(item);
  }
  const normalizedCases = [];
  for (const items of casesByRoute.values()) {
    const ordered = items.sort((a, b) => a.id.localeCompare(b.id));
    const selectedDefault = ordered.filter((item) => item.isDefault)[0] ?? ordered[0];
    normalizedCases.push(...ordered.map((item) => ({
      ...item,
      isDefault: item.id === selectedDefault.id,
    })));
  }
  normalizedCases.sort((a, b) => a.id.localeCompare(b.id));

  const currentCasesById = new Map(context.mockcases.cases.map((item) => [item.id, item]));
  const nextCaseIds = new Set(normalizedCases.map((item) => item.id));
  const caseUpserts = normalizedCases.filter((item) =>
    !currentCasesById.has(item.id) || stableJson(currentCasesById.get(item.id)) !== stableJson(item));
  const caseRemovals = context.mockcases.cases
    .filter((item) => !nextCaseIds.has(item.id))
    .map((item) => item.id)
    .sort();

  const nextBehaviorsById = new Map(context.mockdata.behaviors.map((item) => [item.id, item]));
  for (const item of seed.behaviors) nextBehaviorsById.set(item.id, item);
  const referencedBehaviorIds = new Set(normalizedCases.flatMap((item) =>
    item.effects.flatMap((effect) => effect.behaviorIds)));
  for (const id of nextBehaviorsById.keys()) {
    if (!referencedBehaviorIds.has(id)) nextBehaviorsById.delete(id);
  }
  const nextBehaviors = [...nextBehaviorsById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const nextFixturesById = new Map(context.mockdata.fixtures.map((item) => [item.id, item]));
  for (const item of seed.fixtures) nextFixturesById.set(item.id, item);
  const referencedFixtureIds = new Set(nextBehaviors.map((item) => item.response.fixtureId));
  for (const id of nextFixturesById.keys()) {
    if (!referencedFixtureIds.has(id)) nextFixturesById.delete(id);
  }
  const nextFixtures = [...nextFixturesById.values()].sort((a, b) => a.id.localeCompare(b.id));
  const currentBehaviorsById = new Map(context.mockdata.behaviors.map((item) => [item.id, item]));
  const currentFixturesById = new Map(context.mockdata.fixtures.map((item) => [item.id, item]));
  const behaviorUpserts = nextBehaviors.filter((item) =>
    !currentBehaviorsById.has(item.id) || stableJson(currentBehaviorsById.get(item.id)) !== stableJson(item));
  const fixtureUpserts = nextFixtures.filter((item) =>
    !currentFixturesById.has(item.id) || stableJson(currentFixturesById.get(item.id)) !== stableJson(item));
  const behaviorRemovals = context.mockdata.behaviors
    .filter((item) => !nextBehaviorsById.has(item.id))
    .map((item) => item.id)
    .sort();
  const fixtureRemovals = context.mockdata.fixtures
    .filter((item) => !nextFixturesById.has(item.id))
    .map((item) => item.id)
    .sort();

  const selectedScenarioIdsOrdered = scenarios.map((item) => item.id).sort();
  const coverageBefore = {
    scope: coverageFor(context, context.mockcases.cases, selectedScenarioIdsOrdered),
    project: coverageFor(context),
  };
  const coverageAfter = {
    scope: coverageFor(context, normalizedCases, selectedScenarioIdsOrdered),
    project: coverageFor(context, normalizedCases),
  };
  if (gaps.length === 0) {
    const nextMockdata = {
      ...context.mockdata,
      fixtures: nextFixtures,
      behaviors: nextBehaviors,
    };
    const nextMockcases = {
      ...context.mockcases,
      cases: normalizedCases,
    };
    const nextSuite = suiteManifest(actor, context.upstream, nextMockdata, nextMockcases);
    await validateSuiteData({
      ...context,
      suite: nextSuite,
      mockdata: nextMockdata,
      mockcases: nextMockcases,
    });
  }
  const body = {
    schemaVersion: MODEL_VERSION,
    status: gaps.length === 0 ? 'PASS' : 'BLOCKED',
    actor,
    scope: selectedScope,
    inputLock: {
      generatorVersion: MODEL_VERSION,
      schemaVersions: {
        suite: MODEL_VERSION,
        mockdata: MODEL_VERSION,
        mockcases: MODEL_VERSION,
      },
      ...context.upstream,
      suiteDigest: context.suiteDigest,
    },
    mockDataChanges: {
      upsertFixtures: fixtureUpserts,
      removeFixtureIds: fixtureRemovals,
      upsertBehaviors: behaviorUpserts,
      removeBehaviorIds: behaviorRemovals,
    },
    mockCaseChanges: {
      upsertCases: caseUpserts,
      removeCaseIds: caseRemovals,
    },
    coverageBefore,
    coverageAfter,
    gaps: gaps.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId)),
  };
  return { context, candidate: { ...body, candidateHash: sha256(stableJson(body)) } };
}

export function failure(error, operation) {
  return {
    status: 'BLOCKED',
    operation,
    blockers: [{ code: error.code || 'AIH_MOCKCASE_CONTRACT_INVALID', message: error.message }],
  };
}
