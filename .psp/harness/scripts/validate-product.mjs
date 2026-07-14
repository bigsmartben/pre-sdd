import { access, readFile, readdir } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { outputDrift } from './lib/rendering.mjs';
import { inspectDesignSourceEvidence } from './lib/html-mock-evidence.mjs';
import {
  artifactPaths,
  loadProjectAndManifest,
  readJson,
  repositoryFile,
  repositoryRootFrom,
} from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const strict = process.argv.includes('--strict');
const json = process.argv.includes('--json');
const blockers = [];
const warnings = [];
const models = new Map();

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

function duplicateIds(items, collection) {
  const seen = new Set();
  for (const item of items || []) {
    if (seen.has(item.id)) block('AIH_REFERENCE_UNRESOLVED', '标识符重复：' + item.id, collection);
    seen.add(item.id);
  }
  return seen;
}

function requireReference(value, known, location) {
  if (!known.has(value)) block('AIH_REFERENCE_UNRESOLVED', '引用未知标识符：' + value, location);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function pair(left, right) {
  return left + '::' + right;
}

let project;
let manifest;
try {
  ({ project, manifest } = await loadProjectAndManifest(root));
} catch (error) {
  block(error.code || 'AIH_PROJECT_BINDING_INVALID', error.message, 'psp.project.yaml');
}

async function directoryHasFiles(path) {
  let entries;
  try {
    entries = await readdir(repositoryFile(root, path), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return true;
    if (await directoryHasFiles(path + '/' + entry.name)) return true;
  }
  return false;
}

const productStage = project?.stages?.['product-design'];
const initializing = process.env.AI_HARNESS_INITIALIZING === 'product-design';
if (project && manifest && productStage?.status === 'uninitialized' && !initializing) {
  let partial = false;
  try {
    partial = await directoryHasFiles(productStage.root);
  } catch (error) {
    block('AIH_PROJECT_BINDING_INVALID', error.message, productStage.root);
  }
  const lifecycleBlockers = blockers.length > 0
    ? [...blockers]
    : partial
      ? [{
        code: 'AIH_PARTIAL_INITIALIZATION',
        message: 'uninitialized 阶段出现了用户文件；请清理碰撞或重新执行完整初始化。',
        location: productStage.root,
      }]
      : strict
        ? [{
          code: 'AIH_STAGE_UNINITIALIZED',
          message: '产品设计阶段尚未初始化，不能执行严格 readiness。',
          location: 'stages.product-design.status',
        }]
        : [];
  const lifecycleResult = {
    status: lifecycleBlockers.length === 0 ? 'PASS' : 'BLOCKED',
    mode: strict ? 'strict' : 'structure',
    state: 'uninitialized',
    blockerCount: lifecycleBlockers.length,
    blockers: lifecycleBlockers,
    warnings: partial ? [] : [{
      code: 'AIH_STAGE_UNINITIALIZED',
      message: '产品设计用户 Workspace 为空；结构绑定有效，但不存在可交付实例。',
    }],
  };
  if (json) process.stdout.write(JSON.stringify(lifecycleResult, null, 2) + '\n');
  else if (lifecycleResult.status === 'PASS') {
    console.warn('[WARN] AIH_STAGE_UNINITIALIZED：产品设计用户 Workspace 为空。');
    console.log('[PASS] 产品空状态结构校验通过。');
  } else {
    for (const item of lifecycleBlockers) console.error('[' + item.code + '] ' + item.message);
  }
  process.exit(lifecycleResult.status === 'PASS' ? 0 : 1);
}

if (project && manifest) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  for (const registry of manifest.artifactRegistry.filter((item) => item.stage === 'product-design')) {
    const paths = artifactPaths(project, registry.id, registry.stage);
    if (!paths) {
      block('AIH_PROJECT_BINDING_INVALID', '项目未绑定必需 artifact：' + registry.id, registry.id);
      continue;
    }
    try {
      const raw = await readFile(repositoryFile(root, paths.internalModel), 'utf8');
      const model = registry.format === 'json' ? JSON.parse(raw) : parseYaml(raw);
      models.set(registry.id, model);
      const schema = await readJson(root, registry.schema);
      const validate = ajv.compile(schema);
      if (!validate(model)) {
        for (const error of validate.errors || []) {
          block(
            'AIH_ARTIFACT_SCHEMA_FAILED',
            (error.instancePath || '/') + ' ' + error.message,
            paths.internalModel + (error.instancePath || ''),
          );
        }
      }
    } catch (error) {
      block('AIH_ARTIFACT_SCHEMA_FAILED', error.message, paths.internalModel);
    }
  }
}

const productPackage = models.get('product-package');
const capabilities = models.get('capabilities');
const interactions = models.get('interactions');
const uiSpec = models.get('ui-spec');
const componentCatalog = models.get('component-catalog');
const traceability = models.get('traceability');

if (blockers.every((item) => item.code !== 'AIH_ARTIFACT_SCHEMA_FAILED')) {
  const actorIds = duplicateIds(capabilities?.actors, 'capabilities.actors');
  const useCaseIds = duplicateIds(capabilities?.useCases, 'capabilities.useCases');
  const businessRuleIds = duplicateIds(capabilities?.businessRules, 'capabilities.businessRules');
  const wireflowIds = duplicateIds(interactions?.wireflows, 'interactions.wireflows');
  const screenIds = duplicateIds(interactions?.screens, 'interactions.screens');
  const interactionStateIds = duplicateIds(interactions?.interactionStates, 'interactions.interactionStates');
  const designSourceIds = duplicateIds(uiSpec?.designSources, 'ui-spec.designSources');
  duplicateIds(uiSpec?.assetBindings, 'ui-spec.assetBindings');
  const htmlMockIds = duplicateIds(uiSpec?.htmlMocks, 'ui-spec.htmlMocks');
  const htmlScenarioIds = duplicateIds(uiSpec?.interactionScenarios, 'ui-spec.interactionScenarios');
  const componentIds = duplicateIds(componentCatalog?.components, 'component-catalog.components');
  duplicateIds(uiSpec?.visualRules, 'ui-spec.visualRules');
  duplicateIds(uiSpec?.mockBehaviors, 'ui-spec.mockBehaviors');
  duplicateIds(uiSpec?.viewports, 'ui-spec.viewports');
  duplicateIds(uiSpec?.accessibility, 'ui-spec.accessibility');

  if (project?.stages?.['product-design']) {
    for (const issue of await inspectDesignSourceEvidence(
      root,
      project.stages['product-design'],
      uiSpec?.designSources,
    )) {
      block(issue.code, issue.message, issue.location);
    }
  }

  const useCaseById = new Map((capabilities?.useCases || []).map((item) => [item.id, item]));
  const scenariosByUseCase = new Map();
  const acceptanceIds = new Set();
  const scenarioIds = new Set();
  const useCaseStepIds = new Set();
  for (const useCase of capabilities?.useCases || []) {
    const location = 'capabilities.useCases.' + useCase.id;
    requireReference(useCase.actor, actorIds, location + '.actor');
    const mainIds = new Set();
    for (const step of useCase.mainScenario) {
      if (useCaseStepIds.has(step.id)) block('AIH_REFERENCE_UNRESOLVED', 'Use Case Step ID 重复：' + step.id, location + '.mainScenario');
      useCaseStepIds.add(step.id);
      mainIds.add(step.id);
      if (!step.id.startsWith(useCase.id + '-')) {
        block('AIH_REFERENCE_UNRESOLVED', '主场景 Step ID 不属于当前 Use Case：' + step.id, location + '.mainScenario');
      }
    }
    const expectedScenarios = new Set(['main']);
    for (const scenario of useCase.alternateScenarios) {
      if (scenarioIds.has(scenario.id)) block('AIH_REFERENCE_UNRESOLVED', 'Use Case 场景 ID 重复：' + scenario.id, location + '.alternateScenarios');
      scenarioIds.add(scenario.id);
      expectedScenarios.add(scenario.id);
      if (!scenario.id.startsWith(useCase.id + '-')) {
        block('AIH_REFERENCE_UNRESOLVED', '分支场景 ID 不属于当前 Use Case：' + scenario.id, location + '.alternateScenarios');
      }
      requireReference(scenario.startsAt, mainIds, location + '.alternateScenarios.' + scenario.id + '.startsAt');
      for (const step of scenario.steps) {
        if (useCaseStepIds.has(step.id)) block('AIH_REFERENCE_UNRESOLVED', 'Use Case Step ID 重复：' + step.id, location + '.alternateScenarios.' + scenario.id);
        useCaseStepIds.add(step.id);
        if (!step.id.startsWith(scenario.id + '-')) {
          block('AIH_REFERENCE_UNRESOLVED', '分支 Step ID 不属于当前场景：' + step.id, location + '.alternateScenarios.' + scenario.id);
        }
      }
    }
    scenariosByUseCase.set(useCase.id, expectedScenarios);
    for (const rule of useCase.businessRules) requireReference(rule, businessRuleIds, location + '.businessRules');
    for (const relation of useCase.relationships) requireReference(relation.target, useCaseIds, location + '.relationships');
    const acceptedScenarios = new Set();
    for (const criterion of useCase.acceptanceCriteria) {
      if (acceptanceIds.has(criterion.id)) block('AIH_REFERENCE_UNRESOLVED', 'Acceptance ID 重复：' + criterion.id, location + '.acceptanceCriteria');
      acceptanceIds.add(criterion.id);
      acceptedScenarios.add(criterion.scenario);
      requireReference(criterion.scenario, expectedScenarios, location + '.acceptanceCriteria.' + criterion.id + '.scenario');
    }
    if (strict && !sameSet(acceptedScenarios, expectedScenarios)) {
      block('AIH_ARTIFACT_INCOMPLETE', 'Use Case 的每个主/分支场景都必须具有验收条件：' + useCase.id, location + '.acceptanceCriteria');
    }
  }
  for (const rule of capabilities?.businessRules || []) {
    for (const useCase of rule.appliesTo) requireReference(useCase, useCaseIds, 'capabilities.businessRules.' + rule.id + '.appliesTo');
  }
  const scopeOverlap = (capabilities?.productScope?.included || []).filter((item) => capabilities.productScope.excluded.includes(item));
  if (scopeOverlap.length > 0) {
    block('AIH_REFERENCE_UNRESOLVED', '产品范围内外存在重复声明：' + scopeOverlap.join(', '), 'capabilities.productScope');
  }

  const regionIds = new Set();
  const controlIds = new Set();
  const controlScreen = new Map();
  const screenById = new Map((interactions?.screens || []).map((item) => [item.id, item]));
  for (const screen of interactions?.screens || []) {
    const location = 'interactions.screens.' + screen.id;
    for (const useCase of screen.useCases) requireReference(useCase, useCaseIds, location + '.useCases');
    for (const region of screen.regions) {
      if (regionIds.has(region.id)) block('AIH_REFERENCE_UNRESOLVED', 'Region ID 重复：' + region.id, location + '.regions');
      regionIds.add(region.id);
      for (const control of region.controls) {
        if (controlIds.has(control.id)) block('AIH_REFERENCE_UNRESOLVED', 'Control ID 重复：' + control.id, location + '.regions.' + region.id + '.controls');
        controlIds.add(control.id);
        controlScreen.set(control.id, screen.id);
        if (control.type === 'display' && control.action !== null) {
          block('AIH_REFERENCE_UNRESOLVED', 'display Control 不应声明 action：' + control.id, location + '.regions.' + region.id);
        }
        if (control.type !== 'display' && control.action === null) {
          block('AIH_ARTIFACT_INCOMPLETE', '可交互 Control 必须声明 action：' + control.id, location + '.regions.' + region.id);
        }
      }
    }
  }

  const stateById = new Map((interactions?.interactionStates || []).map((item) => [item.id, item]));
  for (const state of interactions?.interactionStates || []) {
    const location = 'interactions.interactionStates.' + state.id;
    requireReference(state.screen, screenIds, location + '.screen');
    for (const control of state.availableControls) {
      requireReference(control, controlIds, location + '.availableControls');
      if (controlScreen.get(control) && controlScreen.get(control) !== state.screen) {
        block('AIH_REFERENCE_UNRESOLVED', '状态引用了其他 Screen 的 Control：' + control, location + '.availableControls');
      }
    }
  }

  const wireflowById = new Map((interactions?.wireflows || []).map((item) => [item.id, item]));
  const wireflowStepIds = new Set();
  const wireflowsByUseCase = new Map([...useCaseIds].map((id) => [id, new Set()]));
  const coveredScenariosByUseCase = new Map([...useCaseIds].map((id) => [id, new Set()]));
  const screensByWireflow = new Map();
  for (const flow of interactions?.wireflows || []) {
    const location = 'interactions.wireflows.' + flow.id;
    requireReference(flow.useCase, useCaseIds, location + '.useCase');
    requireReference(flow.entryScreen, screenIds, location + '.entryScreen');
    wireflowsByUseCase.get(flow.useCase)?.add(flow.id);
    const expectedScenarios = scenariosByUseCase.get(flow.useCase) || new Set();
    for (const scenario of flow.coveredScenarios) {
      requireReference(scenario, expectedScenarios, location + '.coveredScenarios');
      coveredScenariosByUseCase.get(flow.useCase)?.add(scenario);
    }
    for (const stateId of flow.completionStates) {
      requireReference(stateId, interactionStateIds, location + '.completionStates');
      if (strict && stateById.get(stateId) && !stateById.get(stateId).terminal) {
        block('AIH_ARTIFACT_INCOMPLETE', '完成状态必须是 terminal：' + stateId, location + '.completionStates');
      }
    }
    const usedScreens = new Set([flow.entryScreen]);
    const scenarioSteps = new Map(flow.coveredScenarios.map((scenario) => [scenario, 0]));
    const stepsByScenario = new Map(flow.coveredScenarios.map((scenario) => [scenario, []]));
    for (const step of flow.steps) {
      if (wireflowStepIds.has(step.id)) block('AIH_REFERENCE_UNRESOLVED', 'Wireflow Step ID 重复：' + step.id, location + '.steps');
      wireflowStepIds.add(step.id);
      if (!step.id.startsWith(flow.id + '-')) block('AIH_REFERENCE_UNRESOLVED', 'Step ID 不属于当前 Wireflow：' + step.id, location + '.steps');
      requireReference(step.scenario, new Set(flow.coveredScenarios), location + '.steps.' + step.id + '.scenario');
      scenarioSteps.set(step.scenario, (scenarioSteps.get(step.scenario) || 0) + 1);
      stepsByScenario.get(step.scenario)?.push(step);
      for (const endpointName of ['from', 'to']) {
        const endpoint = step[endpointName];
        requireReference(endpoint.screen, screenIds, location + '.steps.' + step.id + '.' + endpointName + '.screen');
        requireReference(endpoint.state, interactionStateIds, location + '.steps.' + step.id + '.' + endpointName + '.state');
        if (stateById.get(endpoint.state)?.screen !== endpoint.screen) {
          block('AIH_REFERENCE_UNRESOLVED', 'State 不属于声明的 Screen：' + endpoint.state, location + '.steps.' + step.id + '.' + endpointName);
        }
        usedScreens.add(endpoint.screen);
      }
      if (step.control) {
        requireReference(step.control, controlIds, location + '.steps.' + step.id + '.control');
        if (controlScreen.get(step.control) && controlScreen.get(step.control) !== step.from.screen) {
          block('AIH_REFERENCE_UNRESOLVED', '触发 Control 不属于起始 Screen：' + step.control, location + '.steps.' + step.id + '.control');
        }
      }
      if (step.scenario !== 'main' && step.guard === null) {
        block('AIH_ARTIFACT_INCOMPLETE', '分支步骤必须声明 guard：' + step.id, location + '.steps.' + step.id + '.guard');
      }
    }
    for (const [scenario, count] of scenarioSteps) {
      if (count === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Wireflow 声明覆盖场景但没有对应步骤：' + scenario, location + '.steps');
    }
    for (const [scenario, steps] of stepsByScenario) {
      if (steps.length === 0) continue;
      if (steps[0].from.screen !== flow.entryScreen) {
        block('AIH_REFERENCE_UNRESOLVED', 'Wireflow 场景首步骤必须从入口 Screen 开始：' + scenario, location + '.steps');
      }
      for (let index = 1; index < steps.length; index += 1) {
        const previous = steps[index - 1].to;
        const current = steps[index].from;
        if (previous.screen !== current.screen || previous.state !== current.state) {
          block('AIH_REFERENCE_UNRESOLVED', 'Wireflow 场景步骤不连续：' + steps[index].id, location + '.steps');
        }
      }
      if (!flow.completionStates.includes(steps.at(-1).to.state)) {
        block('AIH_REFERENCE_UNRESOLVED', 'Wireflow 场景末步骤未进入完成状态：' + scenario, location + '.completionStates');
      }
      for (const screenId of new Set(steps.flatMap((step) => [step.from.screen, step.to.screen]))) {
        if (screenById.get(screenId) && !screenById.get(screenId).useCases.includes(flow.useCase)) {
          block('AIH_REFERENCE_UNRESOLVED', 'Wireflow 使用的 Screen 未声明对应 Use Case：' + screenId, location + '.steps');
        }
      }
    }
    screensByWireflow.set(flow.id, usedScreens);
  }

  const htmlMockById = new Map((uiSpec?.htmlMocks || []).map((item) => [item.id, item]));
  const htmlMockSources = new Map();
  for (const mock of uiSpec?.htmlMocks || []) {
    const location = 'ui-spec.htmlMocks.' + mock.id;
    for (const useCase of mock.useCases) requireReference(useCase, useCaseIds, location + '.useCases');
    for (const source of mock.designSources) requireReference(source, designSourceIds, location + '.designSources');
    for (const flowId of mock.wireflows) {
      requireReference(flowId, wireflowIds, location + '.wireflows');
      const flow = wireflowById.get(flowId);
      if (flow && !mock.useCases.includes(flow.useCase)) {
        block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock 的 Use Cases 未包含 Wireflow 上游：' + flow.useCase, location + '.useCases');
      }
    }
    const expectedUseCases = new Set(mock.wireflows.map((flowId) => wireflowById.get(flowId)?.useCase).filter(Boolean));
    if (!sameSet(new Set(mock.useCases), expectedUseCases)) {
      block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock 的 Use Cases 必须与其 Wireflows 精确一致。', location + '.useCases');
    }
    const mappedScreens = new Set();
    const selectors = new Set();
    for (const mapping of mock.screens) {
      requireReference(mapping.screen, screenIds, location + '.screens');
      if (mappedScreens.has(mapping.screen)) block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock 重复映射 Screen：' + mapping.screen, location + '.screens');
      if (selectors.has(mapping.selector)) block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock DOM selector 重复：' + mapping.selector, location + '.screens');
      mappedScreens.add(mapping.screen);
      selectors.add(mapping.selector);
    }
    for (const component of mock.components) requireReference(component, componentIds, location + '.components');
    try {
      const entryPath = repositoryFile(root, project.stages['product-design'].root + '/' + mock.entry);
      await access(entryPath);
      htmlMockSources.set(mock.id, await readFile(entryPath, 'utf8'));
    } catch {
      block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock 代码入口不存在：' + mock.entry, location + '.entry');
    }
    if (strict) {
      for (const flowId of mock.wireflows) {
        for (const requiredScreen of screensByWireflow.get(flowId) || []) {
          if (!mappedScreens.has(requiredScreen)) {
            block('AIH_ARTIFACT_INCOMPLETE', 'HTML Mock 未实现 Wireflow Screen：' + requiredScreen, location + '.screens');
          }
        }
      }
      const source = htmlMockSources.get(mock.id);
      if (source && !source.includes(mock.id)) {
        block('AIH_ARTIFACT_INCOMPLETE', 'HTML Mock 代码入口缺少自身追溯标识：' + mock.id, location + '.entry');
      }
      for (const mapping of mock.screens) {
        if (source && !source.includes(mapping.screen)) {
          block('AIH_ARTIFACT_INCOMPLETE', 'HTML Mock 代码入口缺少 Screen 追溯标识：' + mapping.screen, location + '.entry');
        }
      }
      for (const scenario of (uiSpec?.interactionScenarios || []).filter((item) => item.htmlMock === mock.id)) {
        if (source && !source.includes(scenario.id)) {
          block('AIH_ARTIFACT_INCOMPLETE', 'HTML Mock 代码入口缺少操作场景追溯标识：' + scenario.id, location + '.entry');
        }
      }
    }
  }

  const htmlStepIds = new Set();
  const actualHtmlScenarioPairs = new Set();
  const scenarioById = new Map((uiSpec?.interactionScenarios || []).map((item) => [item.id, item]));
  for (const scenario of uiSpec?.interactionScenarios || []) {
    const location = 'ui-spec.interactionScenarios.' + scenario.id;
    requireReference(scenario.htmlMock, htmlMockIds, location + '.htmlMock');
    requireReference(scenario.wireflow, wireflowIds, location + '.wireflow');
    const mock = htmlMockById.get(scenario.htmlMock);
    const flow = wireflowById.get(scenario.wireflow);
    if (mock && !mock.wireflows.includes(scenario.wireflow)) {
      block('AIH_REFERENCE_UNRESOLVED', '操作场景的 Wireflow 不属于 HTML Mock：' + scenario.wireflow, location + '.wireflow');
    }
    if (flow) requireReference(scenario.ucScenario, new Set(flow.coveredScenarios), location + '.ucScenario');
    const scenarioPair = pair(scenario.wireflow, scenario.ucScenario);
    if (actualHtmlScenarioPairs.has(scenarioPair)) {
      block('AIH_REFERENCE_UNRESOLVED', '同一 Wireflow 场景被重复声明为 HTML 操作场景：' + scenarioPair, location);
    }
    actualHtmlScenarioPairs.add(scenarioPair);
    for (const step of scenario.steps) {
      if (htmlStepIds.has(step.id)) block('AIH_REFERENCE_UNRESOLVED', 'HTML Scenario Step ID 重复：' + step.id, location + '.steps');
      htmlStepIds.add(step.id);
      requireReference(step.expectedScreen, screenIds, location + '.steps.' + step.id + '.expectedScreen');
      requireReference(step.expectedState, interactionStateIds, location + '.steps.' + step.id + '.expectedState');
      if (stateById.get(step.expectedState)?.screen !== step.expectedScreen) {
        block('AIH_REFERENCE_UNRESOLVED', 'HTML 场景预期状态不属于预期 Screen：' + step.expectedState, location + '.steps.' + step.id);
      }
      if (mock && !mock.screens.some((item) => item.screen === step.expectedScreen)) {
        block('AIH_REFERENCE_UNRESOLVED', 'HTML 场景预期 Screen 未被对应 Mock 映射：' + step.expectedScreen, location + '.steps.' + step.id);
      }
    }
    if (strict && flow) {
      const expectedSteps = flow.steps.filter((step) => step.scenario === scenario.ucScenario);
      if (
        expectedSteps.length !== scenario.steps.length
        || expectedSteps.some((step, index) => (
          step.to.screen !== scenario.steps[index]?.expectedScreen
          || step.to.state !== scenario.steps[index]?.expectedState
        ))
      ) {
        block('AIH_ARTIFACT_INCOMPLETE', 'HTML 操作场景必须逐步复现 Wireflow 的目标 Screen 与状态：' + scenario.id, location + '.steps');
      }
    }
  }

  for (const behavior of uiSpec?.mockBehaviors || []) {
    const location = 'ui-spec.mockBehaviors.' + behavior.id;
    requireReference(behavior.scenario, htmlScenarioIds, location + '.scenario');
    requireReference(behavior.resultState, interactionStateIds, location + '.resultState');
    const scenario = scenarioById.get(behavior.scenario);
    if (scenario && !scenario.steps.some((step) => step.expectedState === behavior.resultState)) {
      block('AIH_REFERENCE_UNRESOLVED', 'Mock Behavior 的结果状态未出现在对应操作场景：' + behavior.resultState, location + '.resultState');
    }
  }

  for (const rule of uiSpec?.visualRules || []) {
    const location = 'ui-spec.visualRules.' + rule.id;
    for (const source of rule.sourceRefs) requireReference(source, designSourceIds, location + '.sourceRefs');
  }

  for (const binding of uiSpec?.assetBindings || []) {
    const location = 'ui-spec.assetBindings.' + binding.id;
    requireReference(binding.source, designSourceIds, location + '.source');
    for (const mock of binding.htmlMocks) requireReference(mock, htmlMockIds, location + '.htmlMocks');
    if (binding.status === 'localized') {
      const areaRoot = project.stages['product-design'].areas?.['html-mock']?.root;
      if (!areaRoot || !binding.localPath.startsWith(areaRoot + '/')) {
        block('AIH_REFERENCE_UNRESOLVED', '本地化设计资源必须位于绑定的 HTML Mock area：' + binding.localPath, location + '.localPath');
      }
      try {
        await access(repositoryFile(root, project.stages['product-design'].root + '/' + binding.localPath));
      } catch {
        block('AIH_REFERENCE_UNRESOLVED', '已本地化的设计资源不存在：' + binding.localPath, location + '.localPath');
      }
      const usedMocks = new Set();
      const assetName = binding.localPath.split('/').at(-1);
      for (const usage of binding.usages) {
        const usageLocation = location + '.usages.' + usage.htmlMock;
        requireReference(usage.htmlMock, htmlMockIds, usageLocation + '.htmlMock');
        if (!binding.htmlMocks.includes(usage.htmlMock)) {
          block('AIH_REFERENCE_UNRESOLVED', '资源使用引用了绑定范围外的 HTML Mock：' + usage.htmlMock, usageLocation);
        }
        usedMocks.add(usage.htmlMock);
        const mock = htmlMockById.get(usage.htmlMock);
        if (usage.scenario) {
          requireReference(usage.scenario, htmlScenarioIds, usageLocation + '.scenario');
          const scenario = scenarioById.get(usage.scenario);
          if (scenario && scenario.htmlMock !== usage.htmlMock) {
            block('AIH_REFERENCE_UNRESOLVED', '资源使用场景不属于对应 HTML Mock：' + usage.scenario, usageLocation + '.scenario');
          }
        }
        if (mock && usage.entry !== mock.entry) {
          block('AIH_REFERENCE_UNRESOLVED', '资源使用入口必须等于 HTML Mock 入口：' + usage.entry, usageLocation + '.entry');
        }
        const source = htmlMockSources.get(usage.htmlMock);
        if (source && (!source.includes(usage.reference) || !usage.reference.includes(assetName))) {
          block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock 入口未引用本地化设计资源：' + binding.id, usageLocation + '.reference');
        }
      }
      if (!sameSet(usedMocks, new Set(binding.htmlMocks))) {
        block('AIH_REFERENCE_UNRESOLVED', '本地化资源必须为每个绑定 HTML Mock 声明代码使用：' + binding.id, location + '.usages');
      }
    }
  }

  for (const component of componentCatalog?.components || []) {
    const location = 'component-catalog.components.' + component.id;
    for (const mock of component.htmlMocks) requireReference(mock, htmlMockIds, location + '.htmlMocks');
    try {
      await access(repositoryFile(root, project.stages['product-design'].root + '/' + component.prototype));
    } catch {
      block('AIH_REFERENCE_UNRESOLVED', '组件 HTML Mock 入口不存在：' + component.prototype, location + '.prototype');
    }
  }

  const tracedUseCases = new Set();
  for (const link of traceability?.links || []) {
    const location = 'traceability.links.' + link.useCase;
    if (tracedUseCases.has(link.useCase)) block('AIH_REFERENCE_UNRESOLVED', 'Traceability Use Case 重复：' + link.useCase, 'traceability.links');
    tracedUseCases.add(link.useCase);
    requireReference(link.useCase, useCaseIds, location);
    for (const flow of link.wireflows) requireReference(flow, wireflowIds, location + '.wireflows');
    for (const mock of link.htmlMocks) requireReference(mock, htmlMockIds, location + '.htmlMocks');
  }

  if (productPackage) {
    const bound = new Set(Object.keys(project.stages['product-design'].artifacts));
    const declared = new Set(['product-package', ...productPackage.primaryChain, ...productPackage.supportingArtifacts]);
    if (!sameSet(bound, declared)) {
      block('AIH_PROJECT_BINDING_INVALID', 'Product Package 主链/支撑产物与项目绑定不一致。', 'product-package');
    }
  }

  if (strict) {
    for (const [artifactId, model] of models) {
      if (artifactId === 'traceability') continue;
      if (model.metadata.status !== 'ready') block('AIH_ARTIFACT_INCOMPLETE', artifactId + ' status 不是 ready。', artifactId + '.metadata.status');
      if (model.gaps.length > 0) block('AIH_ARTIFACT_INCOMPLETE', artifactId + ' 仍存在显式 gaps。', artifactId + '.gaps');
      for (const gate of model.gates) {
        if (!gate.checked) block('AIH_ARTIFACT_INCOMPLETE', '门禁未完成：' + gate.label, artifactId + '.gates.' + gate.id);
      }
    }
    for (const [field, value] of Object.entries(productPackage?.overview || {})) {
      if (!value) block('AIH_ARTIFACT_INCOMPLETE', 'Product Overview 未定义：' + field, 'product-package.overview.' + field);
    }
    const minimums = [
      ['capabilities.actors', capabilities?.actors],
      ['capabilities.productScope.included', capabilities?.productScope?.included],
      ['capabilities.productScope.excluded', capabilities?.productScope?.excluded],
      ['capabilities.useCases', capabilities?.useCases],
      ['interactions.wireflows', interactions?.wireflows],
      ['interactions.screens', interactions?.screens],
      ['interactions.interactionStates', interactions?.interactionStates],
      ['ui-spec.designSources', uiSpec?.designSources],
      ['ui-spec.htmlMocks', uiSpec?.htmlMocks],
      ['ui-spec.interactionScenarios', uiSpec?.interactionScenarios],
      ['ui-spec.visualRules', uiSpec?.visualRules],
      ['ui-spec.viewports', uiSpec?.viewports],
      ['ui-spec.accessibility', uiSpec?.accessibility],
      ['component-catalog.components', componentCatalog?.components],
      ['traceability.links', traceability?.links],
    ];
    for (const [location, values] of minimums) {
      if (!values?.length) block('AIH_ARTIFACT_INCOMPLETE', '严格门禁要求至少一个正式条目。', location);
    }
    for (const source of uiSpec?.designSources || []) {
      if (source.status !== 'available') {
        block('AIH_ARTIFACT_INCOMPLETE', '设计来源尚未完整可用：' + source.id, 'ui-spec.designSources.' + source.id + '.status');
      }
    }
    for (const binding of uiSpec?.assetBindings || []) {
      if (binding.status === 'blocked') {
        block('AIH_ARTIFACT_INCOMPLETE', '设计资源本地化仍被阻断：' + binding.id, 'ui-spec.assetBindings.' + binding.id + '.status');
      }
    }
    for (const [useCase, expected] of scenariosByUseCase) {
      if (!sameSet(coveredScenariosByUseCase.get(useCase), expected)) {
        block('AIH_REFERENCE_UNRESOLVED', 'Use Case 的主/分支场景未被 Wireflow 精确覆盖：' + useCase, 'interactions.wireflows');
      }
    }
    const expectedHtmlScenarioPairs = new Set();
    for (const flow of interactions?.wireflows || []) {
      for (const scenario of flow.coveredScenarios) expectedHtmlScenarioPairs.add(pair(flow.id, scenario));
    }
    if (!sameSet(actualHtmlScenarioPairs, expectedHtmlScenarioPairs)) {
      block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock 操作场景未精确覆盖所有 Wireflow 场景。', 'ui-spec.interactionScenarios');
    }
    const requiredViewports = (uiSpec?.viewports || []).filter((item) => item.required);
    if (!requiredViewports.some((item) => item.width <= 768) || !requiredViewports.some((item) => item.width > 768)) {
      block('AIH_ARTIFACT_INCOMPLETE', 'HTML Mock 必须声明至少一个移动端和一个桌面端必测视口。', 'ui-spec.viewports');
    }
    for (const mock of uiSpec?.htmlMocks || []) {
      const expectedComponents = new Set(
        (componentCatalog?.components || [])
          .filter((component) => component.htmlMocks.includes(mock.id))
          .map((component) => component.id),
      );
      if (!sameSet(new Set(mock.components), expectedComponents)) {
        block('AIH_REFERENCE_UNRESOLVED', 'HTML Mock 与 Component Catalog 的组件映射不一致：' + mock.id, 'ui-spec.htmlMocks.' + mock.id + '.components');
      }
    }
    const htmlMocksByUseCase = new Map([...useCaseIds].map((id) => [id, new Set()]));
    for (const mock of uiSpec?.htmlMocks || []) {
      for (const useCase of mock.useCases) htmlMocksByUseCase.get(useCase)?.add(mock.id);
    }
    const actualLinks = new Map((traceability?.links || []).map((link) => [link.useCase, link]));
    for (const useCase of useCaseIds) {
      const actual = actualLinks.get(useCase);
      if (
        !actual
        || !sameSet(new Set(actual.wireflows), wireflowsByUseCase.get(useCase))
        || !sameSet(new Set(actual.htmlMocks), htmlMocksByUseCase.get(useCase))
      ) {
        block('AIH_REFERENCE_UNRESOLVED', 'Traceability 与正式 UC → Wireflow → HTML Mock 映射不一致：' + useCase, 'traceability.links');
      }
    }
    const serialized = JSON.stringify([...models.values()]);
    if (/(?:待填写|(?:^|[^A-Z])NNN(?:[^A-Z]|$)|未定义)/.test(serialized)) {
      block('AIH_ARTIFACT_INCOMPLETE', '权威实例仍含禁止的占位符。', 'product-design');
    }
  } else if (
    [...models.entries()].some(([id, model]) => id !== 'traceability' && (model.metadata.status === 'draft' || model.gaps.length > 0))
  ) {
    warnings.push('结构有效，但产品实例仍处于 draft 或包含显式 gap；不得声明 ready。');
  }
}

if (project && manifest) {
  try {
    for (const drift of await outputDrift(root, project, manifest, 'product-design')) {
      block('AIH_GENERATED_DRIFT', '用户产物或机器支撑与内部模型不一致：' + drift.internalModel, drift.output);
    }
  } catch (error) {
    block('AIH_GENERATED_DRIFT', error.message, 'outputs');
  }
}

const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  mode: strict ? 'strict' : 'structure',
  state: initializing ? 'initializing' : 'active',
  blockerCount: blockers.length,
  blockers,
  warnings,
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const warning of warnings) console.warn('[WARN] ' + warning);
  if (result.status === 'PASS') console.log('[PASS] 产品 ' + (strict ? '严格' : '结构') + '校验通过。');
  else for (const item of blockers) console.error('[' + item.code + '] (' + (item.location || 'unknown') + ') ' + item.message);
}

if (result.status !== 'PASS') process.exitCode = 1;
