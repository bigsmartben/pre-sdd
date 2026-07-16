import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifactPaths, loadProjectAndManifest, readJson, readStructured, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const blockers = [];

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

async function sha256(path) {
  return 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
}

function sourceLocation(source) {
  return 'designSources.' + source.id;
}

function areaFile(areaDirectory, path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw Object.assign(new Error('证据路径必须位于 Canonical UI Prototype Area 内：' + String(path)), { code: 'AIH_SOURCE_INTEGRITY_FAILED' });
  }
  const target = resolve(areaDirectory, ...path.split('/'));
  if (target !== areaDirectory && !target.startsWith(areaDirectory + sep)) {
    throw Object.assign(new Error('证据路径越出 Canonical UI Prototype Area：' + path), { code: 'AIH_SOURCE_INTEGRITY_FAILED' });
  }
  return target;
}

function figmaNodeId(location) {
  try {
    const url = new URL(location);
    if (!/^\/(?:design)\//.test(url.pathname)) return null;
    const raw = url.searchParams.get('node-id');
    return /^[0-9]+[-:][0-9]+$/.test(raw || '') ? raw.replace('-', ':') : null;
  } catch {
    return null;
  }
}

function sameSourceVersion(left, right) {
  return left?.kind === right?.kind && left?.value === right?.value;
}

function sameStringRecord(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  if (stage?.status !== 'active') throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  for (const artifactId of ['product-package', 'capabilities', 'interactions']) {
    const registry = manifest.artifactRegistry.find((item) => item.id === artifactId);
    const paths = artifactPaths(project, artifactId, 'product-design');
    const model = await readStructured(root, paths.authorityPath, registry.format);
    if (model.metadata?.status !== 'ready' || model.gaps?.length > 0 || model.gates?.some((gate) => gate.checked !== true)) {
      block('AIH_UPSTREAM_NOT_READY', '上游产物未达到严格就绪：' + artifactId, paths.authorityPath);
    }
  }

  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const model = await extractCanonicalUi(root, paths.authorityPath);
  const areaPath = stage.root + '/' + stage.areas[paths.area].root;
  const areaDirectory = repositoryFile(root, areaPath);
  const evidenceSchema = await readJson(root, '.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json');
  const validateEvidence = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(evidenceSchema);
  const figmaContextSchema = await readJson(root, '.agents/skills/capture-figma-design-source/figma-design-context.schema.json');
  const validateFigmaContext = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(figmaContextSchema);
  const evidenceAssets = new Map();
  const evidenceItems = new Map();
  const figmaContexts = new Map();
  const policy = model.visualPolicy || { mode: 'unresolved', aspects: [], coverage: [] };

  if (policy.mode === 'unresolved') {
    block('AIH_VISUAL_POLICY_UNRESOLVED', '开始界面实现前必须选择自主设计、部分参考或完全实现。', 'visualPolicy.mode');
  }
  if (policy.mode === 'autonomous' && (model.designSources.length > 0 || model.sourceParityAssertions.length > 0)) {
    block('AIH_VISUAL_DEVIATION_UNAPPROVED', '自主设计模式不得保留未声明用途的视觉来源一致性要求。', 'visualPolicy');
  }
  if ((policy.mode === 'guided' || policy.mode === 'exact') && model.designSources.length === 0) {
    block('AIH_VISUAL_SOURCE_REQUIRED', '部分参考或完全实现模式必须声明至少一个视觉来源。', 'designSources');
  }
  if ((policy.mode === 'guided' || policy.mode === 'exact') && model.sourceParityAssertions.length === 0) {
    block('AIH_VISUAL_STYLE_BINDING_FAILED', '视觉参考模式必须声明来源到实际页面的可执行一致性断言。', 'sourceParityAssertions');
  }

  for (const source of model.designSources) {
    const location = sourceLocation(source);
    if (source.status === 'blocked') {
      block('AIH_SOURCE_CAPTURE_BLOCKED', '设计来源无法采集：' + source.id, location);
      continue;
    }
    if (source.status === 'partial' && policy.mode === 'exact') {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式不接受局部设计来源：' + source.id, location);
    }
    const expectedNodeId = source.kind === 'figma' ? figmaNodeId(source.location) : null;
    if (source.kind === 'figma' && !expectedNodeId) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma 来源必须是带 node-id 的 /design/ 节点链接：' + source.id, location);
      continue;
    }
    if (!source.evidence?.path || !source.evidence?.sha256) {
      block('AIH_SOURCE_INTEGRITY_FAILED', '设计来源缺少证据清单或内容哈希：' + source.id, location);
      continue;
    }

    try {
      const manifestPath = areaFile(areaDirectory, source.evidence.path);
      const actualManifestHash = await sha256(manifestPath);
      if (actualManifestHash !== source.evidence.sha256) {
        block('AIH_SOURCE_INTEGRITY_FAILED', '设计来源证据清单内容哈希不匹配：' + source.id, location);
        continue;
      }

      const evidence = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!validateEvidence(evidence)) {
        for (const error of validateEvidence.errors || []) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '证据清单结构无效：' + (error.instancePath || '/') + ' ' + error.message, source.evidence.path);
        }
        continue;
      }
      for (const field of ['sourceId', 'kind', 'location', 'capturedAt']) {
        const expected = field === 'sourceId' ? source.id : source[field];
        if (evidence[field] !== expected) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '证据清单 ' + field + ' 与 Canonical UI 不一致。', source.evidence.path);
        }
      }
      if (source.kind === 'figma' && evidence.nodeId !== expectedNodeId) {
        block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma 证据清单 nodeId 与来源节点不一致。', source.evidence.path);
      }

      const evidenceIds = new Set();
      let figmaContext = null;
      evidenceAssets.set(source.id, new Set());
      evidenceItems.set(source.id, new Map());
      for (const item of evidence.items) {
        if (evidenceIds.has(item.id)) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '证据项标识重复：' + item.id, source.evidence.path);
          continue;
        }
        evidenceIds.add(item.id);
        evidenceItems.get(source.id).set(item.id, item);
        if (item.role === 'asset') evidenceAssets.get(source.id).add(item.path);
        const itemPath = areaFile(areaDirectory, item.path);
        if (await sha256(itemPath) !== item.sha256) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '设计来源证据文件内容哈希不匹配：' + item.id, item.path);
        }
        if (source.kind === 'figma' && item.role === 'design-context') {
          if (item.schema !== figmaContextSchema.$id) {
            block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Figma design-context 未声明规范化参数 Schema：' + item.id, item.path);
            continue;
          }
          try {
            const context = JSON.parse(await readFile(itemPath, 'utf8'));
            if (!validateFigmaContext(context)) {
              for (const error of validateFigmaContext.errors || []) {
                block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Figma 设计参数不完整：' + (error.instancePath || '/') + ' ' + error.message, item.path);
              }
              continue;
            }
            if (
              context.sourceId !== source.id
              || context.nodeId !== expectedNodeId
              || context.capturedAt !== source.capturedAt
              || !sameSourceVersion(context.sourceVersion, evidence.sourceVersion)
            ) {
              block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma design-context 的来源身份与 Canonical UI 不一致。', item.path);
            }
            figmaContext = context;
          } catch (error) {
            block('AIH_VISUAL_SOURCE_INCOMPLETE', '无法解析 Figma design-context：' + error.message, item.path);
          }
        }
      }
      if (source.kind === 'figma' && figmaContext) {
        const contextComponents = new Map();
        for (const component of figmaContext.components) {
          if (contextComponents.has(component.nodeId)) {
            block('AIH_COMPONENT_MAPPING_INVALID', 'Figma design-context 组件节点重复：' + component.nodeId, source.evidence.path);
          }
          contextComponents.set(component.nodeId, component);
        }
        for (const component of figmaContext.components) {
          if (component.kind === 'component-set' && component.componentSetNodeId !== component.nodeId) {
            block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set 必须以自身 nodeId 作为 componentSetNodeId：' + component.nodeId, source.evidence.path);
          }
          if (component.componentSetNodeId && contextComponents.get(component.componentSetNodeId)?.kind !== 'component-set') {
            block('AIH_COMPONENT_MAPPING_INVALID', '组件引用未知 Component Set：' + component.nodeId + ' → ' + component.componentSetNodeId, source.evidence.path);
          }
          if (component.kind === 'instance' && contextComponents.get(component.mainComponentNodeId)?.kind !== 'component') {
            block('AIH_COMPONENT_MAPPING_INVALID', 'Instance 引用未知 Main Component：' + component.nodeId + ' → ' + component.mainComponentNodeId, source.evidence.path);
          }
        }
        figmaContexts.set(source.id, { context: figmaContext, components: contextComponents });
        const contextAssets = new Map(figmaContext.assets.map((asset) => [asset.nodeId, asset]));
        for (const item of evidence.items.filter((entry) => entry.role === 'asset')) {
          const contextAsset = contextAssets.get(item.sourceNodeId);
          if (
            !contextAsset
            || contextAsset.assetKind !== item.assetKind
            || contextAsset.captureScope !== item.captureScope
            || contextAsset.containsDynamicContent !== item.containsDynamicContent
          ) {
            block('AIH_SOURCE_INTEGRITY_FAILED', '导出资源证据与 Figma design-context 的静态图层声明不一致：' + item.id, item.path);
          }
        }
      }
      for (const coverage of source.coverage) {
        for (const evidenceItemId of coverage.evidenceItemIds) {
          if (!evidenceIds.has(evidenceItemId)) {
            block('AIH_SOURCE_COVERAGE_FAILED', '覆盖范围引用未知证据项：' + evidenceItemId, location);
          }
        }
      }
    } catch (error) {
      block(
        String(error.code || '').startsWith('AIH_') ? error.code : 'AIH_SOURCE_INTEGRITY_FAILED',
        '无法读取设计来源证据：' + error.message,
        location,
      );
    }
  }

  for (const asset of model.assets) {
    for (const sourceId of asset.sourceIds) {
      if (!evidenceAssets.get(sourceId)?.has(asset.path)) {
        block('AIH_SOURCE_INTEGRITY_FAILED', '资源未出现在对应设计来源的证据清单：' + asset.id + ' / ' + sourceId, asset.path);
      }
    }
  }

  const inventoriedNodes = new Map();
  const inventories = new Map(model.componentInventory.map((item) => [item.id, item]));
  for (const inventory of model.componentInventory) {
    const source = model.designSources.find((item) => item.id === inventory.sourceId);
    const figma = figmaContexts.get(inventory.sourceId);
    if (source?.kind !== 'figma' || !figma) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件清单必须引用可用 Figma design-context：' + inventory.id, 'componentInventory.' + inventory.id);
      continue;
    }
    const sourceStructureSignatures = new Set();
    for (const nodeId of inventory.nodeIds) {
      const sourceComponent = figma.components.get(nodeId);
      if (!sourceComponent) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件清单引用未知 Figma 节点：' + inventory.sourceId + ' / ' + nodeId, 'componentInventory.' + inventory.id);
      } else {
        sourceStructureSignatures.add(sourceComponent.structureSignature);
      }
      const key = inventory.sourceId + '/' + nodeId;
      if (inventoriedNodes.has(key)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Figma 节点存在多个抽象决定：' + key, 'componentInventory.' + inventory.id);
      }
      inventoriedNodes.set(key, inventory.id);
    }
    if (
      JSON.stringify([...sourceStructureSignatures].sort())
      !== JSON.stringify([...inventory.structureSignatures].sort())
    ) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件清单结构签名与 Figma 来源节点不一致：' + inventory.id, 'componentInventory.' + inventory.id);
    }
  }
  if (policy.mode === 'guided' || policy.mode === 'exact') {
    for (const [sourceId, figma] of figmaContexts) {
      for (const component of figma.context.components) {
        if (!inventoriedNodes.has(sourceId + '/' + component.nodeId)) {
          block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Figma 组件相关节点缺少抽象决定：' + sourceId + ' / ' + component.nodeId, 'componentInventory');
        }
      }
    }
  }

  const mappings = new Map(model.componentMappings.map((item) => [item.id, item]));
  for (const mapping of model.componentMappings) {
    const inventory = inventories.get(mapping.inventoryId);
    const figma = figmaContexts.get(mapping.sourceId);
    const target = figma?.components.get(mapping.figmaComponentNodeId);
    if (
      !inventory
      || inventory.decision !== 'shared-component'
      || inventory.componentId !== mapping.componentId
      || inventory.sourceId !== mapping.sourceId
      || !inventory.nodeIds.includes(mapping.figmaComponentNodeId)
      || !['component', 'component-set'].includes(target?.kind)
    ) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Figma ↔ Lit 组件映射无法解析到共享组件定义：' + mapping.id, 'componentMappings.' + mapping.id);
      continue;
    }
    const variantAxes = new Set(
      inventory.nodeIds.flatMap((nodeId) => Object.keys(figma.components.get(nodeId)?.variantProperties || {})),
    );
    const mappedAxes = new Set(mapping.propertyMappings.filter((item) => item.kind === 'variant').map((item) => item.figmaProperty));
    for (const axis of variantAxes) {
      if (!mappedAxes.has(axis)) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Figma Variant 轴缺少 Lit 属性映射：' + mapping.id + ' / ' + axis, 'componentMappings.' + mapping.id);
      }
    }
    for (const axis of mappedAxes) {
      if (!variantAxes.has(axis)) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Lit Variant 属性映射引用未知 Figma 轴：' + mapping.id + ' / ' + axis, 'componentMappings.' + mapping.id);
      }
    }
  }

  const coveredInstances = new Set();
  for (const coverage of model.componentVariantCoverage) {
    const mapping = mappings.get(coverage.mappingId);
    const inventory = mapping && inventories.get(mapping.inventoryId);
    const figma = mapping && figmaContexts.get(mapping.sourceId);
    if (!mapping || !inventory || !figma) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant 覆盖引用无法解析的组件映射：' + coverage.mappingId, 'componentVariantCoverage.' + coverage.id);
      continue;
    }
    const declaredSlots = new Set(mapping.slotMappings.map((item) => item.litSlot));
    for (const slot of coverage.litSlotNames) {
      if (!declaredSlots.has(slot)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant 覆盖使用未声明 Slot：' + coverage.id + ' / ' + slot, 'componentVariantCoverage.' + coverage.id);
      }
    }
    const expectedAttributes = {};
    for (const [figmaProperty, figmaValue] of Object.entries(coverage.figmaVariantProperties)) {
      const property = mapping.propertyMappings.find((item) => item.kind === 'variant' && item.figmaProperty === figmaProperty);
      const value = property?.values.find((item) => item.figmaValue === figmaValue);
      if (!property?.litAttribute || !value) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Variant 值缺少 Lit Attribute 映射：' + coverage.id + ' / ' + figmaProperty + '=' + figmaValue, 'componentVariantCoverage.' + coverage.id);
        continue;
      }
      expectedAttributes[property.litAttribute] = value.litValue;
    }
    if (!sameStringRecord(expectedAttributes, coverage.litVariantAttributes)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant 覆盖中的 Lit Attribute 与属性映射不一致：' + coverage.id, 'componentVariantCoverage.' + coverage.id);
    }
    for (const instanceNodeId of coverage.instanceNodeIds) {
      const instance = figma.components.get(instanceNodeId);
      if (instance?.kind !== 'instance' || !inventory.nodeIds.includes(instanceNodeId)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant 覆盖引用的节点不是该共享组件 Instance：' + coverage.id + ' / ' + instanceNodeId, 'componentVariantCoverage.' + coverage.id);
      } else if (!sameStringRecord(instance.variantProperties, coverage.figmaVariantProperties)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant 覆盖与 Figma Instance 属性不一致：' + coverage.id + ' / ' + instanceNodeId, 'componentVariantCoverage.' + coverage.id);
      }
      const key = coverage.mappingId + '/' + instanceNodeId;
      if (coveredInstances.has(key)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Instance 被重复覆盖：' + key, 'componentVariantCoverage.' + coverage.id);
      }
      coveredInstances.add(key);
    }
  }
  for (const inventory of model.componentInventory.filter((item) => item.decision === 'shared-component')) {
    const mapping = model.componentMappings.find((item) => item.inventoryId === inventory.id);
    const figma = figmaContexts.get(inventory.sourceId);
    for (const instanceNodeId of inventory.nodeIds.filter((nodeId) => figma?.components.get(nodeId)?.kind === 'instance')) {
      if (!mapping || !coveredInstances.has(mapping.id + '/' + instanceNodeId)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '共享组件 Instance 缺少 Variant 覆盖：' + inventory.sourceId + ' / ' + instanceNodeId, 'componentVariantCoverage');
      }
    }
  }

  const sourceIds = new Set(model.designSources.map((source) => source.id));
  const policyAspects = new Set(policy.aspects || []);
  for (const coverage of policy.coverage || []) {
    if (!sourceIds.has(coverage.sourceId)) {
      block('AIH_REFERENCE_UNRESOLVED', '视觉策略覆盖引用未知来源：' + coverage.sourceId, 'visualPolicy.coverage');
      continue;
    }
    for (const itemId of coverage.evidenceItemIds) {
      if (!evidenceItems.get(coverage.sourceId)?.has(itemId)) {
        block('AIH_VISUAL_SOURCE_INCOMPLETE', '视觉策略覆盖引用未知证据项：' + coverage.sourceId + ' / ' + itemId, 'visualPolicy.coverage');
      }
    }
  }

  for (const assertion of model.sourceParityAssertions || []) {
    const location = 'sourceParityAssertions.' + assertion.id;
    const source = model.designSources.find((item) => item.id === assertion.sourceId);
    if (!source) {
      block('AIH_REFERENCE_UNRESOLVED', '来源一致性断言引用未知来源：' + assertion.sourceId, location);
      continue;
    }
    const route = model.routes.find((item) => item.id === assertion.routeId);
    const covered = route && policy.coverage.some((coverage) => (
      coverage.sourceId === assertion.sourceId
      && coverage.screenId === route.screenId
      && coverage.viewportIds.includes(assertion.viewportId)
    ));
    if (!covered) {
      block('AIH_VISUAL_DEVIATION_UNAPPROVED', '来源一致性断言超出视觉策略覆盖：' + assertion.routeId + ' / ' + assertion.viewportId, location);
    }
    if (source.status === 'blocked' || (policy.mode === 'exact' && source.status !== 'available')) {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', '来源一致性断言引用不可用或不完整来源：' + assertion.sourceId, location);
    }
    for (const aspect of assertion.aspects) {
      if (!policyAspects.has(aspect)) block('AIH_VISUAL_DEVIATION_UNAPPROVED', '来源一致性断言超出视觉策略声明方面：' + aspect, location);
    }
    const screenshotCheck = assertion.checks.some((check) => check.kind === 'screenshot-match');
    if (screenshotCheck) {
      const item = evidenceItems.get(assertion.sourceId)?.get(assertion.baselineEvidenceItemId);
      if (!item || item.role !== 'screenshot') {
        block('AIH_VISUAL_SOURCE_INCOMPLETE', '截图一致性断言必须引用该来源的 screenshot 证据项。', location);
      }
    }
  }

  if (policy.mode === 'exact') {
    const allAspects = ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'];
    for (const aspect of allAspects) {
      if (!policyAspects.has(aspect)) block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式缺少视觉方面：' + aspect, 'visualPolicy.aspects');
    }
    const hasScreenshotParity = (routeId, viewportId, scenarioId = null) => model.sourceParityAssertions.some((assertion) => (
      assertion.routeId === routeId
      && assertion.viewportId === viewportId
      && (scenarioId ? assertion.scenarioId === scenarioId : !assertion.scenarioId)
      && assertion.checks.some((check) => check.kind === 'screenshot-match')
    ));
    for (const route of model.routes) {
      for (const viewport of model.viewports) {
        if (!hasScreenshotParity(route.id, viewport.id)) {
          block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式缺少路由截图基线：' + route.id + ' / ' + viewport.id, 'sourceParityAssertions');
        }
      }
    }
    for (const scenario of model.scenarios) {
      for (const viewportId of scenario.viewportIds) {
        if (!hasScreenshotParity(scenario.routeId, viewportId, scenario.id)) {
          block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式缺少场景截图基线：' + scenario.id + ' / ' + viewportId, 'sourceParityAssertions');
        }
      }
    }
  }
} catch (error) {
  block(error.code || 'AIH_PROJECT_BINDING_INVALID', error.message);
}

const result = { status: blockers.length === 0 ? 'PASS' : 'BLOCKED', blockers };
if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Canonical UI Prototype 输入门禁通过。');
else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
if (result.status !== 'PASS') process.exitCode = 1;
