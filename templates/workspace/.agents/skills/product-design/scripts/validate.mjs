import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactCollectionMembers,
  artifactPaths,
  loadProjectAndManifest,
  readJson,
  readStructured,
  repositoryFile,
  repositoryRootFrom,
  stageHasUserFiles,
  workspaceRootMarker,
} from '../../../../.psp/harness/scripts/lib/repository.mjs';
import { collectDependencyArtifactIds } from '../../../../.psp/harness/scripts/lib/project-dag.mjs';
import { outputDrift } from './lib/rendering.mjs';
import { extractCanonicalUi } from '../canonical-ui-prototype/scripts/extract.mjs';
import { canonicalOutputDrift } from '../canonical-ui-prototype/scripts/project.mjs';
import { verifyPublishedProduct } from '../canonical-ui-prototype/scripts/publication.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const stepIndex = process.argv.indexOf('--step');
const readinessStep = process.argv.includes('--strict')
  ? 'canonical-ui-prototype'
  : stepIndex >= 0 ? process.argv[stepIndex + 1] : null;
const strict = readinessStep !== null;
const json = process.argv.includes('--json');
const validSteps = new Set(['use-cases', 'visual-spec', 'canonical-ui-prototype']);
const blockers = [];
const warnings = [];

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

function warn(code, message, location) {
  warnings.push({ code, message, ...(location ? { location } : {}) });
}

function ids(items, collection) {
  const result = new Set();
  for (const item of items || []) {
    if (result.has(item.id)) block('AIH_REFERENCE_UNRESOLVED', '标识重复：' + item.id, collection);
    result.add(item.id);
  }
  return result;
}

function requireReferences(values, available, location, label) {
  for (const value of values || []) if (!available.has(value)) block('AIH_REFERENCE_UNRESOLVED', label + ' 引用不存在：' + value, location);
}

function addUniqueId(id, available, location) {
  if (available.has(id)) block('AIH_REFERENCE_UNRESOLVED', '标识重复：' + id, location);
  available.add(id);
}

function validateCapabilities(capabilities) {
  const actorIds = ids(capabilities?.actors, 'capabilities.actors');
  const businessRuleIds = ids(capabilities?.businessRules, 'capabilities.businessRules');
  const useCaseIds = ids(capabilities?.useCases, 'capabilities.useCases');
  const scenarioIds = new Set();
  const stepIds = new Set();

  for (const useCase of capabilities?.useCases || []) {
    const location = 'capabilities.useCases.' + useCase.id;
    requireReferences([useCase.actor], actorIds, location + '.actor', 'Actor');
    requireReferences(useCase.businessRules, businessRuleIds, location + '.businessRules', 'Business Rule');
    for (const relationship of useCase.relationships || []) {
      requireReferences([relationship.target], useCaseIds, location + '.relationships', 'Use Case');
      if (relationship.target === useCase.id) {
        block('AIH_REFERENCE_UNRESOLVED', 'Use Case 关系不得自引用：' + useCase.id, location + '.relationships');
      }
    }

    const mainStepIds = new Set();
    for (const step of useCase.mainScenario || []) {
      addUniqueId(step.id, stepIds, location + '.mainScenario');
      mainStepIds.add(step.id);
      if (!step.id.startsWith(useCase.id + '-STEP-')) {
        block('AIH_REFERENCE_UNRESOLVED', '主场景步骤不属于当前 Use Case：' + step.id, location + '.mainScenario');
      }
    }

    for (const scenario of useCase.alternateScenarios || []) {
      addUniqueId(scenario.id, scenarioIds, location + '.alternateScenarios');
      if (!scenario.id.startsWith(useCase.id + '-ALT-') && !scenario.id.startsWith(useCase.id + '-EXC-')) {
        block('AIH_REFERENCE_UNRESOLVED', '分支场景不属于当前 Use Case：' + scenario.id, location + '.alternateScenarios');
      }
      if (!mainStepIds.has(scenario.startsAt)) {
        block('AIH_REFERENCE_UNRESOLVED', 'startsAt 未引用当前 Use Case 主步骤：' + scenario.startsAt, location + '.alternateScenarios.' + scenario.id);
      }
      for (const step of scenario.steps || []) {
        addUniqueId(step.id, stepIds, location + '.alternateScenarios.' + scenario.id + '.steps');
        if (!step.id.startsWith(scenario.id + '-STEP-')) {
          block('AIH_REFERENCE_UNRESOLVED', '分支步骤不属于当前场景：' + step.id, location + '.alternateScenarios.' + scenario.id + '.steps');
        }
      }
    }
  }

  const referencedBusinessRules = new Set((capabilities?.useCases || []).flatMap((useCase) => useCase.businessRules || []));
  for (const rule of capabilities?.businessRules || []) {
    if (!referencedBusinessRules.has(rule.id)) {
      block('AIH_ARTIFACT_INCOMPLETE', 'Business Rule 未被任何 Use Case 引用：' + rule.id, 'capabilities.businessRules.' + rule.id);
    }
  }

  return { actorIds, businessRuleIds, useCaseIds, scenarioIds, stepIds };
}

async function fileSha256(path) {
  return 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
}

