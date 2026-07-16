import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
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
const validSteps = new Set(['product-overview', 'use-cases', 'wireflow', 'canonical-ui-prototype']);
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

function readinessArtifacts(step) {
  if (step === 'product-overview') return new Set(['product-package']);
  if (step === 'use-cases') return new Set(['product-package', 'capabilities']);
  if (step === 'wireflow') return new Set(['product-package', 'capabilities', 'interactions']);
  return new Set(['product-package', 'capabilities', 'interactions', 'canonical-ui-prototype']);
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
        const model = registry.authorityKind === 'area'
          ? await extractCanonicalUi(root, paths.authorityPath)
          : await readStructured(root, paths.authorityPath, registry.format);
        models.set(registry.id, model);
        const validate = ajv.compile(await readJson(root, registry.schema));
        if (!validate(model)) {
          for (const error of validate.errors || []) block('AIH_ARTIFACT_SCHEMA_FAILED', error.instancePath + ' ' + error.message, registry.id);
        }
      } catch (error) {
        block(error.code || 'AIH_ARTIFACT_SCHEMA_FAILED', error.message, paths.authorityPath);
      }
    }

    const product = models.get('product-package');
    const capabilities = models.get('capabilities');
    const interactions = models.get('interactions');
    const canonical = models.get('canonical-ui-prototype');
    if (product && JSON.stringify(product.primaryChain) !== JSON.stringify(['capabilities', 'interactions', 'canonical-ui-prototype'])) {
      block('AIH_REFERENCE_UNRESOLVED', 'Product Package 主链必须为 capabilities → interactions → canonical-ui-prototype。', 'product-package.primaryChain');
    }

    const useCaseIds = ids(capabilities?.useCases, 'capabilities.useCases');
    const wireflowIds = ids(interactions?.wireflows, 'interactions.wireflows');
    const wireflowStateIds = ids(interactions?.interactionStates, 'interactions.interactionStates');
    const wireflowScreenIds = ids(interactions?.screens, 'interactions.screens');
    const wireflowControlIds = new Set((interactions?.screens || []).flatMap((screen) => (screen.controls || []).map((control) => control.id)));
    for (const flow of interactions?.wireflows || []) {
      if ((strict || useCaseIds.size > 0) && !useCaseIds.has(flow.useCase)) block('AIH_REFERENCE_UNRESOLVED', 'Wireflow 引用未知 Use Case：' + flow.useCase, 'interactions.wireflows.' + flow.id);
      requireReferences(flow.completionStates, wireflowStateIds, 'interactions.wireflows.' + flow.id, 'completionStates');
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
        const target = repositoryFile(root, stage.root + '/' + stage.areas['canonical-ui-prototype'].root + '/' + asset.path);
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
        if (model?.metadata?.status !== 'ready' || (model?.gaps || []).length > 0 || (model?.gates || []).some((gate) => gate.checked !== true)) {
          block('AIH_ARTIFACT_INCOMPLETE', '上游产物未达到严格就绪：' + artifactId, artifactId);
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
