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
      const controlIds = ids(canonical.controls, 'canonical.controls');
      const stateIds = ids(canonical.states, 'canonical.states');
      const eventIds = ids(canonical.events, 'canonical.events');
      ids(canonical.actions, 'canonical.actions');
      const scenarioIds = ids(canonical.scenarios, 'canonical.scenarios');
      ids(canonical.mockBehaviors, 'canonical.mockBehaviors');
      const viewportIds = ids(canonical.viewports, 'canonical.viewports');
      ids(canonical.visualAssertions, 'canonical.visualAssertions');
      ids(canonical.motions, 'canonical.motions');
      const targetIds = new Set([...screenIds, ...componentIds, ...controlIds, ...stateIds]);
      const availableSourceIds = new Set(canonical.designSources.filter((item) => item.status === 'available').map((item) => item.id));
      const gapSourceIds = new Set(canonical.gaps.flatMap((item) => item.sourceIds || []));

      for (const source of canonical.designSources) {
        if (source.status !== 'available' && !gapSourceIds.has(source.id)) {
          block('AIH_SOURCE_COVERAGE_FAILED', 'partial 或 blocked 设计来源必须由 gap 关联：' + source.id, 'canonical.designSources.' + source.id);
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
      for (const assertion of canonical.visualAssertions) {
        requireReferences([assertion.routeId], routeIds, 'canonical.visualAssertions.' + assertion.id, 'routeId');
        requireReferences(assertion.viewportIds, viewportIds, 'canonical.visualAssertions.' + assertion.id, 'viewportIds');
        requireReferences(assertion.sourceIds, designSourceIds, 'canonical.visualAssertions.' + assertion.id, 'sourceIds');
        if (assertion.scenarioId) requireReferences([assertion.scenarioId], scenarioIds, 'canonical.visualAssertions.' + assertion.id, 'scenarioId');
        for (const check of assertion.checks) {
          if (check.targetIds) requireReferences(check.targetIds, targetIds, 'canonical.visualAssertions.' + assertion.id, check.kind + '.targetIds');
          if (check.targetId) requireReferences([check.targetId], targetIds, 'canonical.visualAssertions.' + assertion.id, check.kind + '.targetId');
        }
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
      for (const token of canonical.tokens) requireReferences(token.sourceIds, designSourceIds, 'canonical.tokens.' + token.id, 'sourceIds');
      for (const gap of canonical.gaps) requireReferences(gap.sourceIds || [], designSourceIds, 'canonical.gaps.' + gap.id, 'sourceIds');
      if (strict && readinessStep === 'canonical-ui-prototype') {
        for (const [name, value] of Object.entries({ designSources: canonical.designSources, tokens: canonical.tokens, routes: canonical.routes, screens: canonical.screens, components: canonical.components, controls: canonical.controls, states: canonical.states, events: canonical.events, actions: canonical.actions, scenarios: canonical.scenarios, viewports: canonical.viewports, visualAssertions: canonical.visualAssertions, traceability: canonical.traceability })) {
          if (value.length === 0) block('AIH_ARTIFACT_INCOMPLETE', 'Canonical UI Prototype 缺少：' + name, 'canonical.' + name);
        }
        if (canonical.gaps.length > 0) block('AIH_ARTIFACT_INCOMPLETE', 'Canonical UI Prototype 仍有未决 gaps。', 'canonical.gaps');
        for (const source of canonical.designSources) {
          if (source.status === 'blocked') block('AIH_SOURCE_CAPTURE_BLOCKED', '设计来源无法采集：' + source.id, 'canonical.designSources.' + source.id);
          else if (source.status !== 'available') block('AIH_SOURCE_COVERAGE_FAILED', '设计来源未达到完整覆盖：' + source.id, 'canonical.designSources.' + source.id);
        }
        for (const screen of canonical.screens) {
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
            const declared = canonical.visualAssertions.some((item) => !item.scenarioId && item.routeId === route.id && item.viewportIds.includes(viewportId) && item.sourceIds.every((id) => availableSourceIds.has(id)));
            if (!declared) block('AIH_SOURCE_COVERAGE_FAILED', '路由缺少可执行视觉断言：' + route.id + ' / ' + viewportId, 'canonical.visualAssertions');
          }
        }
        for (const scenario of canonical.scenarios) {
          for (const viewportId of scenario.viewportIds) {
            const declared = canonical.visualAssertions.some((item) => item.scenarioId === scenario.id && item.routeId === scenario.routeId && item.viewportIds.includes(viewportId) && item.sourceIds.every((id) => availableSourceIds.has(id)));
            if (!declared) block('AIH_SOURCE_COVERAGE_FAILED', '场景缺少可执行视觉断言：' + scenario.id + ' / ' + viewportId, 'canonical.visualAssertions');
          }
        }
        if (!canonical.viewports.some((item) => item.width < 768) || !canonical.viewports.some((item) => item.width >= 1024)) {
          block('AIH_ARTIFACT_INCOMPLETE', '必须声明移动端和桌面端视口。', 'canonical.viewports');
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