function validateCapabilitiesReadiness(capabilities) {
  const intentFields = ['productName', 'productConcept', 'problem', 'businessGoal', 'successSignal'];
  for (const field of intentFields) {
    if (typeof capabilities?.intent?.[field] !== 'string' || capabilities.intent[field].trim() === '') {
      block('AIH_ARTIFACT_INCOMPLETE', 'Use Cases 产品意图未完成：' + field, 'capabilities.intent.' + field);
    }
  }
  if ((capabilities?.actors || []).length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Use Cases 缺少 Actor。', 'capabilities.actors');
  if ((capabilities?.useCases || []).length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Use Cases 缺少稳定产品行为。', 'capabilities.useCases');
  if ((capabilities?.productScope?.included || []).length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Use Cases 缺少产品范围内条目。', 'capabilities.productScope.included');
  if (capabilities?.metadata?.status !== 'ready') block('AIH_ARTIFACT_INCOMPLETE', 'Use Cases 状态不是 ready。', 'capabilities.metadata.status');
  if ((capabilities?.gaps || []).length > 0) block('AIH_ARTIFACT_INCOMPLETE', 'Use Cases 仍有待确认问题。', 'capabilities.gaps');
}

function validateVisualStyle(style, available, location) {
  if (!style) return;
  requireReferences([style.layoutRef].filter(Boolean), available.layoutIds, location, 'Layout');
  requireReferences([style.typographyRef].filter(Boolean), available.typographyIds, location, 'Typography');
  requireReferences([style.fillPaintRef, style.textPaintRef, style.border?.paintRef].filter(Boolean), available.paintIds, location, 'Paint');
  requireReferences(style.effectRefs, available.effectIds, location, 'Effect');
}

function variantCombinations(axes, index = 0, current = []) {
  if (index >= axes.length) return [current];
  return axes[index].values.flatMap((value) => variantCombinations(axes, index + 1, [...current, [axes[index].name, value]]));
}

async function validateVisualSpec(visualSpec, capabilities, stage) {
  if (!visualSpec) return null;
  const useCaseIds = new Set((capabilities?.useCases || []).map((item) => item.id));
  const interactionStateIds = new Set((capabilities?.interactionStates || []).map((item) => item.id));
  const viewportIds = ids(visualSpec.viewports, 'visualSpec.viewports');
  const sourceIds = ids(visualSpec.sources, 'visualSpec.sources');
  const spacingIds = ids(visualSpec.foundations?.spacing, 'visualSpec.foundations.spacing');
  const typographyIds = ids(visualSpec.foundations?.typography, 'visualSpec.foundations.typography');
  const paintIds = ids(visualSpec.foundations?.paints, 'visualSpec.foundations.paints');
  const effectIds = ids(visualSpec.foundations?.effects, 'visualSpec.foundations.effects');
  const layoutIds = ids(visualSpec.layouts, 'visualSpec.layouts');
  const pageIds = ids(visualSpec.pages, 'visualSpec.pages');
  const renderingIds = ids(visualSpec.renderings, 'visualSpec.renderings');
  const componentIds = ids(visualSpec.components, 'visualSpec.components');
  const assetIds = ids(visualSpec.assets, 'visualSpec.assets');
  const visualCaseIds = new Set();
  const available = { layoutIds, typographyIds, paintIds, effectIds };

  for (const effect of visualSpec.foundations?.effects || []) {
    requireReferences([effect.paintRef].filter(Boolean), paintIds, 'visualSpec.foundations.effects.' + effect.id, 'Paint');
  }
  for (const layout of visualSpec.layouts || []) {
    const location = 'visualSpec.layouts.' + layout.id;
    requireReferences([layout.gapRef, ...Object.values(layout.padding || {})], spacingIds, location, 'Spacing');
    requireReferences((layout.children || []).map((item) => item.componentRef), componentIds, location, 'Component');
    const orders = (layout.children || []).map((item) => item.order);
    if (new Set(orders).size !== orders.length) block('AIH_ARTIFACT_INCOMPLETE', 'Layout child order 必须唯一：' + layout.id, location + '.children');
  }
  for (const page of visualSpec.pages || []) {
    requireReferences(page.useCaseRefs, useCaseIds, 'visualSpec.pages.' + page.id, 'Use Case');
  }
  for (const component of visualSpec.components || []) {
    const location = 'visualSpec.components.' + component.id;
    requireReferences(component.useCaseRefs, useCaseIds, location, 'Use Case');
    requireReferences(component.interactionStateRefs, interactionStateIds, location, 'Interaction State');
    const axisNames = new Set();
    for (const axis of component.variantAxes || []) {
      if (axisNames.has(axis.name)) block('AIH_REFERENCE_UNRESOLVED', 'Variant axis 重复：' + axis.name, location + '.variantAxes');
      axisNames.add(axis.name);
    }
    const caseKeys = new Set();
    for (const visualCase of component.visualCases || []) {
      addUniqueId(visualCase.id, visualCaseIds, location + '.visualCases');
      requireReferences([visualCase.interactionStateRef], new Set(component.interactionStateRefs), location + '.visualCases.' + visualCase.id, 'Component Interaction State');
      const selections = new Map();
      for (const selection of visualCase.variants || []) {
        if (selections.has(selection.name)) block('AIH_REFERENCE_UNRESOLVED', 'Visual Case Variant axis 重复：' + selection.name, location + '.visualCases.' + visualCase.id);
        selections.set(selection.name, selection.value);
        const axis = (component.variantAxes || []).find((item) => item.name === selection.name);
        if (!axis || !axis.values.includes(selection.value)) block('AIH_REFERENCE_UNRESOLVED', 'Visual Case Variant 不存在：' + selection.name + '=' + selection.value, location + '.visualCases.' + visualCase.id);
      }
      if (selections.size !== axisNames.size || [...axisNames].some((name) => !selections.has(name))) {
        block('AIH_ARTIFACT_INCOMPLETE', 'Visual Case 必须为每个 Variant axis 选择一个值：' + visualCase.id, location + '.visualCases.' + visualCase.id);
      }
      const key = visualCase.interactionStateRef + '|' + [...selections].sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => name + '=' + value).join('|');
      if (caseKeys.has(key)) block('AIH_REFERENCE_UNRESOLVED', '组件状态与 Variant 组合重复：' + key, location + '.visualCases');
      caseKeys.add(key);
      validateVisualStyle(visualCase.visual, available, location + '.visualCases.' + visualCase.id + '.visual');
    }
    const combinations = variantCombinations(component.variantAxes || []);
    for (const stateId of component.interactionStateRefs || []) for (const combination of combinations) {
      const key = stateId + '|' + combination.slice().sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => name + '=' + value).join('|');
      if (!caseKeys.has(key)) block('AIH_ARTIFACT_INCOMPLETE', '组件缺少状态与 Variant 的完整视觉组合：' + component.id + ' / ' + key, location + '.visualCases');
    }
  }
  for (const rendering of visualSpec.renderings || []) {
    const location = 'visualSpec.renderings.' + rendering.id;
    requireReferences([rendering.pageRef], pageIds, location, 'Page');
    requireReferences([rendering.viewportRef], viewportIds, location, 'Viewport');
    requireReferences(rendering.interactionStateRefs, interactionStateIds, location, 'Interaction State');
    requireReferences([rendering.layoutRef], layoutIds, location, 'Layout');
    requireReferences(rendering.componentRefs, componentIds, location, 'Component');
    requireReferences([rendering.backgroundPaintRef], paintIds, location, 'Paint');
    const page = (visualSpec.pages || []).find((item) => item.id === rendering.pageRef);
    const pageUseCases = new Set(page?.useCaseRefs || []);
    const relevantStates = new Set((capabilities?.interactionFlows || [])
      .filter((flow) => pageUseCases.has(flow.useCase))
      .flatMap((flow) => [flow.entryState, ...flow.completionStates, ...flow.transitions.flatMap((transition) => [transition.from, transition.to])]));
    requireReferences(rendering.interactionStateRefs, relevantStates, location, 'Page Use Case Interaction State');
    for (const componentId of rendering.componentRefs || []) {
      const component = (visualSpec.components || []).find((item) => item.id === componentId);
      requireReferences(rendering.interactionStateRefs, new Set(component?.interactionStateRefs || []), location, 'Rendered Component Interaction State');
    }
  }
  for (const asset of visualSpec.assets || []) {
    const location = 'visualSpec.assets.' + asset.id;
    requireReferences([asset.sourceRef], sourceIds, location, 'Visual Source');
    for (const usage of asset.usage || []) {
      requireReferences([usage.renderingRef], renderingIds, location + '.usage', 'Rendering');
      requireReferences([usage.componentRef].filter(Boolean), componentIds, location + '.usage', 'Component');
      requireReferences([usage.visualCaseRef].filter(Boolean), visualCaseIds, location + '.usage', 'Visual Case');
      if (usage.visualCaseRef && !usage.componentRef) block('AIH_REFERENCE_UNRESOLVED', 'Asset visualCaseRef 必须同时指定 componentRef：' + asset.id, location + '.usage');
      if (usage.visualCaseRef && usage.componentRef) {
        const component = (visualSpec.components || []).find((item) => item.id === usage.componentRef);
        if (!(component?.visualCases || []).some((item) => item.id === usage.visualCaseRef)) {
          block('AIH_REFERENCE_UNRESOLVED', 'Asset Visual Case 不属于指定 Component：' + usage.visualCaseRef, location + '.usage');
        }
      }
    }
    try {
      const content = await readFile(repositoryFile(root, stage.root + '/' + asset.file));
      const actualHash = 'sha256:' + createHash('sha256').update(content).digest('hex');
      if (actualHash !== asset.contentHash) block('AIH_SOURCE_INTEGRITY_FAILED', 'Visual Spec 资源内容哈希不匹配：' + asset.file, location);
    } catch (error) {
      block(error.code === 'ENOENT' ? 'AIH_SOURCE_INTEGRITY_FAILED' : (error.code || 'AIH_SOURCE_INTEGRITY_FAILED'), 'Visual Spec 资源不可读：' + asset.file, location);
    }
  }
  return { useCaseIds, interactionStateIds, viewportIds, sourceIds, layoutIds, pageIds, renderingIds, componentIds, assetIds };
}

function validateVisualSpecReadiness(visualSpec, capabilities) {
  if (capabilities?.metadata?.status !== 'ready' || (capabilities?.gaps || []).length > 0) {
    block('AIH_UPSTREAM_NOT_READY', 'Visual Spec 要求 Use Cases 已达到独立 readiness；不得静默补写上游事实。', 'capabilities');
  }
  if (visualSpec?.metadata?.status !== 'ready') block('AIH_ARTIFACT_INCOMPLETE', 'Visual Spec 状态不是 ready。', 'visualSpec.metadata.status');
  if ((visualSpec?.gaps || []).length > 0) block('AIH_ARTIFACT_INCOMPLETE', 'Visual Spec 仍有待确认问题。', 'visualSpec.gaps');
  for (const [name, value] of Object.entries({
    viewports: visualSpec?.viewports,
    sources: visualSpec?.sources,
    spacing: visualSpec?.foundations?.spacing,
    typography: visualSpec?.foundations?.typography,
    paints: visualSpec?.foundations?.paints,
    layouts: visualSpec?.layouts,
    pages: visualSpec?.pages,
    renderings: visualSpec?.renderings,
    components: visualSpec?.components,
  })) if ((value || []).length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Visual Spec 缺少：' + name, 'visualSpec.' + name);

  const uiUseCases = (capabilities?.useCases || []).filter((item) => item.uiApplicability?.mode === 'required');
  for (const useCase of uiUseCases) {
    const pages = (visualSpec?.pages || []).filter((item) => item.useCaseRefs.includes(useCase.id));
    if (pages.length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'UI Use Case 缺少 Visual Spec Page：' + useCase.id, 'visualSpec.pages');
    const states = new Set((capabilities?.interactionFlows || [])
      .filter((flow) => flow.useCase === useCase.id)
      .flatMap((flow) => [flow.entryState, ...flow.completionStates, ...flow.transitions.flatMap((transition) => [transition.from, transition.to])]));
    for (const page of pages) for (const viewport of visualSpec?.viewports || []) for (const stateId of states) {
      const covered = (visualSpec?.renderings || []).some((item) => item.pageRef === page.id && item.viewportRef === viewport.id && item.interactionStateRefs.includes(stateId));
      if (!covered) block('AIH_SOURCE_COVERAGE_FAILED', 'Visual Spec 缺少页面、视口与正式状态渲染：' + page.id + ' / ' + viewport.id + ' / ' + stateId, 'visualSpec.renderings');
    }
  }
}

function layoutRegionReferences(node, result = []) {
  if (!node) return result;
  if (node.type === 'region') result.push(node.region);
  else for (const child of node.children || []) layoutRegionReferences(child, result);
  return result;
}

function validateInformationArchitecture(blueprint, screenIds) {
  const siteMap = blueprint.informationArchitecture;
  const siteMapScreenIds = new Set();
  for (const node of siteMap.nodes || []) {
    if (siteMapScreenIds.has(node.screen)) {
      block('AIH_REFERENCE_UNRESOLVED', 'Low-Fi IA 重复放置 Screen：' + node.screen, 'capabilities.lowFiUiBlueprints.' + blueprint.id);
    }
    siteMapScreenIds.add(node.screen);
  }
  requireReferences([...siteMapScreenIds], screenIds, 'capabilities.lowFiUiBlueprints.' + blueprint.id, 'Low-Fi Screen');
  requireReferences([siteMap.entryScreen], siteMapScreenIds, 'capabilities.lowFiUiBlueprints.' + blueprint.id, 'IA node');

  for (const screenId of screenIds) {
    if (!siteMapScreenIds.has(screenId)) {
      block('AIH_ARTIFACT_INCOMPLETE', 'Low-Fi IA 未覆盖 Screen：' + screenId, 'capabilities.lowFiUiBlueprints.' + blueprint.id);
    }
  }

  const roots = (siteMap.nodes || []).filter((node) => node.parent === null);
  if ((siteMap.nodes || []).length > 0 && roots.length !== 1) {
    block('AIH_ARTIFACT_INCOMPLETE', 'Low-Fi IA 必须且只能有一个根页面，实际为 ' + roots.length + ' 个。', 'capabilities.lowFiUiBlueprints.' + blueprint.id);
  }
  if (roots.length === 1 && siteMap.entryScreen !== roots[0].screen) {
    block('AIH_REFERENCE_UNRESOLVED', 'Low-Fi IA 入口必须是根页面：' + siteMap.entryScreen, 'capabilities.lowFiUiBlueprints.' + blueprint.id);
  }

  const children = new Map();
  for (const node of siteMap.nodes || []) {
    if (node.parent === null) continue;
    requireReferences([node.parent], siteMapScreenIds, 'capabilities.lowFiUiBlueprints.' + blueprint.id, 'parent');
    if (node.parent === node.screen) {
      block('AIH_REFERENCE_UNRESOLVED', 'Low-Fi IA 页面不能以自身为父页面：' + node.screen, 'capabilities.lowFiUiBlueprints.' + blueprint.id);
    }
    if (!children.has(node.parent)) children.set(node.parent, []);
    children.get(node.parent).push(node.screen);
  }

  const reachable = new Set();
  const pending = siteMap.entryScreen ? [siteMap.entryScreen] : [];
  while (pending.length > 0) {
    const screenId = pending.pop();
    if (reachable.has(screenId)) continue;
    reachable.add(screenId);
    pending.push(...(children.get(screenId) || []));
  }
  for (const screenId of siteMapScreenIds) {
    if (!reachable.has(screenId)) {
      block('AIH_ARTIFACT_INCOMPLETE', 'Low-Fi IA 页面无法从入口沿层级到达：' + screenId, 'capabilities.lowFiUiBlueprints.' + blueprint.id);
    }
  }
}

function aggregateMembers(members) {
  if (!members?.length) return null;
  const first = members[0].data;
  const result = { ...first };
  for (const key of Object.keys(first)) {
    if (Array.isArray(first[key])) result[key] = members.flatMap((member) => member.data[key] || []);
  }
  return result;
}

function validateAtomicUseCases(capabilities, base) {
  const useCasesById = new Map((capabilities?.useCases || []).map((item) => [item.id, item]));
  const statesById = new Map((capabilities?.interactionStates || []).map((item) => [item.id, item]));
  const stateIds = ids(capabilities?.interactionStates, 'capabilities.interactionStates');
  const flowIds = ids(capabilities?.interactionFlows, 'capabilities.interactionFlows');
  const transitionIds = ids((capabilities?.interactionFlows || []).flatMap((flow) => flow.transitions || []), 'capabilities.interactionFlows.transitions');
  const flowsByUseCase = new Map();
  const transitionsById = new Map((capabilities?.interactionFlows || []).flatMap((flow) => (flow.transitions || []).map((transition) => [transition.id, { flow, transition }])));
  const stateFlows = new Map([...stateIds].map((stateId) => [stateId, new Set()]));

  function stepsForUseCase(useCase) {
    return new Map([
      ...(useCase?.mainScenario || []).map((step) => [step.id, step]),
      ...(useCase?.alternateScenarios || []).flatMap((scenario) => scenario.steps.map((step) => [step.id, step])),
    ]);
  }

  function branchTriggerKey(useCase, transition, stepsById) {
    const tracedActorStep = transition.useCaseStepRefs.map((stepId) => stepsById.get(stepId)).find((step) => step?.initiator === 'actor');
    if (tracedActorStep) return tracedActorStep.action;
    const scenario = useCase?.alternateScenarios.find((item) => item.id === transition.scenarioRef);
    const origin = useCase?.mainScenario.find((step) => step.id === scenario?.startsAt && step.initiator === 'actor');
    return origin?.action || 'system:' + transition.scenarioRef;
  }

  for (const flow of capabilities?.interactionFlows || []) {
    const location = 'capabilities.interactionFlows.' + flow.id;
    if (!flow.id || !(flow.transitions || []).every((transition) => transition.id.startsWith(flow.id + '-TRANS-'))) {
      block('AIH_REFERENCE_UNRESOLVED', 'Transition ID 必须属于当前 Interaction Flow：' + flow.id, location + '.transitions');
    }
    requireReferences([flow.useCase], base.useCaseIds, location + '.useCase', 'Use Case');
    if (!flowsByUseCase.has(flow.useCase)) flowsByUseCase.set(flow.useCase, []);
    flowsByUseCase.get(flow.useCase).push(flow);
    const useCase = useCasesById.get(flow.useCase);
    if (useCase?.uiApplicability?.mode !== 'required') {
      block('AIH_ARTIFACT_INCOMPLETE', '非 UI Use Case 不得声明 Interaction Flow：' + flow.useCase, location);
    }
    const scenarioSteps = new Map();
    const stepsById = stepsForUseCase(useCase);
    if (useCase) {
      scenarioSteps.set('main', new Set(useCase.mainScenario.map((step) => step.id)));
      for (const scenario of useCase.alternateScenarios) scenarioSteps.set(scenario.id, new Set(scenario.steps.map((step) => step.id)));
    }
    requireReferences([flow.entryState, ...flow.completionStates], stateIds, location, 'Interaction State');
    for (const stateId of [flow.entryState, ...flow.completionStates]) stateFlows.get(stateId)?.add(flow);
    if (statesById.get(flow.entryState)?.terminal) block('AIH_ARTIFACT_INCOMPLETE', 'Interaction Flow 入口不能是终态：' + flow.entryState, location + '.entryState');
    for (const stateId of flow.completionStates) {
      if (statesById.has(stateId) && !statesById.get(stateId).terminal) block('AIH_ARTIFACT_INCOMPLETE', '完成状态必须是终态：' + stateId, location + '.completionStates');
    }
    for (const transition of flow.transitions || []) {
      const transitionLocation = location + '.transitions.' + transition.id;
      requireReferences([transition.scenarioRef], new Set(scenarioSteps.keys()), transitionLocation + '.scenarioRef', 'Use Case scenario');
      requireReferences(transition.useCaseStepRefs, scenarioSteps.get(transition.scenarioRef) || new Set(), transitionLocation, 'Use Case step');
      requireReferences([transition.from, transition.to], stateIds, transitionLocation, 'Interaction State');
      stateFlows.get(transition.from)?.add(flow);
      stateFlows.get(transition.to)?.add(flow);
      if (statesById.get(transition.from)?.terminal) block('AIH_ARTIFACT_INCOMPLETE', 'Transition 不能从终态发起：' + transition.id, transitionLocation + '.from');
      if (transition.failureResponse?.returnToState) requireReferences([transition.failureResponse.returnToState], stateIds, transitionLocation, 'returnToState');
    }
    for (const [scenarioRef, steps] of scenarioSteps) {
      const traced = new Set(flow.transitions.filter((item) => item.scenarioRef === scenarioRef).flatMap((item) => item.useCaseStepRefs));
      if (traced.size === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Interaction Flow 未覆盖场景：' + flow.useCase + ' / ' + scenarioRef, location + '.transitions');
      for (const stepId of steps) if (!traced.has(stepId)) block('AIH_ARTIFACT_INCOMPLETE', 'Use Case 步骤未追溯到 Transition：' + stepId, location + '.transitions');
      const scenario = useCase?.alternateScenarios.find((item) => item.id === scenarioRef);
      if (scenario?.type === 'exception' && !flow.transitions.some((item) => item.scenarioRef === scenarioRef && item.failureResponse)) {
        block('AIH_ARTIFACT_INCOMPLETE', '异常场景必须正式声明失败、重试、恢复与返回决定：' + scenarioRef, location + '.transitions');
      }
    }
    const groups = new Map();
    for (const transition of flow.transitions || []) {
      const key = transition.from + '\u0000' + branchTriggerKey(useCase, transition, stepsById);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(transition);
    }
    for (const transitions of groups.values()) {
      if (transitions.length === 1 && !transitions[0].guard) continue;
      const labels = new Set();
      for (const transition of transitions) {
        if (!transition.branchLabel) block('AIH_ARTIFACT_INCOMPLETE', '判断分支缺少 branchLabel：' + transition.id, location + '.transitions');
        else if (labels.has(transition.branchLabel)) block('AIH_ARTIFACT_INCOMPLETE', '同一判断的 branchLabel 必须唯一：' + transition.branchLabel, location + '.transitions');
        else labels.add(transition.branchLabel);
      }
    }
    const reachable = new Set([flow.entryState]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const transition of flow.transitions || []) if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to);
        changed = true;
      }
    }
    for (const transition of flow.transitions || []) if (!reachable.has(transition.from)) block('AIH_ARTIFACT_INCOMPLETE', 'Transition 起点无法从入口到达：' + transition.id, location + '.transitions');
    for (const stateId of flow.completionStates) if (!reachable.has(stateId)) block('AIH_ARTIFACT_INCOMPLETE', '完成状态无法从入口到达：' + stateId, location + '.completionStates');
  }

  for (const [stateId, flows] of stateFlows) {
    if (flows.size === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Interaction State 未被任何 Interaction Flow 使用：' + stateId, 'capabilities.interactionStates.' + stateId);
    const actors = new Set([...flows].map((flow) => useCasesById.get(flow.useCase)?.actor).filter(Boolean));
    if (actors.size > 1) block('AIH_REFERENCE_UNRESOLVED', '共享 Interaction State 只能用于同一 Actor 的 Use Case：' + stateId, 'capabilities.interactionStates.' + stateId);
  }

  const blueprintIds = ids(capabilities?.lowFiUiBlueprints, 'capabilities.lowFiUiBlueprints');
  const allScreenIds = new Set();
  const allRegionIds = new Set();
  const allControlIds = new Set();
  const screenUseCaseCounts = new Map();
  const blueprintActors = new Set();
  for (const blueprint of capabilities?.lowFiUiBlueprints || []) {
    const location = 'capabilities.lowFiUiBlueprints.' + blueprint.id;
    requireReferences([blueprint.actor], base.actorIds, location + '.actor', 'Actor');
    if (blueprintActors.has(blueprint.actor)) block('AIH_REFERENCE_UNRESOLVED', '同一 Actor 只能声明一个 Low-Fi UI Blueprint：' + blueprint.actor, location + '.actor');
    blueprintActors.add(blueprint.actor);
    const localScreenIds = new Set();
    const screenUseCases = new Set((blueprint.screens || []).flatMap((screen) => screen.useCases || []));
    requireReferences(screenUseCases, base.useCaseIds, location + '.screens', 'Use Case');
    for (const useCaseId of screenUseCases) {
      const useCase = useCasesById.get(useCaseId);
      if (useCase?.actor !== blueprint.actor) block('AIH_REFERENCE_UNRESOLVED', 'Low-Fi Blueprint 引用了其他 Actor 的 Use Case：' + useCaseId, location);
      if (useCase?.uiApplicability?.mode !== 'required') block('AIH_ARTIFACT_INCOMPLETE', '非 UI Use Case 不得进入 Low-Fi Blueprint：' + useCaseId, location);
    }
    for (const screen of blueprint.screens || []) {
      addUniqueId(screen.id, allScreenIds, location + '.screens');
      localScreenIds.add(screen.id);
      requireReferences(screen.useCases, screenUseCases, location + '.screens.' + screen.id, 'Blueprint Use Case');
      for (const useCaseId of screen.useCases) screenUseCaseCounts.set(useCaseId, (screenUseCaseCounts.get(useCaseId) || 0) + 1);
      const declaredRegions = new Set();
      for (const region of screen.regions || []) {
        addUniqueId(region.id, allRegionIds, location + '.screens.' + screen.id + '.regions');
        declaredRegions.add(region.id);
        for (const control of region.controls || []) {
          const controlLocation = location + '.screens.' + screen.id + '.controls.' + control.id;
          addUniqueId(control.id, allControlIds, controlLocation);
          if (['action', 'navigation', 'selection'].includes(control.type) && (control.transitionRefs || []).length === 0) {
            block('AIH_ARTIFACT_INCOMPLETE', '可交互 Low-Fi Control 必须追溯至少一个 Transition：' + control.id, controlLocation + '.transitionRefs');
          }
          for (const transitionId of control.transitionRefs || []) {
            const target = transitionsById.get(transitionId);
            if (!target) {
              block('AIH_REFERENCE_UNRESOLVED', 'Transition 引用不存在：' + transitionId, controlLocation + '.transitionRefs');
              continue;
            }
            const targetUseCase = useCasesById.get(target.flow.useCase);
            if (targetUseCase?.actor !== blueprint.actor) block('AIH_REFERENCE_UNRESOLVED', 'Low-Fi Control 引用了其他 Actor 的 Transition：' + transitionId, controlLocation + '.transitionRefs');
            if (!screen.useCases.includes(target.flow.useCase)) block('AIH_REFERENCE_UNRESOLVED', 'Low-Fi Control 引用的 Transition 不属于当前 Screen 的 Use Case：' + transitionId, controlLocation + '.transitionRefs');
          }
        }
      }
      const layoutRegions = layoutRegionReferences(screen.layoutTree);
      requireReferences(layoutRegions, declaredRegions, location + '.screens.' + screen.id + '.layoutTree', 'Region');
      for (const regionId of declaredRegions) if (layoutRegions.filter((id) => id === regionId).length !== 1) block('AIH_ARTIFACT_INCOMPLETE', 'Layout 必须且只能放置一次 Region：' + regionId, location + '.screens.' + screen.id + '.layoutTree');
    }
    validateInformationArchitecture(blueprint, localScreenIds);
    const presentedStates = new Set();
    for (const presentation of blueprint.statePresentations || []) {
      requireReferences([presentation.interactionState], stateIds, location + '.statePresentations', 'Interaction State');
      requireReferences([presentation.screen], localScreenIds, location + '.statePresentations', 'Low-Fi Screen');
      presentedStates.add(presentation.interactionState);
    }
    const relevantStates = new Set((capabilities?.interactionFlows || [])
      .filter((flow) => screenUseCases.has(flow.useCase))
      .flatMap((flow) => [flow.entryState, ...flow.completionStates, ...flow.transitions.flatMap((transition) => [transition.from, transition.to])]));
    for (const stateId of relevantStates) if (!presentedStates.has(stateId)) block('AIH_ARTIFACT_INCOMPLETE', 'Low-Fi Blueprint 未给出正式状态的呈现建议：' + stateId, location + '.statePresentations');

    const actorUiUseCases = (capabilities?.useCases || []).filter((useCase) => useCase.actor === blueprint.actor && useCase.uiApplicability?.mode === 'required');
    for (const useCase of actorUiUseCases) if (!screenUseCases.has(useCase.id)) {
      block('AIH_ARTIFACT_INCOMPLETE', 'Low-Fi Blueprint 的 Screen Use Case 并集未覆盖 Actor UI Use Case：' + useCase.id, location + '.screens');
    }

    const coveredTransitions = new Set((blueprint.screens || []).flatMap((screen) => (screen.regions || []).flatMap((region) => (region.controls || []).flatMap((control) => control.transitionRefs || []))));
    for (const flow of capabilities?.interactionFlows || []) {
      const useCase = useCasesById.get(flow.useCase);
      if (useCase?.actor !== blueprint.actor || !screenUseCases.has(flow.useCase)) continue;
      const stepsById = stepsForUseCase(useCase);
      for (const transition of flow.transitions || []) {
        const actorInitiated = transition.useCaseStepRefs.some((stepId) => stepsById.get(stepId)?.initiator === 'actor');
        if (actorInitiated && !coveredTransitions.has(transition.id)) {
          block('AIH_ARTIFACT_INCOMPLETE', 'Actor 发起的 Transition 缺少 Low-Fi Control 追溯：' + transition.id, location + '.screens');
        }
      }
    }
  }

  for (const useCase of capabilities?.useCases || []) {
    const flows = flowsByUseCase.get(useCase.id) || [];
    if (useCase.uiApplicability?.mode === 'required') {
      if (flows.length !== 1) block('AIH_ARTIFACT_INCOMPLETE', 'UI Use Case 必须且只能有一个正式 Interaction Flow：' + useCase.id, 'capabilities.interactionFlows');
      if (!screenUseCaseCounts.has(useCase.id)) block('AIH_ARTIFACT_INCOMPLETE', 'UI Use Case 必须映射到至少一个 Low-Fi Screen：' + useCase.id, 'capabilities.lowFiUiBlueprints');
    } else {
      if (flows.length > 0) block('AIH_ARTIFACT_INCOMPLETE', '非 UI Use Case 不得有 Interaction Flow：' + useCase.id, 'capabilities.interactionFlows');
      if (screenUseCaseCounts.has(useCase.id)) block('AIH_ARTIFACT_INCOMPLETE', '非 UI Use Case 不得进入 Low-Fi Screen：' + useCase.id, 'capabilities.lowFiUiBlueprints');
    }
  }
  return { useCasesById, stateIds, flowIds, transitionIds, flowsByUseCase, blueprintIds };
}

if (strict && !validSteps.has(readinessStep)) block('AIH_COMMAND_INVALID', '未知产品步骤：' + readinessStep, 'step');

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  const initializing = process.env.AI_HARNESS_INITIALIZING === 'product-design';
  if (!stage) throw Object.assign(new Error('项目未绑定 product-design。'), { code: 'AIH_PROJECT_BINDING_INVALID' });
  for (const item of await verifyPublishedProduct(root, project, manifest)) block(item.code, item.message, stage.publication?.receipt);
  if (stage.status === 'uninitialized' && !initializing) {
    const partial = await stageHasUserFiles(root, stage.root, [workspaceRootMarker(manifest)].filter(Boolean));
    if (partial) block('AIH_PARTIAL_INITIALIZATION', 'uninitialized 产品阶段包含用户文件。', stage.root);
    else if (strict) block('AIH_STAGE_UNINITIALIZED', '产品设计阶段尚未初始化。', stage.root);
    else warn('AIH_STAGE_UNINITIALIZED', '产品设计阶段尚未初始化，当前只验证空骨架。', stage.root);
  } else {
    const selected = strict
      ? new Set(collectDependencyArtifactIds(manifest, readinessStep))
      : new Set(manifest.artifactRegistry.filter((item) => item.stage === 'product-design').map((item) => item.id));
    const models = new Map();
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    for (const registry of manifest.artifactRegistry.filter((item) => item.stage === 'product-design')) {
      if (strict && !selected.has(registry.id)) continue;
      const paths = artifactPaths(project, registry.id, registry.stage);
      if (!paths) {
        block('AIH_PROJECT_BINDING_INVALID', '缺少 Artifact 绑定：' + registry.id, registry.id);
        continue;
      }
      try {
        const validate = ajv.compile(await readJson(root, registry.schema));
        if (['internal-model-set', 'area-set'].includes(registry.authorityKind)) {
          const members = [];
          for (const member of await artifactCollectionMembers(root, paths)) {
            const model = registry.authorityKind === 'area-set'
              ? await extractCanonicalUi(root, member.authorityPath)
              : await readStructured(root, member.authorityPath, registry.format);
            if ((registry.authorityKind === 'area-set' ? model.actor : model.metadata?.actor) !== member.actor) {
              block('AIH_REFERENCE_UNRESOLVED', '模型参与者与目录分区不一致：' + member.actor, member.authorityPath);
            }
            if (!validate(model)) for (const error of validate.errors || []) {
              block('AIH_ARTIFACT_SCHEMA_FAILED', error.instancePath + ' ' + error.message, member.authorityPath);
            }
            members.push({ ...member, data: model });
          }
          models.set(registry.id, members);
        } else {
          const model = registry.authorityKind === 'area'
            ? await extractCanonicalUi(root, paths.authorityPath)
            : await readStructured(root, paths.authorityPath, registry.format);
          models.set(registry.id, model);
          if (!validate(model)) {
            for (const error of validate.errors || []) block('AIH_ARTIFACT_SCHEMA_FAILED', error.instancePath + ' ' + error.message, registry.id);
          }
        }
      } catch (error) {
        block(error.code || 'AIH_ARTIFACT_SCHEMA_FAILED', error.message, paths.authorityPath);
      }
    }

    const capabilities = models.get('capabilities');
    const visualSpec = models.get('visual-spec');
    const canonicalMembers = models.get('canonical-ui-prototype') || [];
    const canonical = aggregateMembers(canonicalMembers);
    const base = validateCapabilities(capabilities);
    const { useCaseIds } = base;
    const { useCasesById, stateIds: interactionStateIds, flowIds: interactionFlowIds } = validateAtomicUseCases(capabilities, base);
    await validateVisualSpec(visualSpec, capabilities, stage);
    const actorIds = new Set((capabilities?.actors || []).map((actor) => actor.id));
    const expectedUiActors = new Set((capabilities?.useCases || []).filter((useCase) => useCase.uiApplicability?.mode === 'required').map((useCase) => useCase.actor));
    const canonicalActors = new Set();
    const canonicalActorByAssetId = new Map();
    for (const member of canonicalMembers) {
      const actor = member.data.actor;
      if (canonicalActors.has(actor)) block('AIH_REFERENCE_UNRESOLVED', '参与者存在多个 Canonical UI 独立应用：' + actor, member.authorityPath);
      canonicalActors.add(actor);
      requireReferences([actor], actorIds, member.authorityPath, 'Actor');
      const localUseCaseIds = new Set((capabilities?.useCases || []).filter((useCase) => useCase.actor === actor && useCase.uiApplicability?.mode === 'required').map((useCase) => useCase.id));
      const localFlows = (capabilities?.interactionFlows || []).filter((flow) => localUseCaseIds.has(flow.useCase));
      const localFlowIds = new Set(localFlows.map((flow) => flow.id));
      const localTransitions = localFlows.flatMap((flow) => flow.transitions || []);
      const localTransitionIds = new Set(localTransitions.map((transition) => transition.id));
      const localInteractionStateIds = new Set(localFlows.flatMap((flow) => [flow.entryState, ...flow.completionStates, ...flow.transitions.flatMap((transition) => [transition.from, transition.to])]));
      for (const state of member.data.states || []) if (state.scope === 'workflow') {
        requireReferences([state.id], localInteractionStateIds, member.authorityPath, '同参与者 Interaction State');
      }
      for (const scenario of member.data.scenarios || []) {
        const useCase = useCasesById.get(scenario.useCaseId);
        if (useCase && useCase.actor !== actor) block('AIH_REFERENCE_UNRESOLVED', 'Canonical UI 场景引用了其他参与者的 Use Case：' + scenario.useCaseId, member.authorityPath);
        requireReferences(scenario.interactionFlowIds, localFlowIds, member.authorityPath, '同参与者 Interaction Flow');
        requireReferences(scenario.transitionIds, localTransitionIds, member.authorityPath, '同参与者 Interaction Transition');
        requireReferences(scenario.recoveryStateIds, localInteractionStateIds, member.authorityPath, '恢复/返回 Interaction State');
      }
      for (const trace of member.data.traceability || []) {
        const useCase = useCasesById.get(trace.useCaseId);
        if (useCase && useCase.actor !== actor) block('AIH_REFERENCE_UNRESOLVED', 'Canonical UI 追溯了其他参与者的 Use Case：' + trace.useCaseId, member.authorityPath);
        requireReferences(trace.interactionFlowIds, localFlowIds, member.authorityPath, '同参与者 Interaction Flow 追溯');
      }
      for (const asset of member.data.assets || []) canonicalActorByAssetId.set(asset.id, actor);
      if (strict && readinessStep === 'canonical-ui-prototype') {
        if (member.data.visualPolicy.mode === 'unresolved') block('AIH_VISUAL_POLICY_UNRESOLVED', 'Canonical UI Prototype 尚未选择视觉策略。', member.authorityPath);
        if ((member.data.gaps || []).length > 0) block('AIH_ARTIFACT_INCOMPLETE', 'Canonical UI Prototype 仍有未决 gaps。', member.authorityPath);
        for (const transition of localTransitions) {
          const scenarios = (member.data.scenarios || []).filter((scenario) => (scenario.transitionIds || []).includes(transition.id));
          if (scenarios.length === 0) {
            block('AIH_CANONICAL_UI_FLOW_COVERAGE_FAILED', '正式分支没有可执行 UI HTML 场景：' + transition.id, member.authorityPath);
          }
          const returnState = transition.failureResponse?.returnToState;
          if (returnState && !scenarios.some((scenario) => (
            (scenario.recoveryStateIds || []).includes(returnState)
            && (scenario.expectedStateIds || []).includes(returnState)
          ))) {
            block('AIH_CANONICAL_UI_FLOW_COVERAGE_FAILED', '失败分支没有可执行恢复/返回路径：' + transition.id + ' → ' + returnState, member.authorityPath);
          }
        }
      }
    }
    if (strict && readinessStep === 'canonical-ui-prototype') {
      for (const actor of expectedUiActors) if (!canonicalActors.has(actor)) {
        block('AIH_ARTIFACT_INCOMPLETE', 'UI Actor 缺少一对一 Canonical UI 独立应用：' + actor, 'canonical-ui-prototype');
      }
    }

    if (canonical) {
      const designSourceIds = ids(canonical.designSources, 'canonical.designSources');
      const routeIds = ids(canonical.routes, 'canonical.routes');
      const screenIds = ids(canonical.screens, 'canonical.screens');
      const componentIds = ids(canonical.components, 'canonical.components');
      const componentInventoryIds = ids(canonical.componentInventory, 'canonical.componentInventory');
      const componentMappingIds = ids(canonical.componentMappings, 'canonical.componentMappings');
      ids(canonical.componentVariantCoverage, 'canonical.componentVariantCoverage');
      const controlIds = ids(canonical.controls, 'canonical.controls');
      const stateIds = ids(canonical.states, 'canonical.states');
      const eventIds = ids(canonical.events, 'canonical.events');
      ids(canonical.actions, 'canonical.actions');
      const scenarioIds = ids(canonical.scenarios, 'canonical.scenarios');
      ids(canonical.mockBehaviors, 'canonical.mockBehaviors');
      const viewportIds = ids(canonical.viewports, 'canonical.viewports');
      ids(canonical.renderAssertions, 'canonical.renderAssertions');
      ids(canonical.sourceParityAssertions, 'canonical.sourceParityAssertions');
      ids(canonical.motions, 'canonical.motions');
      const targetIds = new Set([...screenIds, ...componentIds, ...controlIds, ...stateIds]);
      const gapSourceIds = new Set(canonical.gaps.flatMap((item) => item.sourceIds || []));

      for (const source of canonical.designSources) {
        if (source.status === 'blocked' && !gapSourceIds.has(source.id)) {
          block('AIH_SOURCE_COVERAGE_FAILED', 'blocked 设计来源必须由 gap 关联：' + source.id, 'canonical.designSources.' + source.id);
        }
        if (source.status === 'partial' && canonical.visualPolicy.mode !== 'guided' && !gapSourceIds.has(source.id)) {
          block('AIH_SOURCE_COVERAGE_FAILED', '非部分参考模式的 partial 来源必须由 gap 关联：' + source.id, 'canonical.designSources.' + source.id);
        }
        for (const coverage of source.coverage) {
          requireReferences([coverage.screenId], screenIds, 'canonical.designSources.' + source.id, 'coverage.screenId');
          requireReferences(coverage.stateIds, stateIds, 'canonical.designSources.' + source.id, 'coverage.stateIds');
          requireReferences(coverage.viewportIds, viewportIds, 'canonical.designSources.' + source.id, 'coverage.viewportIds');
        }
      }
      for (const route of canonical.routes) requireReferences([route.screenId], screenIds, 'canonical.routes.' + route.id, 'screenId');
      for (const screen of canonical.screens) {
        requireReferences([screen.routeId], routeIds, 'canonical.screens.' + screen.id, 'routeId');
        requireReferences(screen.stateIds, stateIds, 'canonical.screens.' + screen.id, 'stateIds');
        requireReferences(screen.componentIds, componentIds, 'canonical.screens.' + screen.id, 'componentIds');
      }
      for (const component of canonical.components) {
        requireReferences(component.controlIds, controlIds, 'canonical.components.' + component.id, 'controlIds');
        requireReferences(component.stateIds, stateIds, 'canonical.components.' + component.id, 'stateIds');
      }
      const inventoriedNodes = new Set();
      for (const item of canonical.componentInventory) {
        requireReferences([item.sourceId], designSourceIds, 'canonical.componentInventory.' + item.id, 'sourceId');
        if (item.componentId) requireReferences([item.componentId], componentIds, 'canonical.componentInventory.' + item.id, 'componentId');
        for (const nodeId of item.nodeIds) {
          const key = item.sourceId + '/' + nodeId;
          if (inventoriedNodes.has(key)) {
            block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Figma 节点被多个组件抽象决定重复归类：' + key, 'canonical.componentInventory.' + item.id);
          }
          inventoriedNodes.add(key);
        }
      }
      for (const mapping of canonical.componentMappings) {
        requireReferences([mapping.componentId], componentIds, 'canonical.componentMappings.' + mapping.id, 'componentId');
        requireReferences([mapping.sourceId], designSourceIds, 'canonical.componentMappings.' + mapping.id, 'sourceId');
        requireReferences([mapping.inventoryId], componentInventoryIds, 'canonical.componentMappings.' + mapping.id, 'inventoryId');
        requireReferences(mapping.eventIds, eventIds, 'canonical.componentMappings.' + mapping.id, 'eventIds');
        const inventory = canonical.componentInventory.find((item) => item.id === mapping.inventoryId);
        if (
          !inventory
          || inventory.decision !== 'shared-component'
          || inventory.componentId !== mapping.componentId
          || inventory.sourceId !== mapping.sourceId
          || !inventory.nodeIds.includes(mapping.figmaComponentNodeId)
        ) {
          block('AIH_COMPONENT_MAPPING_INVALID', '组件映射与共享组件清单不一致：' + mapping.id, 'canonical.componentMappings.' + mapping.id);
        }
        const figmaProperties = new Set();
        const litProperties = new Set();
        const litAttributes = new Set();
        for (const property of mapping.propertyMappings) {
          if (figmaProperties.has(property.figmaProperty) || litProperties.has(property.litProperty)) {
            block('AIH_COMPONENT_MAPPING_INVALID', '组件属性映射重复：' + mapping.id + ' / ' + property.figmaProperty, 'canonical.componentMappings.' + mapping.id);
          }
          figmaProperties.add(property.figmaProperty);
          litProperties.add(property.litProperty);
          if (property.litAttribute) {
            if (litAttributes.has(property.litAttribute)) {
              block('AIH_COMPONENT_MAPPING_INVALID', '组件 Attribute 映射重复：' + mapping.id + ' / ' + property.litAttribute, 'canonical.componentMappings.' + mapping.id);
            }
            litAttributes.add(property.litAttribute);
          }
          const figmaValues = new Set();
          const litValues = new Set();
          for (const value of property.values) {
            if (figmaValues.has(value.figmaValue) || litValues.has(value.litValue)) {
              block('AIH_COMPONENT_MAPPING_INVALID', '组件属性值映射不是一对一：' + mapping.id + ' / ' + property.figmaProperty, 'canonical.componentMappings.' + mapping.id);
            }
            figmaValues.add(value.figmaValue);
            litValues.add(value.litValue);
          }
        }
        const slots = mapping.slotMappings.map((item) => item.litSlot);
        if (new Set(slots).size !== slots.length) {
          block('AIH_COMPONENT_MAPPING_INVALID', '组件 Slot 映射重复：' + mapping.id, 'canonical.componentMappings.' + mapping.id);
        }
      }
      const coveredInstances = new Set();
      for (const coverage of canonical.componentVariantCoverage) {
        requireReferences([coverage.mappingId], componentMappingIds, 'canonical.componentVariantCoverage.' + coverage.id, 'mappingId');
        requireReferences(coverage.screenIds, screenIds, 'canonical.componentVariantCoverage.' + coverage.id, 'screenIds');
        for (const nodeId of coverage.instanceNodeIds) {
          const key = coverage.mappingId + '/' + nodeId;
          if (coveredInstances.has(key)) {
            block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Instance 被多个 Variant 覆盖行重复登记：' + key, 'canonical.componentVariantCoverage.' + coverage.id);
          }
          coveredInstances.add(key);
        }
      }
      for (const control of canonical.controls) requireReferences([control.componentId], componentIds, 'canonical.controls.' + control.id, 'componentId');
      for (const state of canonical.states) {
        const owners = state.scope === 'workflow' ? screenIds : componentIds;
        requireReferences([state.ownerId], owners, 'canonical.states.' + state.id, 'ownerId');
        if (state.scope === 'workflow' && (strict || interactionStateIds.size > 0) && !interactionStateIds.has(state.id)) {
          block('AIH_REFERENCE_UNRESOLVED', 'workflow state 未追溯到正式 Interaction State：' + state.id, 'canonical.states.' + state.id);
        }
      }
      for (const event of canonical.events) requireReferences([event.controlId], controlIds, 'canonical.events.' + event.id, 'controlId');
      for (const action of canonical.actions) {
        requireReferences([action.eventId], eventIds, 'canonical.actions.' + action.id, 'eventId');
        requireReferences(action.resultingStateIds, stateIds, 'canonical.actions.' + action.id, 'resultingStateIds');
      }
      for (const scenario of canonical.scenarios) {
        if (strict || useCaseIds.size > 0) requireReferences([scenario.useCaseId], useCaseIds, 'canonical.scenarios.' + scenario.id, 'useCaseId');
        if (strict || interactionFlowIds.size > 0) requireReferences(scenario.interactionFlowIds, interactionFlowIds, 'canonical.scenarios.' + scenario.id, 'interactionFlowIds');
        requireReferences(scenario.transitionIds, new Set((capabilities?.interactionFlows || []).flatMap((flow) => flow.transitions.map((transition) => transition.id))), 'canonical.scenarios.' + scenario.id, 'transitionIds');
        requireReferences(scenario.recoveryStateIds, interactionStateIds, 'canonical.scenarios.' + scenario.id, 'recoveryStateIds');
        requireReferences([scenario.routeId], routeIds, 'canonical.scenarios.' + scenario.id, 'routeId');
        requireReferences(scenario.initialStateIds, stateIds, 'canonical.scenarios.' + scenario.id, 'initialStateIds');
        requireReferences(scenario.eventIds, eventIds, 'canonical.scenarios.' + scenario.id, 'eventIds');
        for (const eventId of scenario.eventIds) {
          const matchingActions = canonical.actions.filter((action) => action.eventId === eventId);
          if (matchingActions.length !== 1) {
            block(
              'AIH_REFERENCE_UNRESOLVED',
              '场景事件必须且只能对应一个动作：' + scenario.id + ' / ' + eventId + '，实际为 ' + matchingActions.length + ' 个。',
              'canonical.scenarios.' + scenario.id + '.eventIds',
            );
          }
        }
        requireReferences(scenario.expectedStateIds, stateIds, 'canonical.scenarios.' + scenario.id, 'expectedStateIds');
        requireReferences(scenario.viewportIds, viewportIds, 'canonical.scenarios.' + scenario.id, 'viewportIds');
      }
      for (const assertion of canonical.renderAssertions) {
        requireReferences([assertion.routeId], routeIds, 'canonical.renderAssertions.' + assertion.id, 'routeId');
        requireReferences(assertion.viewportIds, viewportIds, 'canonical.renderAssertions.' + assertion.id, 'viewportIds');
        if (assertion.scenarioId) requireReferences([assertion.scenarioId], scenarioIds, 'canonical.renderAssertions.' + assertion.id, 'scenarioId');
        for (const check of assertion.checks) {
          if (check.targetIds) requireReferences(check.targetIds, targetIds, 'canonical.renderAssertions.' + assertion.id, check.kind + '.targetIds');
          if (check.targetId) requireReferences([check.targetId], targetIds, 'canonical.renderAssertions.' + assertion.id, check.kind + '.targetId');
        }
      }
      for (const assertion of canonical.sourceParityAssertions) {
        requireReferences([assertion.sourceId], designSourceIds, 'canonical.sourceParityAssertions.' + assertion.id, 'sourceId');
        requireReferences([assertion.routeId], routeIds, 'canonical.sourceParityAssertions.' + assertion.id, 'routeId');
        requireReferences([assertion.viewportId], viewportIds, 'canonical.sourceParityAssertions.' + assertion.id, 'viewportId');
        if (assertion.scenarioId) requireReferences([assertion.scenarioId], scenarioIds, 'canonical.sourceParityAssertions.' + assertion.id, 'scenarioId');
        for (const check of assertion.checks) {
          if (check.targetId) requireReferences([check.targetId], targetIds, 'canonical.sourceParityAssertions.' + assertion.id, check.kind + '.targetId');
        }
      }
      for (const coverage of canonical.visualPolicy.coverage) {
        requireReferences([coverage.sourceId], designSourceIds, 'canonical.visualPolicy.coverage', 'sourceId');
        requireReferences([coverage.screenId], screenIds, 'canonical.visualPolicy.coverage', 'screenId');
        requireReferences(coverage.stateIds, stateIds, 'canonical.visualPolicy.coverage', 'stateIds');
        requireReferences(coverage.viewportIds, viewportIds, 'canonical.visualPolicy.coverage', 'viewportIds');
      }
      for (const trace of canonical.traceability) {
        if (strict || useCaseIds.size > 0) requireReferences([trace.useCaseId], useCaseIds, 'canonical.traceability.' + trace.useCaseId, 'useCaseId');
        if (strict || interactionFlowIds.size > 0) requireReferences(trace.interactionFlowIds, interactionFlowIds, 'canonical.traceability.' + trace.useCaseId, 'interactionFlowIds');
        requireReferences(trace.screenIds, screenIds, 'canonical.traceability.' + trace.useCaseId, 'screenIds');
        requireReferences(trace.controlIds, controlIds, 'canonical.traceability.' + trace.useCaseId, 'controlIds');
        requireReferences(trace.stateIds, stateIds, 'canonical.traceability.' + trace.useCaseId, 'stateIds');
      }
      for (const asset of canonical.assets) {
        requireReferences(asset.sourceIds, designSourceIds, 'canonical.assets.' + asset.id, 'sourceIds');
        requireReferences(asset.consumerTargets, targetIds, 'canonical.assets.' + asset.id, 'consumerTargets');
        const actor = canonicalActorByAssetId.get(asset.id);
        const canonicalPaths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
        const target = repositoryFile(root, canonicalPaths.authorityRoot + '/' + actor + '/' + asset.path);
        try {
          await access(target);
          if ('sha256' in asset && await fileSha256(target) !== asset.sha256) {
            block('AIH_ASSET_HASH_MISMATCH', 'Asset Manifest 内容哈希与正式文件不一致：' + asset.path, 'canonical.assets.' + asset.id);
          }
        } catch {
          block('AIH_ASSET_MISSING', '资源文件不存在：' + asset.path, 'canonical.assets.' + asset.id);
        }
      }
      for (const token of canonical.tokens) {
        requireReferences(token.sourceIds, designSourceIds, 'canonical.tokens.' + token.id, 'sourceIds');
        requireReferences(token.targetIds || [], targetIds, 'canonical.tokens.' + token.id, 'targetIds');
      }
      for (const gap of canonical.gaps) requireReferences(gap.sourceIds || [], designSourceIds, 'canonical.gaps.' + gap.id, 'sourceIds');
      if (strict && readinessStep === 'canonical-ui-prototype') {
        if (canonical.visualPolicy.mode === 'unresolved') block('AIH_VISUAL_POLICY_UNRESOLVED', 'Canonical UI Prototype 尚未选择视觉策略。', 'canonical.visualPolicy.mode');
        const alwaysRequired = { routes: canonical.routes, screens: canonical.screens, components: canonical.components, controls: canonical.controls, states: canonical.states, events: canonical.events, actions: canonical.actions, scenarios: canonical.scenarios, viewports: canonical.viewports, renderAssertions: canonical.renderAssertions, traceability: canonical.traceability };
        for (const [name, value] of Object.entries(alwaysRequired)) {
          if (value.length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Canonical UI Prototype 缺少：' + name, 'canonical.' + name);
        }
        if (['guided', 'exact'].includes(canonical.visualPolicy.mode)) {
          for (const [name, value] of Object.entries({ designSources: canonical.designSources, sourceParityAssertions: canonical.sourceParityAssertions })) {
            if (value.length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Canonical UI Prototype 缺少：' + name, 'canonical.' + name);
          }
        }
        if (canonical.gaps.length > 0) block('AIH_ARTIFACT_INCOMPLETE', 'Canonical UI Prototype 仍有未决 gaps。', 'canonical.gaps');
        for (const inventory of canonical.componentInventory.filter((item) => item.decision === 'shared-component')) {
          const mappings = canonical.componentMappings.filter((item) => item.inventoryId === inventory.id);
          if (mappings.length !== 1) {
            block(
              'AIH_COMPONENT_ABSTRACTION_UNRESOLVED',
              '共享组件抽象必须且只能对应一个 Figma ↔ Lit 映射：' + inventory.id + '，实际为 ' + mappings.length + ' 个。',
              'canonical.componentMappings',
            );
          }
        }
        for (const mapping of canonical.componentMappings) {
          if (!canonical.componentVariantCoverage.some((item) => item.mappingId === mapping.id)) {
            block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '组件映射缺少 Variant 覆盖行：' + mapping.id, 'canonical.componentVariantCoverage');
          }
        }
        for (const source of canonical.designSources) {
          if (source.status === 'blocked') block('AIH_SOURCE_CAPTURE_BLOCKED', '设计来源无法采集：' + source.id, 'canonical.designSources.' + source.id);
          else if (canonical.visualPolicy.mode === 'exact' && source.status !== 'available') block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式的设计来源未达到完整覆盖：' + source.id, 'canonical.designSources.' + source.id);
        }
        if (canonical.visualPolicy.mode === 'exact') for (const screen of canonical.screens) {
          const requiredStates = new Set(screen.stateIds);
          for (const componentId of screen.componentIds) {
            const component = canonical.components.find((item) => item.id === componentId);
            for (const stateId of component?.stateIds || []) requiredStates.add(stateId);
          }
          for (const stateId of requiredStates) {
            for (const viewportId of viewportIds) {
              const covered = canonical.designSources.some((source) => source.status === 'available' && source.coverage.some((coverage) => (
                coverage.screenId === screen.id
                && coverage.stateIds.includes(stateId)
                && coverage.viewportIds.includes(viewportId)
              )));
              if (!covered) block('AIH_SOURCE_COVERAGE_FAILED', '缺少设计来源覆盖：' + screen.id + ' / ' + stateId + ' / ' + viewportId, 'canonical.designSources');
            }
          }
        }
        for (const route of canonical.routes) {
          for (const viewportId of viewportIds) {
            const declared = canonical.renderAssertions.some((item) => !item.scenarioId && item.routeId === route.id && item.viewportIds.includes(viewportId));
            if (!declared) block('AIH_SOURCE_COVERAGE_FAILED', '路由缺少可执行渲染断言：' + route.id + ' / ' + viewportId, 'canonical.renderAssertions');
          }
        }
        for (const scenario of canonical.scenarios) {
          if (scenario.viewportIds.length === 0) {
            block('AIH_ARTIFACT_INCOMPLETE', '场景未绑定用户确认的运行环境：' + scenario.id, 'canonical.scenarios.' + scenario.id + '.viewportIds');
          }
          for (const viewportId of scenario.viewportIds) {
            const declared = canonical.renderAssertions.some((item) => item.scenarioId === scenario.id && item.routeId === scenario.routeId && item.viewportIds.includes(viewportId));
            if (!declared) block('AIH_SOURCE_COVERAGE_FAILED', '场景缺少可执行渲染断言：' + scenario.id + ' / ' + viewportId, 'canonical.renderAssertions');
          }
        }
      }
    }

    if (strict) {
      for (const artifactId of selected) {
        if (artifactId === 'canonical-ui-prototype') continue;
        const model = models.get(artifactId);
        if (artifactId === 'capabilities') {
          validateCapabilitiesReadiness(model);
          continue;
        }
        if (artifactId === 'visual-spec') {
          validateVisualSpecReadiness(model, capabilities);
          continue;
        }
      }
    }

    try {
      const drift = [
        ...await outputDrift(root, project, manifest, 'product-design', [...selected].filter((id) => id !== 'canonical-ui-prototype')),
        ...(selected.has('canonical-ui-prototype') ? await canonicalOutputDrift(root, project, manifest) : []),
      ];
      for (const item of drift) block('AIH_GENERATED_DRIFT', '投影与权威入口不一致。', item.output);
    } catch (error) {
      block(error.code || 'AIH_GENERATED_DRIFT', error.message, 'product projections');
    }
  }
} catch (error) {
  block(error.code || 'AIH_PROJECT_BINDING_INVALID', error.message);
}

const result = { status: blockers.length === 0 ? 'PASS' : 'BLOCKED', readinessStep, blockers, warnings };
if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Product Design Domain 校验通过。');
else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
if (result.status !== 'PASS') process.exitCode = 1;
