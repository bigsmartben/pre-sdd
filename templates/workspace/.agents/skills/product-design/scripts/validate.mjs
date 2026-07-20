import { access } from 'node:fs/promises';
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
import { outputDrift } from './lib/rendering.mjs';
import { extractCanonicalUi } from '../canonical-ui-prototype/scripts/extract.mjs';
import { canonicalOutputDrift } from '../canonical-ui-prototype/scripts/project.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const stepIndex = process.argv.indexOf('--step');
const readinessStep = process.argv.includes('--strict')
  ? 'canonical-ui-prototype'
  : stepIndex >= 0 ? process.argv[stepIndex + 1] : null;
const strict = readinessStep !== null;
const json = process.argv.includes('--json');
const validSteps = new Set(['use-cases', 'wireflow', 'canonical-ui-prototype']);
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

  for (const rule of capabilities?.businessRules || []) {
    requireReferences(rule.appliesTo, useCaseIds, 'capabilities.businessRules.' + rule.id + '.appliesTo', 'Use Case');
  }

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

  return { actorIds, businessRuleIds, useCaseIds, scenarioIds, stepIds };
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

function endpointKey(endpoint) {
  return endpoint?.screen + '::' + endpoint?.state;
}

function layoutRegionReferences(node, result = []) {
  if (!node) return result;
  if (node.type === 'region') result.push(node.region);
  else for (const child of node.children || []) layoutRegionReferences(child, result);
  return result;
}

function intersection(left, right) {
  const rightSet = new Set(right || []);
  return (left || []).filter((value) => rightSet.has(value));
}

function validateSiteMap(interactions, screenIds) {
  const siteMap = interactions?.siteMap || { entryScreen: null, nodes: [] };
  const siteMapScreenIds = new Set();
  for (const node of siteMap.nodes || []) {
    if (siteMapScreenIds.has(node.screen)) {
      block('AIH_REFERENCE_UNRESOLVED', 'Sitemap 重复放置 Screen：' + node.screen, 'interactions.siteMap.nodes');
    }
    siteMapScreenIds.add(node.screen);
  }
  requireReferences([...siteMapScreenIds], screenIds, 'interactions.siteMap.nodes', 'Screen');
  if (siteMap.entryScreen) requireReferences([siteMap.entryScreen], siteMapScreenIds, 'interactions.siteMap.entryScreen', 'Sitemap node');

  for (const screenId of screenIds) {
    if (!siteMapScreenIds.has(screenId)) {
      block('AIH_ARTIFACT_INCOMPLETE', 'Sitemap 未覆盖 Screen：' + screenId, 'interactions.siteMap.nodes');
    }
  }

  const roots = (siteMap.nodes || []).filter((node) => node.parent === null);
  if ((siteMap.nodes || []).length > 0 && roots.length !== 1) {
    block('AIH_ARTIFACT_INCOMPLETE', 'Sitemap 必须且只能有一个根页面，实际为 ' + roots.length + ' 个。', 'interactions.siteMap.nodes');
  }
  if (roots.length === 1 && siteMap.entryScreen !== roots[0].screen) {
    block('AIH_REFERENCE_UNRESOLVED', 'Sitemap 入口必须是根页面：' + siteMap.entryScreen, 'interactions.siteMap.entryScreen');
  }

  const children = new Map();
  for (const node of siteMap.nodes || []) {
    if (node.parent === null) continue;
    requireReferences([node.parent], siteMapScreenIds, 'interactions.siteMap.nodes.' + node.screen, 'parent');
    if (node.parent === node.screen) {
      block('AIH_REFERENCE_UNRESOLVED', 'Sitemap 页面不能以自身为父页面：' + node.screen, 'interactions.siteMap.nodes.' + node.screen);
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
      block('AIH_ARTIFACT_INCOMPLETE', 'Sitemap 页面无法从入口沿层级到达：' + screenId, 'interactions.siteMap.nodes');
    }
  }
}

