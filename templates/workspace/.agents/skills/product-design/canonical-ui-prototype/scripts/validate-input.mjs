import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifactCollectionMembers, artifactMemberPath, artifactPaths, loadProjectAndManifest, readJson, readStructured, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const blockers = [];
const actorIndex = process.argv.indexOf('--actor');
const requestedActor = actorIndex >= 0 ? process.argv[actorIndex + 1] : null;

if (!requestedActor) {
  const { project } = await loadProjectAndManifest(root);
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const members = await artifactCollectionMembers(root, paths);
  const childBlockers = [];
  for (const member of members) {
    const child = spawnSync(process.execPath, [process.argv[1], '--actor', member.actor, '--json'], { cwd: root, encoding: 'utf8', env: process.env, windowsHide: true });
    try { childBlockers.push(...(JSON.parse(child.stdout || '{}').blockers || [])); }
    catch { childBlockers.push({ code: 'AIH_VALIDATION_FAILED', message: child.stderr || '参与者输入校验没有返回 JSON。', location: member.actor }); }
  }
  if (members.length === 0) childBlockers.push({ code: 'AIH_ARTIFACT_INCOMPLETE', message: '尚未创建参与者 Canonical UI 应用。', location: paths.authorityRoot });
  const aggregate = { status: childBlockers.length === 0 ? 'PASS' : 'BLOCKED', actors: members.map((member) => member.actor), blockers: childBlockers };
  if (json) console.log(JSON.stringify(aggregate, null, 2));
  else if (aggregate.status === 'PASS') console.log('[PASS] 全部参与者 Canonical UI 输入校验通过。');
  else for (const item of childBlockers) console.error('[' + item.code + '] ' + item.message);
  process.exit(aggregate.status === 'PASS' ? 0 : 1);
}

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
  if (!['active', 'published'].includes(stage?.status)) throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  const upstreamFacts = {};
  for (const artifactId of ['capabilities', 'visual-spec']) {
    const registry = manifest.artifactRegistry.find((item) => item.id === artifactId);
    const paths = artifactPaths(project, artifactId, 'product-design');
    const authorityPath = paths.authorityPath;
    const model = await readStructured(root, authorityPath, registry.format);
    if (model.metadata?.status !== 'ready' || model.gaps?.length > 0 || model.gates?.some((gate) => gate.checked !== true)) {
      block('AIH_UPSTREAM_NOT_READY', '上游产物未达到严格就绪：' + artifactId, authorityPath);
    }
    upstreamFacts[artifactId] = {
      version: model.metadata?.version,
      contentHash: await sha256(repositoryFile(root, authorityPath)),
      authorityPath,
    };
  }

  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const authorityPath = artifactMemberPath(paths, requestedActor);
  const model = await extractCanonicalUi(root, authorityPath);
  if (model.actor !== requestedActor) block('AIH_REFERENCE_UNRESOLVED', '应用 actor 与目录参与者不一致。', authorityPath);
  for (const [artifactId, bindingName] of [['capabilities', 'useCases'], ['visual-spec', 'visualSpec']]) {
    const expected = upstreamFacts[artifactId];
    const actual = model.draft?.inputs?.[bindingName];
    if (!actual || actual.version !== expected.version || actual.contentHash !== expected.contentHash) {
      block(
        'AIH_CANONICAL_UI_INPUT_DRIFT',
        'UI HTML Draft 未固定当前 ready 上游的版本与内容哈希：' + artifactId,
        'draft.inputs.' + bindingName,
      );
    }
  }
  const areaPath = paths.authorityRoot + '/' + requestedActor;
  const areaDirectory = repositoryFile(root, areaPath);
  const evidenceSchema = await readJson(root, '.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json');
  const validateEvidence = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(evidenceSchema);
  const figmaContextSchema = await readJson(root, '.agents/skills/capture-figma-design-source/figma-design-context.schema.json');
  const validateFigmaContext = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(figmaContextSchema);
  const capturePlanSchema = await readJson(root, '.agents/skills/capture-figma-design-source/capture-plan.schema.json');
  const validateCapturePlan = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(capturePlanSchema);
  const ingestReceiptSchema = await readJson(root, '.agents/skills/capture-figma-design-source/ingest-receipt.schema.json');
  const validateIngestReceipt = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(ingestReceiptSchema);
  const evidenceAssets = new Map();
  const evidenceItems = new Map();
  const figmaContexts = new Map();
  const capturePlans = new Map();
  const ingestReceipts = new Map();
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
      evidenceAssets.set(source.id, new Map());
      evidenceItems.set(source.id, new Map());
      for (const item of evidence.items) {
        if (evidenceIds.has(item.id)) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '证据项标识重复：' + item.id, source.evidence.path);
          continue;
        }
        evidenceIds.add(item.id);
        evidenceItems.get(source.id).set(item.id, item);
        if (item.role === 'asset') evidenceAssets.get(source.id).set(item.path, item);
        const itemPath = areaFile(areaDirectory, item.path);
        try {
          if (await sha256(itemPath) !== item.sha256) {
            block(
              ['asset', 'capture-plan', 'ingest-receipt'].includes(item.role) ? 'AIH_ASSET_HASH_MISMATCH' : 'AIH_SOURCE_INTEGRITY_FAILED',
              '设计来源证据文件内容哈希不匹配：' + item.id,
              item.path,
            );
          }
        } catch (error) {
          block(item.role === 'asset' ? 'AIH_ASSET_MISSING' : 'AIH_SOURCE_INTEGRITY_FAILED', '设计来源证据文件不可读：' + item.id, item.path);
          continue;
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
        if (source.kind === 'figma' && item.role === 'capture-plan') {
          if (item.schema !== capturePlanSchema.$id) {
            block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', 'Capture Plan 未声明规范 Schema：' + item.id, item.path);
            continue;
          }
          try {
            const plan = JSON.parse(await readFile(itemPath, 'utf8'));
            if (!validateCapturePlan(plan)) {
              for (const error of validateCapturePlan.errors || []) {
                block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', 'Capture Plan 结构无效：' + (error.instancePath || '/') + ' ' + error.message, item.path);
              }
              continue;
            }
            if (
              plan.sourceId !== source.id
              || plan.rootNodeId !== expectedNodeId
              || !sameSourceVersion(plan.sourceVersion, evidence.sourceVersion)
            ) {
              block('AIH_ASSET_CLOSURE_FAILED', 'Capture Plan 的来源身份与证据清单不一致。', item.path);
            }
            if (capturePlans.has(source.id)) block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', '同一来源只能登记一个 Capture Plan。', item.path);
            capturePlans.set(source.id, { item, plan });
          } catch (error) {
            block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', '无法解析 Capture Plan：' + error.message, item.path);
          }
        }
        if (source.kind === 'figma' && item.role === 'ingest-receipt') {
          if (item.schema !== ingestReceiptSchema.$id) {
            block('AIH_ASSET_CLOSURE_FAILED', 'Ingest Receipt 未声明规范 Schema：' + item.id, item.path);
            continue;
          }
          try {
            const receipt = JSON.parse(await readFile(itemPath, 'utf8'));
            if (!validateIngestReceipt(receipt)) {
              for (const error of validateIngestReceipt.errors || []) {
                block('AIH_ASSET_CLOSURE_FAILED', 'Ingest Receipt 结构无效：' + (error.instancePath || '/') + ' ' + error.message, item.path);
              }
              continue;
            }
            if (receipt.sourceId !== source.id || !sameSourceVersion(receipt.sourceVersion, evidence.sourceVersion)) {
              block('AIH_ASSET_CLOSURE_FAILED', 'Ingest Receipt 的来源身份与证据清单不一致。', item.path);
            }
            if (ingestReceipts.has(source.id)) block('AIH_ASSET_CLOSURE_FAILED', '同一来源只能登记一个 Ingest Receipt。', item.path);
            ingestReceipts.set(source.id, { item, receipt });
          } catch (error) {
            block('AIH_ASSET_CLOSURE_FAILED', '无法解析 Ingest Receipt：' + error.message, item.path);
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
      if (source.kind === 'figma') {
        const capture = capturePlans.get(source.id);
        const ingested = ingestReceipts.get(source.id);
        if (!capture) block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', 'Figma 来源缺少正式 Capture Plan。', source.evidence.path);
        if (!ingested) block('AIH_ASSET_CLOSURE_FAILED', 'Figma 来源缺少正式 Ingest Receipt。', source.evidence.path);
        if (capture && ingested) {
          if (
            ingested.receipt.capturePlan.path !== capture.item.path
            || ingested.receipt.capturePlan.sha256 !== capture.item.sha256
          ) {
            block('AIH_ASSET_HASH_MISMATCH', 'Ingest Receipt 引用的 Capture Plan 路径或哈希不匹配。', ingested.item.path);
          }
          const candidates = new Map();
          for (const candidate of capture.plan.candidateVisualNodes) {
            if (candidates.has(candidate.nodeId)) {
              block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', '视觉候选节点存在多个 strategy：' + candidate.nodeId, capture.item.path);
            }
            candidates.set(candidate.nodeId, candidate);
          }
          const plannedAssets = new Map(
            capture.plan.candidateVisualNodes
              .filter((candidate) => candidate.strategy === 'asset')
              .map((candidate) => [candidate.nodeId, candidate]),
          );
          const receiptAssets = new Map();
          for (const receiptAsset of ingested.receipt.assets) {
            if (receiptAssets.has(receiptAsset.sourceNodeId)) {
              block('AIH_ASSET_CLOSURE_FAILED', 'Ingest Receipt 重复登记来源节点：' + receiptAsset.sourceNodeId, ingested.item.path);
            }
            receiptAssets.set(receiptAsset.sourceNodeId, receiptAsset);
            const planned = plannedAssets.get(receiptAsset.sourceNodeId);
            if (
              !planned
              || planned.assetExport.targetPath !== receiptAsset.path
              || planned.assetExport.format !== receiptAsset.format
              || planned.assetExport.scale !== receiptAsset.scale
              || !sameStringRecord(planned.assetExport.cropBounds, receiptAsset.cropBounds)
              || !sameStringRecord(planned.assetExport.transparentPadding, receiptAsset.transparentPadding)
              || !sameStringRecord(planned.assetExport.expectedDimensions, receiptAsset.expectedDimensions)
              || planned.assetExport.downloadOperation !== ingested.receipt.downloadOperation
              || JSON.stringify(planned.consumerTargets) !== JSON.stringify(receiptAsset.consumerTargets)
            ) {
              block('AIH_ASSET_CLOSURE_FAILED', 'Capture Plan 与 Ingest Receipt 的 Asset 事实不一致：' + receiptAsset.sourceNodeId, ingested.item.path);
            }
            const evidenceAsset = evidenceAssets.get(source.id)?.get(receiptAsset.path);
            if (!evidenceAsset) {
              block('AIH_ASSET_MISSING', 'Ingest Receipt Asset 缺少来源证据项：' + receiptAsset.path, ingested.item.path);
            } else if (
              evidenceAsset.sourceNodeId !== receiptAsset.sourceNodeId
              || evidenceAsset.sha256 !== receiptAsset.sha256
              || evidenceAsset.format !== receiptAsset.format
              || evidenceAsset.scale !== receiptAsset.scale
              || !sameStringRecord(evidenceAsset.cropBounds, receiptAsset.cropBounds)
              || !sameStringRecord(evidenceAsset.transparentPadding, receiptAsset.transparentPadding)
              || !sameStringRecord(evidenceAsset.expectedDimensions, receiptAsset.expectedDimensions)
              || evidenceAsset.downloadOperation !== ingested.receipt.downloadOperation
              || JSON.stringify(evidenceAsset.consumerTargets) !== JSON.stringify(receiptAsset.consumerTargets)
              || evidenceAsset.status !== 'verified'
            ) {
              block('AIH_ASSET_CLOSURE_FAILED', '来源证据项与 Ingest Receipt 不一致：' + receiptAsset.path, evidenceAsset.path);
            }
          }
          for (const nodeId of plannedAssets.keys()) {
            if (!receiptAssets.has(nodeId)) block('AIH_ASSET_MISSING', '已分类 asset 未出现在 Ingest Receipt：' + nodeId, capture.item.path);
          }
          for (const evidenceAsset of evidenceAssets.get(source.id)?.values() || []) {
            if (!receiptAssets.has(evidenceAsset.sourceNodeId)) {
              block('AIH_ASSET_CLOSURE_FAILED', '来源 Asset 证据未出现在 Ingest Receipt：' + evidenceAsset.path, evidenceAsset.path);
            }
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
    if (asset.status !== 'verified') block('AIH_ASSET_MISSING', '正式 Asset 尚未通过 Ingest：' + asset.id, asset.path);
    for (const sourceId of asset.sourceIds) {
      const source = model.designSources.find((item) => item.id === sourceId);
      const evidenceAsset = evidenceAssets.get(sourceId)?.get(asset.path);
      if (!evidenceAsset) {
        block('AIH_ASSET_MISSING', '资源未出现在对应设计来源的证据清单：' + asset.id + ' / ' + sourceId, asset.path);
      } else if (source?.kind === 'figma' && (
        asset.sourceNodeId !== evidenceAsset.sourceNodeId
        || !sameSourceVersion(asset.sourceVersion, ingestReceipts.get(sourceId)?.receipt.sourceVersion)
        || asset.strategy !== evidenceAsset.strategy
        || asset.format !== evidenceAsset.format
        || asset.scale !== evidenceAsset.scale
        || !sameStringRecord(asset.cropBounds, evidenceAsset.cropBounds)
        || !sameStringRecord(asset.transparentPadding, evidenceAsset.transparentPadding)
        || !sameStringRecord(asset.expectedDimensions, evidenceAsset.expectedDimensions)
        || asset.sha256 !== evidenceAsset.sha256
        || asset.downloadOperation !== evidenceAsset.downloadOperation
        || JSON.stringify(asset.consumerTargets) !== JSON.stringify(evidenceAsset.consumerTargets)
        || asset.status !== evidenceAsset.status
      )) {
        block('AIH_ASSET_CLOSURE_FAILED', 'Asset Manifest 与来源证据项不一致：' + asset.id + ' / ' + sourceId, asset.path);
      }
    }
  }
  for (const [sourceId, assets] of evidenceAssets) {
    for (const evidenceAsset of assets.values()) {
      const consumers = model.assets.filter((asset) => asset.sourceIds.includes(sourceId) && asset.path === evidenceAsset.path);
      if (consumers.length !== 1) {
        block('AIH_ASSET_CLOSURE_FAILED', '来源 Asset 必须且只能对应一个 Asset Manifest 记录：' + sourceId + ' / ' + evidenceAsset.path, evidenceAsset.path);
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

  const contracts = new Map(model.componentContracts.map((item) => [item.id, item]));
  const contractsByMapping = new Map();
  const implementationOwners = new Map();
  for (const contract of model.componentContracts) {
    const location = 'componentContracts.' + contract.id;
    const mapping = contract.mappingId ? mappings.get(contract.mappingId) : null;
    if (contract.mappingId) {
      if (!mapping || mapping.componentId !== contract.componentId || mapping.litTagName !== contract.litTagName) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract 与 Figma ↔ Lit 映射不一致：' + contract.id, location);
        continue;
      }
      if (contractsByMapping.has(contract.mappingId)) {
        block('AIH_COMPONENT_CONTRACT_INVALID', '一个组件映射只能对应一个 Component Contract：' + contract.mappingId, location);
      }
      contractsByMapping.set(contract.mappingId, contract.id);
    } else if (contract.figmaInstanceNodeIds.length > 0 || contract.pageInstances.some((item) => item.figmaInstanceNodeId)) {
      block('AIH_COMPONENT_CONTRACT_INVALID', '无 Figma 映射的 Component Contract 不得声明 Figma Instance 身份：' + contract.id, location);
    }
    for (const implementationPath of contract.implementationPaths) {
      if (implementationOwners.has(implementationPath)) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component implementationPath 必须有唯一 Contract Owner：' + implementationPath, location);
      }
      implementationOwners.set(implementationPath, contract.id);
      try { await readFile(areaFile(areaDirectory, implementationPath)); }
      catch { block('AIH_COMPONENT_CONTRACT_INVALID', 'Component implementationPath 不存在：' + contract.id + ' / ' + implementationPath, location); }
    }
    if (mapping) {
      const mappedSlots = mapping.slotMappings.map((item) => item.litSlot).sort();
      if (JSON.stringify(mappedSlots) !== JSON.stringify([...contract.slots].sort())) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract Slot 与组件映射不一致：' + contract.id, location);
      }
    }
    const propertyNames = new Set();
    for (const property of contract.properties) {
      if (propertyNames.has(property.name)) block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract Property 重复：' + contract.id + ' / ' + property.name, location);
      propertyNames.add(property.name);
    }
    const attributeNames = new Set();
    for (const attribute of contract.attributes) {
      if (attributeNames.has(attribute.name) || !propertyNames.has(attribute.propertyName)) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract Attribute 必须唯一并引用已声明 Property：' + contract.id + ' / ' + attribute.name, location);
      }
      attributeNames.add(attribute.name);
    }
    if (mapping) {
      for (const property of mapping.propertyMappings) {
        if (!propertyNames.has(property.litProperty) || (property.litAttribute && !attributeNames.has(property.litAttribute))) {
          block('AIH_COMPONENT_CONTRACT_INVALID', '组件映射使用了 Contract 未声明的 Property 或 Attribute：' + contract.id + ' / ' + property.litProperty, location);
        }
      }
      if (JSON.stringify([...mapping.eventIds].sort()) !== JSON.stringify([...contract.eventIds].sort())) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract Event 与组件映射不一致：' + contract.id, location);
      }
    }
    for (const eventId of contract.eventIds) {
      const event = model.events.find((item) => item.id === eventId);
      const actions = model.actions.filter((item) => item.eventId === eventId);
      const control = event && model.controls.find((item) => item.id === event.controlId);
      if (!event || !control || control.componentId !== contract.componentId || actions.length !== 1) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract Event 必须解析到本组件 Control 与唯一 Action：' + contract.id + ' / ' + eventId, location);
      }
    }
    const expectedInstances = mapping
      ? model.componentVariantCoverage.filter((item) => item.mappingId === mapping.id).flatMap((item) => item.instanceNodeIds).sort()
      : [];
    if (JSON.stringify([...contract.figmaInstanceNodeIds].sort()) !== JSON.stringify(expectedInstances)) {
      block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract 必须精确声明映射覆盖的 Figma Instance：' + contract.id, location);
    }
    const pageInstances = new Set();
    for (const instance of contract.pageInstances) {
      const key = instance.screenId + '/' + (instance.figmaInstanceNodeId || instance.id);
      if (pageInstances.has(key) || (mapping && instance.figmaInstanceNodeId && !contract.figmaInstanceNodeIds.includes(instance.figmaInstanceNodeId))) {
        block('AIH_COMPONENT_CONTRACT_INVALID', '页面实例必须唯一并引用 Contract 中的 Figma Instance：' + contract.id + ' / ' + key, location);
      }
      const screen = model.screens.find((item) => item.id === instance.screenId);
      if (!screen?.componentIds.includes(contract.componentId)) {
        block('AIH_COMPONENT_CONTRACT_INVALID', '页面实例所属 Screen 未声明该 Component：' + contract.id + ' / ' + instance.screenId, location);
      }
      pageInstances.add(key);
    }
    const knownTargets = new Set([
      contract.componentId,
      ...model.controls.filter((item) => item.componentId === contract.componentId).map((item) => item.id),
      ...model.states.filter((item) => item.ownerId === contract.componentId).map((item) => item.id),
    ]);
    for (const assertion of contract.testAssertions) {
      const matrixEntry = assertion.stateMatrixEntryId && model.stateMatrix.find((item) => item.id === assertion.stateMatrixEntryId && item.componentContractId === contract.id);
      if (!knownTargets.has(assertion.targetId)) {
        block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'Component Contract Test Assertion 引用组件外目标：' + contract.id + ' / ' + assertion.targetId, location);
      }
      if (['disabled', 'aria'].includes(assertion.kind) && !matrixEntry) {
        block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'Disabled/ARIA 断言必须引用本组件合法 State Matrix Entry：' + contract.id, location);
      }
      if (assertion.kind === 'disabled' && typeof assertion.expected !== 'boolean') {
        block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'Disabled 断言 expected 必须是 boolean：' + contract.id, location);
      }
      if (assertion.kind === 'aria' && (typeof assertion.expected !== 'string' || !assertion.attribute?.startsWith('aria-'))) {
        block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'ARIA 断言必须声明 aria-* Attribute 与字符串 expected：' + contract.id, location);
      }
    }
  }
  for (const mapping of model.componentMappings) {
    if (!contractsByMapping.has(mapping.id)) {
      block('AIH_COMPONENT_CONTRACT_INVALID', '每个 Figma ↔ Lit 映射必须有且仅有一个 Component Contract：' + mapping.id, 'componentContracts');
    }
  }

  const axesByContract = new Map();
  for (const axis of model.stateAxes) {
    const location = 'stateAxes.' + axis.id;
    const contract = contracts.get(axis.componentContractId);
    if (!contract) {
      block('AIH_STATE_MATRIX_INVALID', 'State Axis 引用未知 Component Contract：' + axis.id, location);
      continue;
    }
    if (!axesByContract.has(contract.id)) axesByContract.set(contract.id, []);
    axesByContract.get(contract.id).push(axis);
    const valueIds = new Set();
    for (const value of axis.values) {
      if (valueIds.has(value.id)) block('AIH_STATE_MATRIX_INVALID', 'State Axis Value 重复：' + axis.id + ' / ' + value.id, location);
      valueIds.add(value.id);
      const state = value.stateId && model.states.find((item) => item.id === value.stateId);
      if (['runtime-state', 'interaction-state'].includes(axis.kind)) {
        const expectedScope = axis.kind === 'runtime-state' ? 'component' : 'workflow';
        if (!state || state.scope !== expectedScope || (expectedScope === 'component' && state.ownerId !== contract.componentId)) {
          block('AIH_STATE_MATRIX_INVALID', 'Runtime/Interaction State 轴值必须引用匹配作用域的 State：' + axis.id + ' / ' + value.id, location);
        }
      } else if (value.stateId) {
        block('AIH_STATE_MATRIX_INVALID', 'Variant 与 Content Override 轴值不得伪装成 Runtime/Interaction State：' + axis.id + ' / ' + value.id, location);
      }
    }
    if (axis.kind === 'variant') {
      const mapping = contract.mappingId ? mappings.get(contract.mappingId) : null;
      if (mapping) {
        const property = mapping.propertyMappings.find((item) => item.kind === 'variant' && item.figmaProperty === axis.name);
        const expected = property?.values.map((item) => item.figmaValue).sort() || [];
        const actual = axis.values.map((item) => item.value).sort();
        if (!property || JSON.stringify(expected) !== JSON.stringify(actual)) {
          block('AIH_STATE_MATRIX_INVALID', 'Variant State Axis 必须精确复用 Figma Variant 的有限值：' + axis.id, location);
        }
      }
    }
  }

  for (const contract of model.componentContracts) {
    const location = 'stateMatrix.' + contract.id;
    const axes = axesByContract.get(contract.id) || [];
    if (axes.length === 0) {
      block('AIH_STATE_MATRIX_INVALID', 'Component Contract 至少需要一个有限 State Axis：' + contract.id, location);
      continue;
    }
    const axisIds = new Set();
    for (const axis of axes) {
      if (axisIds.has(axis.id)) block('AIH_STATE_MATRIX_INVALID', 'Component Contract 的 State Axis 重复：' + axis.id, location);
      axisIds.add(axis.id);
    }
    const expectedKeys = [];
    const visit = (index, values) => {
      if (index === axes.length) {
        expectedKeys.push(Object.entries(values).sort(([left], [right]) => left.localeCompare(right)).map(([axisId, valueId]) => axisId + '=' + valueId).join('|'));
        return;
      }
      for (const value of axes[index].values) visit(index + 1, { ...values, [axes[index].id]: value.id });
    };
    visit(0, {});
    if (expectedKeys.length > 512) {
      block('AIH_STATE_MATRIX_INVALID', 'State Matrix 的有限组合超过 512，必须收窄组件轴：' + contract.id, location);
      continue;
    }
    const entries = model.stateMatrix.filter((item) => item.componentContractId === contract.id);
    const observed = new Map();
    for (const entry of entries) {
      const key = Object.entries(entry.values).sort(([left], [right]) => left.localeCompare(right)).map(([axisId, valueId]) => axisId + '=' + valueId).join('|');
      if (observed.has(key)) block('AIH_STATE_MATRIX_INVALID', 'State Matrix 组合重复：' + contract.id + ' / ' + key, 'stateMatrix.' + entry.id);
      observed.set(key, entry);
      for (const [axisId, valueId] of Object.entries(entry.values)) {
        const axis = axes.find((item) => item.id === axisId);
        if (!axis || !axis.values.some((item) => item.id === valueId)) {
          block('AIH_STATE_MATRIX_INVALID', 'State Matrix 引用未知 Axis 或 Value：' + entry.id + ' / ' + axisId + '=' + valueId, 'stateMatrix.' + entry.id);
        }
      }
    }
    for (const key of expectedKeys) {
      if (!observed.has(key)) block('AIH_STATE_MATRIX_INVALID', 'State Matrix 未分类有限组合：' + contract.id + ' / ' + key, location);
    }
    for (const key of observed.keys()) {
      if (!expectedKeys.includes(key)) block('AIH_STATE_MATRIX_INVALID', 'State Matrix 包含轴集合不完整或额外组合：' + contract.id + ' / ' + key, location);
    }
    const defaultEntry = entries.find((item) => item.id === contract.defaultStateMatrixEntryId);
    if (!defaultEntry || defaultEntry.classification !== 'legal') {
      block('AIH_STATE_MATRIX_INVALID', 'Component Contract 默认状态必须引用合法 Matrix Entry：' + contract.id, location);
    }
  }
  for (const entry of model.stateMatrix) {
    if (!contracts.has(entry.componentContractId)) {
      block('AIH_STATE_MATRIX_INVALID', 'State Matrix Entry 引用未知 Component Contract：' + entry.id, 'stateMatrix.' + entry.id);
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