function validateInteractionsReadiness(interactions) {
  const requiredSections = [
    ['Sitemap', interactions?.siteMap?.nodes],
    ['User Flow', interactions?.wireflows],
    ['Wireframe', interactions?.screens],
    ['交互状态', interactions?.interactionStates],
  ];
  for (const [label, value] of requiredSections) {
    if (!Array.isArray(value) || value.length === 0) {
      block('AIH_ARTIFACT_INCOMPLETE', 'Wireflow 缺少可评审的 ' + label + ' 内容。', 'interactions');
    }
  }
  if (interactions?.metadata?.status !== 'ready') block('AIH_ARTIFACT_INCOMPLETE', 'Wireflow 状态不是 ready。', 'interactions.metadata.status');
  if ((interactions?.gaps || []).length > 0) block('AIH_ARTIFACT_INCOMPLETE', 'Wireflow 仍有待确认问题。', 'interactions.gaps');
  if ((interactions?.gates || []).some((gate) => gate.checked !== true)) block('AIH_ARTIFACT_INCOMPLETE', 'Wireflow 仍有未通过门禁。', 'interactions.gates');
}

function readinessArtifacts(step) {
  if (step === 'use-cases') return new Set(['capabilities']);
  if (step === 'wireflow') return new Set(['capabilities', 'interactions']);
  return new Set(['capabilities', 'interactions', 'canonical-ui-prototype']);
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

if (strict && !validSteps.has(readinessStep)) block('AIH_COMMAND_INVALID', '未知产品步骤：' + readinessStep, 'step');

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  const initializing = process.env.AI_HARNESS_INITIALIZING === 'product-design';
  if (!stage) throw Object.assign(new Error('项目未绑定 product-design。'), { code: 'AIH_PROJECT_BINDING_INVALID' });
  if (stage.status === 'uninitialized' && !initializing) {
    const partial = await stageHasUserFiles(root, stage.root, [workspaceRootMarker(manifest)].filter(Boolean));
    if (partial) block('AIH_PARTIAL_INITIALIZATION', 'uninitialized 产品阶段包含用户文件。', stage.root);
    else if (strict) block('AIH_STAGE_UNINITIALIZED', '产品设计阶段尚未初始化。', stage.root);
    else warn('AIH_STAGE_UNINITIALIZED', '产品设计阶段尚未初始化，当前只验证空骨架。', stage.root);
  } else {
    const selected = readinessArtifacts(readinessStep);
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
    const interactionMembers = models.get('interactions') || [];
    const canonicalMembers = models.get('canonical-ui-prototype') || [];
    const interactions = aggregateMembers(interactionMembers);
    const canonical = aggregateMembers(canonicalMembers);
    const { useCaseIds } = validateCapabilities(capabilities);
    const useCasesById = new Map((capabilities?.useCases || []).map((useCase) => [useCase.id, useCase]));
    const actorIds = new Set((capabilities?.actors || []).map((actor) => actor.id));
    const expectedActors = new Set((capabilities?.useCases || []).map((useCase) => useCase.actor));
    const interactionActors = new Set();
    for (const member of interactionMembers) {
      const actor = member.data.metadata.actor;
      if (interactionActors.has(actor)) block('AIH_REFERENCE_UNRESOLVED', '参与者存在多份 Wireflow：' + actor, member.authorityPath);
      interactionActors.add(actor);
      requireReferences([actor], actorIds, member.authorityPath, 'Actor');
      const localScreens = new Set((member.data.screens || []).map((screen) => screen.id));
      validateSiteMap(member.data, localScreens);
      for (const flow of member.data.wireflows || []) {
        const useCase = useCasesById.get(flow.useCase);
        if (useCase && useCase.actor !== actor) block('AIH_REFERENCE_UNRESOLVED', 'Wireflow 引用了其他参与者的 Use Case：' + flow.useCase, member.authorityPath);
        requireReferences([flow.entry?.screen, ...(flow.steps || []).flatMap((step) => [step.from?.screen, step.to?.screen])], localScreens, member.authorityPath, '同参与者 Screen');
      }
      for (const state of member.data.interactionStates || []) requireReferences([state.screen], localScreens, member.authorityPath, '同参与者 Screen');
      for (const screen of member.data.screens || []) for (const useCaseId of screen.useCases || []) {
        const useCase = useCasesById.get(useCaseId);
        if (useCase && useCase.actor !== actor) block('AIH_REFERENCE_UNRESOLVED', 'Screen 引用了其他参与者的 Use Case：' + useCaseId, member.authorityPath);
      }
    }
    if (selected.has('interactions')) for (const actor of expectedActors) {
      if (!interactionActors.has(actor)) block('AIH_ARTIFACT_INCOMPLETE', '关键参与者缺少独立 Wireflow 模型：' + actor, 'interactions');
    }
    const wireflowIds = ids(interactions?.wireflows, 'interactions.wireflows');
    const wireflowStateIds = ids(interactions?.interactionStates, 'interactions.interactionStates');
    const wireflowScreenIds = ids(interactions?.screens, 'interactions.screens');
    const wireflowStepIds = ids((interactions?.wireflows || []).flatMap((flow) => flow.steps || []), 'interactions.wireflows.steps');
    const wireflowRegionIds = ids((interactions?.screens || []).flatMap((screen) => screen.regions || []), 'interactions.screens.regions');
    const wireflowControlIds = ids(
      (interactions?.screens || []).flatMap((screen) => (screen.regions || []).flatMap((region) => region.controls || [])),
      'interactions.screens.regions.controls',
    );
    const screensById = new Map((interactions?.screens || []).map((screen) => [screen.id, screen]));
    const statesById = new Map((interactions?.interactionStates || []).map((state) => [state.id, state]));
    const screenRegions = new Map((interactions?.screens || []).map((screen) => [
      screen.id,
      new Set((screen.regions || []).map((region) => region.id)),
    ]));
    const screenControls = new Map((interactions?.screens || []).map((screen) => [
      screen.id,
      new Set((screen.regions || []).flatMap((region) => (region.controls || []).map((control) => control.id))),
    ]));

    for (const screen of interactions?.screens || []) {
      requireReferences(screen.useCases, useCaseIds, 'interactions.screens.' + screen.id, 'useCases');
      const declaredRegions = screenRegions.get(screen.id) || new Set();
      const layoutRegions = layoutRegionReferences(screen.layoutTree);
      requireReferences(layoutRegions, declaredRegions, 'interactions.screens.' + screen.id + '.layoutTree', 'region');
      const layoutCounts = new Map();
      for (const regionId of layoutRegions) layoutCounts.set(regionId, (layoutCounts.get(regionId) || 0) + 1);
      for (const regionId of declaredRegions) {
        const count = layoutCounts.get(regionId) || 0;
        if (count !== 1) {
          block(
            'AIH_ARTIFACT_INCOMPLETE',
            '布局树必须且只能放置一次 Region：' + screen.id + ' / ' + regionId + '，实际为 ' + count + ' 次。',
            'interactions.screens.' + screen.id + '.layoutTree',
          );
        }
      }
    }

    for (const state of interactions?.interactionStates || []) {
      requireReferences([state.screen], wireflowScreenIds, 'interactions.interactionStates.' + state.id, 'screen');
      const localRegions = screenRegions.get(state.screen) || new Set();
      const localControls = screenControls.get(state.screen) || new Set();
      const localTargets = new Set([...localRegions, ...localControls]);
      const delta = state.stateDelta || { show: [], hide: [], enable: [], disable: [], content: [] };
      requireReferences(delta.show, localTargets, 'interactions.interactionStates.' + state.id + '.stateDelta', 'show');
      requireReferences(delta.hide, localTargets, 'interactions.interactionStates.' + state.id + '.stateDelta', 'hide');
      requireReferences(delta.enable, localControls, 'interactions.interactionStates.' + state.id + '.stateDelta', 'enable');
      requireReferences(delta.disable, localControls, 'interactions.interactionStates.' + state.id + '.stateDelta', 'disable');
      requireReferences((delta.content || []).map((item) => item.target), localTargets, 'interactions.interactionStates.' + state.id + '.stateDelta', 'content.target');
      if ((delta.show?.length || 0) + (delta.hide?.length || 0) + (delta.enable?.length || 0) + (delta.disable?.length || 0) + (delta.content?.length || 0) === 0) {
        block('AIH_ARTIFACT_INCOMPLETE', '交互状态必须声明至少一项可见状态差量：' + state.id, 'interactions.interactionStates.' + state.id + '.stateDelta');
      }
      for (const target of intersection(delta.show, delta.hide)) {
        block('AIH_ARTIFACT_INCOMPLETE', '同一状态不能同时 show 和 hide：' + state.id + ' / ' + target, 'interactions.interactionStates.' + state.id + '.stateDelta');
      }
      for (const controlId of intersection(delta.enable, delta.disable)) {
        block('AIH_ARTIFACT_INCOMPLETE', '同一状态不能同时 enable 和 disable：' + state.id + ' / ' + controlId, 'interactions.interactionStates.' + state.id + '.stateDelta');
      }
    }

    for (const flow of interactions?.wireflows || []) {
      const location = 'interactions.wireflows.' + flow.id;
      const useCase = useCasesById.get(flow.useCase);
      if ((strict || useCaseIds.size > 0) && !useCase) block('AIH_REFERENCE_UNRESOLVED', 'Wireflow 引用未知 Use Case：' + flow.useCase, location);
      const scenarioSteps = new Map();
      if (useCase) {
        scenarioSteps.set('main', new Set(useCase.mainScenario.map((step) => step.id)));
        for (const scenario of useCase.alternateScenarios) scenarioSteps.set(scenario.id, new Set(scenario.steps.map((step) => step.id)));
      }
      requireReferences(flow.coveredScenarios, new Set(scenarioSteps.keys()), location, 'coveredScenarios');
      requireReferences([flow.entry?.screen], wireflowScreenIds, location + '.entry', 'screen');
      requireReferences([flow.entry?.state], wireflowStateIds, location + '.entry', 'state');
      const entryState = statesById.get(flow.entry?.state);
      if (entryState && entryState.screen !== flow.entry.screen) block('AIH_REFERENCE_UNRESOLVED', '入口 Screen 与 State 归属不一致：' + flow.id, location + '.entry');
      if (entryState?.terminal) block('AIH_ARTIFACT_INCOMPLETE', 'Wireflow 入口不能是终态：' + flow.id + ' / ' + entryState.id, location + '.entry');
      requireReferences(flow.completionStates, wireflowStateIds, 'interactions.wireflows.' + flow.id, 'completionStates');
      for (const stateId of flow.completionStates || []) {
        const state = statesById.get(stateId);
        if (state && !state.terminal) block('AIH_ARTIFACT_INCOMPLETE', '完成状态必须是终态：' + flow.id + ' / ' + stateId, location + '.completionStates');
      }

      for (const step of flow.steps || []) {
        const stepLocation = location + '.steps.' + step.id;
        if (!flow.coveredScenarios?.includes(step.scenarioRef)) block('AIH_REFERENCE_UNRESOLVED', '步骤场景未列入 coveredScenarios：' + step.scenarioRef, stepLocation);
        const availableSteps = scenarioSteps.get(step.scenarioRef) || new Set();
        requireReferences(step.useCaseStepRefs, availableSteps, stepLocation, 'useCaseStepRefs');
        for (const [label, endpoint] of [['from', step.from], ['to', step.to]]) {
          requireReferences([endpoint?.screen], wireflowScreenIds, stepLocation + '.' + label, 'screen');
          requireReferences([endpoint?.state], wireflowStateIds, stepLocation + '.' + label, 'state');
          const state = statesById.get(endpoint?.state);
          if (state && state.screen !== endpoint.screen) block('AIH_REFERENCE_UNRESOLVED', label + ' Screen 与 State 归属不一致：' + step.id, stepLocation + '.' + label);
        }
        const triggerControl = step.trigger?.control;
        const fromState = statesById.get(step.from?.state);
        if (fromState?.terminal) block('AIH_ARTIFACT_INCOMPLETE', '迁移不能从终态发起：' + step.id + ' / ' + fromState.id, stepLocation + '.from');
        if (triggerControl) {
          requireReferences([triggerControl], screenControls.get(step.from?.screen) || new Set(), stepLocation + '.trigger', 'control');
          if (fromState && !fromState.stateDelta?.enable?.includes(triggerControl)) {
            block('AIH_ARTIFACT_INCOMPLETE', '触发 Control 在起始状态未启用：' + step.id + ' / ' + triggerControl, stepLocation + '.trigger');
          }
        }
      }

      const transitionGroups = new Map();
      for (const step of flow.steps || []) {
        const triggerKey = step.trigger?.control || 'system:' + step.trigger?.event;
        const groupKey = step.from?.state + '\u0000' + triggerKey;
        if (!transitionGroups.has(groupKey)) transitionGroups.set(groupKey, []);
        transitionGroups.get(groupKey).push(step);
      }
      for (const steps of transitionGroups.values()) {
        const requiresDecision = steps.length > 1 || steps.some((step) => step.guard);
        if (!requiresDecision) continue;
        const labels = new Set();
        for (const step of steps) {
          const label = step.branchLabel?.trim();
          if (!label) {
            block('AIH_ARTIFACT_INCOMPLETE', '判断分支缺少简短 branchLabel：' + step.id, location + '.steps.' + step.id + '.branchLabel');
            continue;
          }
          if (labels.has(label)) {
            block('AIH_ARTIFACT_INCOMPLETE', '同一判断的 branchLabel 必须唯一：' + flow.id + ' / ' + label, location + '.steps');
          }
          labels.add(label);
        }
      }

      for (const scenarioId of flow.coveredScenarios || []) {
        if (!(flow.steps || []).some((step) => step.scenarioRef === scenarioId)) {
          block('AIH_ARTIFACT_INCOMPLETE', 'coveredScenarios 中的场景缺少 Wireflow 步骤：' + flow.id + ' / ' + scenarioId, location + '.steps');
        }
      }

      const reachable = new Set([endpointKey(flow.entry)]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const step of flow.steps || []) {
          if (reachable.has(endpointKey(step.from)) && !reachable.has(endpointKey(step.to))) {
            reachable.add(endpointKey(step.to));
            changed = true;
          }
        }
      }
      for (const step of flow.steps || []) {
        if (!reachable.has(endpointKey(step.from))) block('AIH_ARTIFACT_INCOMPLETE', '迁移起点无法从 Wireflow 入口到达：' + step.id, location + '.steps.' + step.id + '.from');
      }
      for (const stateId of flow.completionStates || []) {
        const state = statesById.get(stateId);
        if (state && !reachable.has(endpointKey({ screen: state.screen, state: state.id }))) {
          block('AIH_ARTIFACT_INCOMPLETE', '完成状态无法从 Wireflow 入口到达：' + flow.id + ' / ' + stateId, location + '.completionStates');
        }
      }
    }

    for (const useCase of interactions ? (capabilities?.useCases || []) : []) {
      const expectedScenarios = new Set(['main', ...useCase.alternateScenarios.map((scenario) => scenario.id)]);
      const coveredScenarios = new Set((interactions?.wireflows || [])
        .filter((flow) => flow.useCase === useCase.id)
        .flatMap((flow) => flow.coveredScenarios || []));
      for (const scenarioId of expectedScenarios) {
        if (!coveredScenarios.has(scenarioId)) block('AIH_ARTIFACT_INCOMPLETE', 'Use Case 场景未被 Wireflow 覆盖：' + useCase.id + ' / ' + scenarioId, 'interactions.wireflows');
      }
    }

    const canonicalActors = new Set();
    const canonicalActorByAssetId = new Map();
    const interactionByActor = new Map(interactionMembers.map((member) => [member.actor, member.data]));
    for (const member of canonicalMembers) {
      const actor = member.data.actor;
      if (canonicalActors.has(actor)) block('AIH_REFERENCE_UNRESOLVED', '参与者存在多个 Canonical UI 独立应用：' + actor, member.authorityPath);
      canonicalActors.add(actor);
      if (!interactionByActor.has(actor)) block('AIH_REFERENCE_UNRESOLVED', 'Canonical UI 没有同参与者 Wireflow：' + actor, member.authorityPath);
      const localInteractions = interactionByActor.get(actor);
      const localScreens = new Set((localInteractions?.screens || []).map((screen) => screen.id));
      const localControls = new Set((localInteractions?.screens || []).flatMap((screen) => screen.regions || []).flatMap((region) => region.controls || []).map((control) => control.id));
      const localWireflowIds = new Set((localInteractions?.wireflows || []).map((flow) => flow.id));
      const localWireflowStateIds = new Set((localInteractions?.interactionStates || []).map((state) => state.id));
      const localWireflowReferences = new Set([...localWireflowIds, ...localWireflowStateIds]);
      requireReferences((member.data.screens || []).map((screen) => screen.id), localScreens, member.authorityPath, '同参与者 Wireflow screen');
      requireReferences((member.data.controls || []).map((control) => control.id), localControls, member.authorityPath, '同参与者 Wireflow control');
      for (const state of member.data.states || []) if (state.scope === 'workflow') {
        requireReferences([state.id], localWireflowStateIds, member.authorityPath, '同参与者 Wireflow workflow state');
      }
      for (const scenario of member.data.scenarios || []) {
        const useCase = useCasesById.get(scenario.useCaseId);
        if (useCase && useCase.actor !== actor) block('AIH_REFERENCE_UNRESOLVED', 'Canonical UI 场景引用了其他参与者的 Use Case：' + scenario.useCaseId, member.authorityPath);
        requireReferences(scenario.wireflowIds, localWireflowReferences, member.authorityPath, '同参与者 Wireflow 场景');
      }
      for (const trace of member.data.traceability || []) {
        const useCase = useCasesById.get(trace.useCaseId);
        if (useCase && useCase.actor !== actor) block('AIH_REFERENCE_UNRESOLVED', 'Canonical UI 追溯了其他参与者的 Use Case：' + trace.useCaseId, member.authorityPath);
        requireReferences(trace.wireflowIds, localWireflowReferences, member.authorityPath, '同参与者 Wireflow 追溯');
      }
      for (const asset of member.data.assets || []) canonicalActorByAssetId.set(asset.id, actor);
      if (strict && readinessStep === 'canonical-ui-prototype') {
        if (member.data.visualPolicy.mode === 'unresolved') block('AIH_VISUAL_POLICY_UNRESOLVED', 'Canonical UI Prototype 尚未选择视觉策略。', member.authorityPath);
        if ((member.data.gaps || []).length > 0) block('AIH_ARTIFACT_INCOMPLETE', 'Canonical UI Prototype 仍有未决 gaps。', member.authorityPath);
      }
    }
    if (strict && readinessStep === 'canonical-ui-prototype') {
      for (const actor of interactionActors) if (!canonicalActors.has(actor)) {
        block('AIH_ARTIFACT_INCOMPLETE', 'Wireflow 缺少一对一 Canonical UI 独立应用：' + actor, 'canonical-ui-prototype');
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

      if (strict || wireflowScreenIds.size > 0) requireReferences(screenIds, wireflowScreenIds, 'canonical.screens', 'Wireflow screen');
      if (strict || wireflowControlIds.size > 0) requireReferences(controlIds, wireflowControlIds, 'canonical.controls', 'Wireflow control');

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
        if (state.scope === 'workflow' && (strict || wireflowStateIds.size > 0) && !wireflowStateIds.has(state.id)) {
          block('AIH_REFERENCE_UNRESOLVED', 'workflow state 未追溯到 Wireflow：' + state.id, 'canonical.states.' + state.id);
        }
      }
      for (const event of canonical.events) requireReferences([event.controlId], controlIds, 'canonical.events.' + event.id, 'controlId');
      for (const action of canonical.actions) {
        requireReferences([action.eventId], eventIds, 'canonical.actions.' + action.id, 'eventId');
        requireReferences(action.resultingStateIds, stateIds, 'canonical.actions.' + action.id, 'resultingStateIds');
      }
      for (const scenario of canonical.scenarios) {
        if (strict || useCaseIds.size > 0) requireReferences([scenario.useCaseId], useCaseIds, 'canonical.scenarios.' + scenario.id, 'useCaseId');
        if (strict || wireflowIds.size + wireflowStateIds.size > 0) requireReferences(scenario.wireflowIds, new Set([...wireflowIds, ...wireflowStateIds]), 'canonical.scenarios.' + scenario.id, 'wireflowIds');
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
        if (strict || wireflowIds.size + wireflowStateIds.size > 0) requireReferences(trace.wireflowIds, new Set([...wireflowIds, ...wireflowStateIds]), 'canonical.traceability.' + trace.useCaseId, 'wireflowIds');
        requireReferences(trace.screenIds, screenIds, 'canonical.traceability.' + trace.useCaseId, 'screenIds');
        requireReferences(trace.controlIds, controlIds, 'canonical.traceability.' + trace.useCaseId, 'controlIds');
        requireReferences(trace.stateIds, stateIds, 'canonical.traceability.' + trace.useCaseId, 'stateIds');
      }
      for (const asset of canonical.assets) {
        requireReferences(asset.sourceIds, designSourceIds, 'canonical.assets.' + asset.id, 'sourceIds');
        requireReferences(asset.usageTargetIds, targetIds, 'canonical.assets.' + asset.id, 'usageTargetIds');
        const actor = canonicalActorByAssetId.get(asset.id);
        const canonicalPaths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
        const target = repositoryFile(root, canonicalPaths.authorityRoot + '/' + actor + '/' + asset.path);
        try { await access(target); } catch { block('AIH_SOURCE_INTEGRITY_FAILED', '资源文件不存在：' + asset.path, 'canonical.assets.' + asset.id); }
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
        if (artifactId === 'interactions') {
          for (const member of model || []) validateInteractionsReadiness(member.data);
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
