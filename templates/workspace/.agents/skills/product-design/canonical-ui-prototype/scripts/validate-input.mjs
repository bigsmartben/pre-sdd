import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { artifactCollectionMembers, artifactMemberPath, artifactPaths, loadProjectAndManifest, readJson, readStructured, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import {
  createSchemaValidatorCache,
  validateFigmaAssetClosure,
  validateFigmaDesignContext,
  validateFigmaWorkflow,
} from '../../../figma-workflow/scripts/lib/figma-contract-validation.mjs';
import { analyzeUiCaseCoverage } from '../../../ui-case-mock/scripts/model.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const blockers = [];
const schemaValidators = createSchemaValidatorCache((schemaPath) => readJson(root, schemaPath));
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

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonicalJson(item))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

function sameObjectSet(left, right) {
  const leftItems = (left || []).map((item) => canonicalJson(item)).sort();
  const rightItems = (right || []).map((item) => canonicalJson(item)).sort();
  return JSON.stringify(leftItems) === JSON.stringify(rightItems);
}

function sameFigmaComponentContract(left, right) {
  return Boolean(left && right && canonicalJson(left) === canonicalJson(right));
}

function figmaContractMatchesMapping(contract, mapping) {
  if (!contract || !mapping) return false;
  const sourceProperties = contract.properties.map((property) => ({
    name: property.name,
    kind: property.kind,
    values: [...property.values].sort(),
  }));
  const mappedProperties = mapping.propertyMappings.map((property) => ({
    name: property.figmaProperty,
    kind: property.kind,
    values: property.values.map((value) => value.figmaValue).sort(),
  }));
  const sourceRegions = contract.contentRegions.map((region) => region.name).sort();
  const mappedRegions = mapping.slotMappings.map((slot) => slot.figmaProperty).sort();
  return sameObjectSet(sourceProperties, mappedProperties)
    && JSON.stringify(sourceRegions) === JSON.stringify(mappedRegions);
}

function scopeScreenId(screenBindings, figmaRootNodeId) {
  const matches = (screenBindings || []).filter((item) => item.figmaRootNodeId === figmaRootNodeId);
  const screenIds = new Set(matches.map((item) => item.screenId));
  return matches.length > 0 && screenIds.size === 1 ? [...screenIds][0] : null;
}

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  if (!['active', 'published'].includes(stage?.status)) throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  const upstreamFacts = {};
  const upstreamModels = {};
  for (const artifactId of ['capabilities', 'visual-spec']) {
    const registry = manifest.artifactRegistry.find((item) => item.id === artifactId);
    const paths = artifactPaths(project, artifactId, 'product-design');
    const authorityPath = paths.authorityPath;
    const model = await readStructured(root, authorityPath, registry.format);
    upstreamModels[artifactId] = model;
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
  const evidenceSchemaPath = '.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json';
  const figmaContextSchemaPath = '.agents/skills/figma-workflow/figma-design-context.schema.json';
  const capturePlanSchemaPath = '.agents/skills/figma-workflow/capture-plan.schema.json';
  const ingestReceiptSchemaPath = '.agents/skills/figma-workflow/ingest-receipt.schema.json';
  const sourceRegistrationSchemaPath = '.agents/skills/figma-workflow/source-registration.schema.json';
  const [
    evidenceSchema,
    figmaContextSchema,
    capturePlanSchema,
    ingestReceiptSchema,
    sourceRegistrationSchema,
    validateEvidence,
    validateFigmaContext,
    validateCapturePlan,
    validateIngestReceipt,
    validateSourceRegistration,
  ] = await Promise.all([
    schemaValidators.schema(evidenceSchemaPath),
    schemaValidators.schema(figmaContextSchemaPath),
    schemaValidators.schema(capturePlanSchemaPath),
    schemaValidators.schema(ingestReceiptSchemaPath),
    schemaValidators.schema(sourceRegistrationSchemaPath),
    schemaValidators.get(evidenceSchemaPath),
    schemaValidators.get(figmaContextSchemaPath),
    schemaValidators.get(capturePlanSchemaPath),
    schemaValidators.get(ingestReceiptSchemaPath),
    schemaValidators.get(sourceRegistrationSchemaPath),
  ]);
  const evidenceAssets = new Map();
  const evidenceItems = new Map();
  const figmaContexts = new Map();
  const capturePlans = new Map();
  const ingestReceipts = new Map();
  const sourceRegistrations = new Map();
  const policy = model.visualPolicy || { mode: 'unresolved', aspects: [], coverage: [] };

  if (policy.mode === 'unresolved') {
    block('AIH_VISUAL_POLICY_UNRESOLVED', '开始界面实现前必须选择自主设计、部分参考或完全实现。', 'visualPolicy.mode');
  }
  if (policy.mode === 'autonomous' && (
    model.designSources.length > 0
    || model.sourceParityAssertions.length > 0
    || model.componentSourceParityAssertions.length > 0
  )) {
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
	        const contextComponents = new Map(figmaContext.components.map((component) => [component.nodeId, component]));
	        const componentSets = new Map(figmaContext.componentSetCatalog.map((catalog) => [catalog.componentSetNodeId, catalog]));
	        figmaContexts.set(source.id, { context: figmaContext, components: contextComponents, componentSets });
	      }
	      if (source.kind === 'figma') {
	        const capture = capturePlans.get(source.id);
	        const ingested = ingestReceipts.get(source.id);
	        const rawDesignContextItems = evidence.items.filter((item) => item.role === 'raw-design-context');
	        const designContextItems = evidence.items.filter((item) => item.role === 'design-context');
	        if (!capture) block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', 'Figma 来源缺少正式 Capture Plan。', source.evidence.path);
	        if (!ingested) block('AIH_ASSET_CLOSURE_FAILED', 'Figma 来源缺少正式 Ingest Receipt。', source.evidence.path);
	        if (rawDesignContextItems.length !== 1) {
	          block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Figma 来源必须且只能登记一个正式 raw-design-context。', source.evidence.path);
	        }
	        if (designContextItems.length !== 1) {
	          block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Figma 来源必须且只能登记一个正式 design-context。', source.evidence.path);
	        }
	        if (capture && figmaContext) {
	          validateFigmaWorkflow(capture.plan, block);
	          validateFigmaDesignContext(capture.plan, capture.item.sha256, figmaContext, block);
	          const rawItem = rawDesignContextItems[0];
	          if (
	            !rawItem
	            || figmaContext.rawCapture.path !== rawItem.path
	            || figmaContext.rawCapture.sha256 !== rawItem.sha256
	            || figmaContext.rawCapture.requestedNodeId !== expectedNodeId
	            || figmaContext.rawCapture.capturedAt !== figmaContext.capturedAt
	            || figmaContext.rawCapture.capturePlanSha256 !== capture.item.sha256
	            || !sameSourceVersion(figmaContext.rawCapture.sourceVersion, evidence.sourceVersion)
	            || !sameSourceVersion(capture.plan.formalCapture.sourceVersionBefore, evidence.sourceVersion)
	            || !sameSourceVersion(capture.plan.formalCapture.sourceVersionAfter, evidence.sourceVersion)
	          ) {
	            block('AIH_SOURCE_INTEGRITY_FAILED', '唯一正式 get_design_context 原始采集、Capture Plan 与冻结来源版本未闭合。', source.evidence.path);
	          }
	        }
        if (!source.registration?.path || !source.registration?.sha256) {
          block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma 来源缺少 Registration Packet 路径或哈希。', location);
        } else {
          try {
            const registrationPath = areaFile(areaDirectory, source.registration.path);
            if (await sha256(registrationPath) !== source.registration.sha256) {
              block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 内容哈希不匹配：' + source.id, source.registration.path);
            }
            const registration = JSON.parse(await readFile(registrationPath, 'utf8'));
            if (!validateSourceRegistration(registration)) {
              for (const error of validateSourceRegistration.errors || []) {
                block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 结构无效：' + (error.instancePath || '/') + ' ' + error.message, source.registration.path);
              }
            } else {
              sourceRegistrations.set(source.id, registration);
              if (
                registration.sourceId !== source.id
                || !sameSourceVersion(registration.sourceVersion, evidence.sourceVersion)
                || registration.evidencePath !== source.evidence.path
                || registration.evidenceSha256 !== source.evidence.sha256
              ) {
                block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 与 Canonical 来源或正式证据身份不一致。', source.registration.path);
              }
              if (
                !capture
                || registration.capturePlan.path !== capture.item.path
                || registration.capturePlan.sha256 !== capture.item.sha256
              ) {
                block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 未引用同一正式 Capture Plan。', source.registration.path);
              }
	              if (
	                !ingested
	                || registration.ingestReceipt.path !== ingested.item.path
	                || registration.ingestReceipt.sha256 !== ingested.item.sha256
	              ) {
	                block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 未引用同一正式 Ingest Receipt。', source.registration.path);
	              }
	              const designContextItem = designContextItems[0];
	              if (
	                !designContextItem
	                || registration.designContext.path !== designContextItem.path
	                || registration.designContext.sha256 !== designContextItem.sha256
	              ) {
	                block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 未引用同一正式 design-context。', source.registration.path);
	              }
              if (source.status === 'available' && registration.gaps.length > 0) {
                block('AIH_SOURCE_COVERAGE_FAILED', 'available Figma 来源的 Registration Packet 不得保留 gap。', source.registration.path);
              }
              if (capture && ingested && figmaContext) {
                validateFigmaAssetClosure({
                  plan: capture.plan,
                  planSha256: capture.item.sha256,
                  context: figmaContext,
                  receipt: ingested.receipt,
                  evidence,
                  registration,
                  location: source.registration.path,
                }, block);
              }
            }
          } catch (error) {
            block('AIH_SOURCE_INTEGRITY_FAILED', '无法读取 Registration Packet：' + error.message, source.registration.path);
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
        || asset.assetBoundaryNodeId !== evidenceAsset.assetBoundaryNodeId
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
  const inventories = new Map();
  for (const inventory of model.componentInventory) {
    if (inventories.has(inventory.id)) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Component Inventory ID 必须唯一：' + inventory.id, 'componentInventory.' + inventory.id);
    }
    inventories.set(inventory.id, inventory);
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

  const mappings = new Map();
  const expectedDefinitionNodesByMapping = new Map();
  for (const mapping of model.componentMappings) {
    const location = 'componentMappings.' + mapping.id;
    if (mappings.has(mapping.id)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Component Mapping ID 必须唯一：' + mapping.id, location);
    }
    mappings.set(mapping.id, mapping);
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
      block('AIH_COMPONENT_MAPPING_INVALID', 'Figma ↔ Lit 组件映射无法解析到共享组件定义：' + mapping.id, location);
      continue;
    }
    const catalog = target.kind === 'component-set' ? figma.componentSets.get(target.nodeId) : null;
    const expectedDefinitionIds = target.kind === 'component-set'
      ? (catalog?.definitionNodeIds || [])
      : [target.nodeId];
    const definitionNodes = expectedDefinitionIds.map((nodeId) => figma.components.get(nodeId)).filter(Boolean);
    if (
      definitionNodes.length !== expectedDefinitionIds.length
      || definitionNodes.some((item) => item.kind !== 'component')
      || expectedDefinitionIds.some((nodeId) => !inventory.nodeIds.includes(nodeId))
    ) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'shared-component Inventory 与 Mapping 必须包含完整 Component Set Catalog Definition：' + mapping.id, location);
    }
    expectedDefinitionNodesByMapping.set(mapping.id, new Set(definitionNodes.map((item) => item.nodeId)));
    const variantAxes = new Set(definitionNodes.flatMap((item) => Object.keys(item.variantProperties || {})));
    const mappedAxes = new Set(mapping.propertyMappings.filter((item) => item.kind === 'variant').map((item) => item.figmaProperty));
    for (const axis of variantAxes) {
      if (!mappedAxes.has(axis)) block('AIH_COMPONENT_MAPPING_INVALID', 'Figma Variant 轴缺少 Lit 属性映射：' + mapping.id + ' / ' + axis, location);
    }
    for (const axis of mappedAxes) {
      if (!variantAxes.has(axis)) block('AIH_COMPONENT_MAPPING_INVALID', 'Lit Variant 属性映射引用未知 Figma 轴：' + mapping.id + ' / ' + axis, location);
    }
  }
  for (const inventory of model.componentInventory) {
    const inventoryMappings = model.componentMappings.filter((item) => item.inventoryId === inventory.id);
    if (
      (inventory.decision === 'shared-component' && inventoryMappings.length !== 1)
      || (inventory.decision !== 'shared-component' && inventoryMappings.length !== 0)
    ) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'shared-component Inventory 必须且只能有一个 Mapping；其他决定不得映射：' + inventory.id, 'componentMappings');
    }
  }

  const variantDefinitions = new Map();
  const definitionNodes = new Set();
  const definitionCombinations = new Set();
  for (const definition of model.componentVariantDefinitions) {
    const location = 'componentVariantDefinitions.' + definition.id;
    if (variantDefinitions.has(definition.id)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition ID 必须唯一：' + definition.id, location);
    }
    variantDefinitions.set(definition.id, definition);
    const mapping = mappings.get(definition.mappingId);
    const figma = mapping && figmaContexts.get(mapping.sourceId);
    const sourceDefinition = figma?.components.get(definition.figmaComponentNodeId);
    if (
      !mapping
      || sourceDefinition?.kind !== 'component'
      || !expectedDefinitionNodesByMapping.get(mapping.id)?.has(definition.figmaComponentNodeId)
    ) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 无法解析到该 Mapping 的 Figma Component 定义：' + definition.id, location);
      continue;
    }
    const nodeKey = mapping.id + '/' + definition.figmaComponentNodeId;
    if (definitionNodes.has(nodeKey)) block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Component 定义被重复登记：' + nodeKey, location);
    definitionNodes.add(nodeKey);
    const combinationKey = mapping.id + '/' + JSON.stringify(Object.entries(definition.figmaVariantProperties).sort(([left], [right]) => left.localeCompare(right)));
    if (definitionCombinations.has(combinationKey)) block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 属性组合重复：' + definition.id, location);
    definitionCombinations.add(combinationKey);
    if (!sameStringRecord(sourceDefinition.variantProperties, definition.figmaVariantProperties)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 与 Figma Component 属性不一致：' + definition.id, location);
    }
    const expectedAttributes = {};
    for (const [figmaProperty, figmaValue] of Object.entries(definition.figmaVariantProperties)) {
      const property = mapping.propertyMappings.find((item) => item.kind === 'variant' && item.figmaProperty === figmaProperty);
      const value = property?.values.find((item) => item.figmaValue === figmaValue);
      if (!property?.litAttribute || !value) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 值缺少 Lit Attribute 映射：' + definition.id + ' / ' + figmaProperty + '=' + figmaValue, location);
        continue;
      }
      expectedAttributes[property.litAttribute] = value.litValue;
    }
    if (!sameStringRecord(expectedAttributes, definition.litVariantAttributes)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 的 Lit Attribute 与 Mapping 不一致：' + definition.id, location);
    }
  }
  for (const mapping of model.componentMappings) {
    const expectedNodes = [...(expectedDefinitionNodesByMapping.get(mapping.id) || [])].sort();
    const actualDefinitions = model.componentVariantDefinitions.filter((item) => item.mappingId === mapping.id);
    const actualNodes = actualDefinitions.map((item) => item.figmaComponentNodeId).sort();
    if (JSON.stringify(expectedNodes) !== JSON.stringify(actualNodes)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Mapping 必须登记全部且仅登记其 Figma Variant Definition：' + mapping.id, 'componentVariantDefinitions');
    }
    for (const property of mapping.propertyMappings.filter((item) => item.kind === 'variant')) {
      const expectedValues = [...new Set(actualDefinitions.map((item) => item.figmaVariantProperties[property.figmaProperty]).filter(Boolean))].sort();
      const mappedValues = property.values.map((item) => item.figmaValue).sort();
      if (JSON.stringify(expectedValues) !== JSON.stringify(mappedValues)) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Variant Property 值映射必须精确覆盖全部 Definition：' + mapping.id + ' / ' + property.figmaProperty, 'componentMappings.' + mapping.id);
      }
    }
  }

  const coveredInstances = new Map();
  const coverageRowKeys = new Set();
  const coverageIds = new Set();
  for (const coverage of model.componentVariantCoverage) {
    const location = 'componentVariantCoverage.' + coverage.id;
    if (coverageIds.has(coverage.id)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition Coverage ID 必须唯一：' + coverage.id, location);
    }
    coverageIds.add(coverage.id);
    const mapping = mappings.get(coverage.mappingId);
    const definition = variantDefinitions.get(coverage.definitionId);
    const inventory = mapping && inventories.get(mapping.inventoryId);
    const figma = mapping && figmaContexts.get(mapping.sourceId);
    if (!mapping || !definition || definition.mappingId !== mapping.id || !inventory || !figma) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Usage 引用无法闭合的 Mapping 或 Definition：' + coverage.id, location);
      continue;
    }
    const rowKey = coverage.definitionId + '/' + JSON.stringify([...coverage.litSlotNames].sort());
    if (coverageRowKeys.has(rowKey)) block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '相同 Definition 与 Slot 的 Usage 必须合并为一行：' + coverage.id, location);
    coverageRowKeys.add(rowKey);
    const declaredSlots = new Set(mapping.slotMappings.map((item) => item.litSlot));
    for (const slot of coverage.litSlotNames) {
      if (!declaredSlots.has(slot)) block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Usage 使用未声明 Slot：' + coverage.id + ' / ' + slot, location);
    }
    const usagePairs = new Set();
    for (const usage of coverage.usages) {
      const pairKey = usage.screenId + '/' + usage.instanceNodeId;
      if (usagePairs.has(pairKey)) block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Usage 重复登记 Instance ↔ Screen：' + pairKey, location);
      usagePairs.add(pairKey);
      const screen = model.screens.find((item) => item.id === usage.screenId);
      const instance = figma.components.get(usage.instanceNodeId);
      if (!screen?.componentIds.includes(mapping.componentId)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Usage 的 Screen 未声明该 Component：' + coverage.id + ' / ' + usage.screenId, location);
      }
      if (
        instance?.kind !== 'instance'
        || !inventory.nodeIds.includes(usage.instanceNodeId)
        || instance.mainComponentNodeId !== definition.figmaComponentNodeId
        || !sameStringRecord(instance.variantProperties, definition.figmaVariantProperties)
      ) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Usage 与 Figma Instance、Definition 或属性不一致：' + coverage.id + ' / ' + usage.instanceNodeId, location);
      }
      const boundScreenId = scopeScreenId(
        capturePlans.get(mapping.sourceId)?.plan.scopeAudit.screenBindings,
        instance?.screenRootNodeId,
      );
      if (boundScreenId !== usage.screenId) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Usage 必须通过 Instance screenRootNodeId 的一个或多个 Viewport/Scenario Binding 唯一解析到同一 Product Screen：' + coverage.id + ' / ' + usage.instanceNodeId, location);
      }
      const instanceKey = mapping.id + '/' + usage.instanceNodeId;
      if (coveredInstances.has(instanceKey)) block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Instance 被多个 Usage 重复覆盖：' + instanceKey, location);
      coveredInstances.set(instanceKey, { coverage, definition, usage });
    }
  }
  for (const inventory of model.componentInventory.filter((item) => item.decision === 'shared-component')) {
    const mapping = model.componentMappings.find((item) => item.inventoryId === inventory.id);
    const figma = figmaContexts.get(inventory.sourceId);
    for (const instanceNodeId of inventory.nodeIds.filter((nodeId) => figma?.components.get(nodeId)?.kind === 'instance')) {
      if (!mapping || !coveredInstances.has(mapping.id + '/' + instanceNodeId)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '共享组件 Instance 缺少 Instance ↔ Screen Usage：' + inventory.sourceId + ' / ' + instanceNodeId, 'componentVariantCoverage');
      }
    }
  }
  for (const definition of model.componentVariantDefinitions) {
    if (!model.componentVariantCoverage.some((item) => item.definitionId === definition.id)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '每个 Variant Definition 必须有一个 Definition Coverage 行；未使用定义可保留空 usages：' + definition.id, 'componentVariantCoverage');
    }
  }

  for (const source of model.designSources.filter((item) => item.kind === 'figma' && item.status !== 'blocked')) {
    const registration = sourceRegistrations.get(source.id);
    if (!registration) continue;
    const capture = capturePlans.get(source.id)?.plan;
    const sourceInventories = model.componentInventory.filter((item) => item.sourceId === source.id);
    const matchedInventoryIds = new Set();
    const matchedProposalIds = new Set();
    const handshakeKeys = new Set();
    const proposals = capture?.scopeAudit.componentProposals || [];
    const proposalIds = new Set();
    const proposalNodeOwners = new Map();
    for (const proposal of proposals) {
      if (proposalIds.has(proposal.id)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Capture Plan Component Proposal ID 重复：' + proposal.id, capturePlans.get(source.id)?.item.path);
      }
      proposalIds.add(proposal.id);
      for (const nodeId of proposal.nodeIds) {
        const owner = proposalNodeOwners.get(nodeId);
        if (owner) {
          block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Capture Plan Component Proposal 分组重叠：' + nodeId + ' / ' + owner + ' / ' + proposal.id, capturePlans.get(source.id)?.item.path);
        }
        proposalNodeOwners.set(nodeId, proposal.id);
      }
    }
    const confirmedComponentNodeIds = (capture?.scopeAudit.includedNodes || [])
      .filter((item) => ['component-set', 'component', 'instance'].includes(item.kind))
      .map((item) => item.nodeId)
      .sort();
    if (JSON.stringify([...proposalNodeOwners.keys()].sort()) !== JSON.stringify(confirmedComponentNodeIds)) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Capture Plan Component Proposal 必须对确认范围内组件节点形成无遗漏、无重叠分区。', capturePlans.get(source.id)?.item.path);
    }
    const allowedScreenIds = new Set((capture?.scopeAudit.screenBindings || []).map((item) => item.screenId));
    for (const handshake of registration.componentHandshake) {
      const location = source.registration.path;
      const handshakeKey = JSON.stringify([...handshake.finalNodeIds].sort());
      if (handshakeKeys.has(handshakeKey)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Packet 重复登记相同最终节点集合：' + handshakeKey, location);
      }
      handshakeKeys.add(handshakeKey);
      const inventory = sourceInventories.find((item) => (
        JSON.stringify([...item.nodeIds].sort()) === handshakeKey
      ));
      if (
        !inventory
        || inventory.decision !== handshake.decision
        || JSON.stringify([...inventory.structureSignatures].sort()) !== JSON.stringify([...handshake.structureSignatures].sort())
      ) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Packet Component Handshake 未精确投影到 Component Inventory：' + handshake.proposalId, location);
        continue;
      }
      const proposal = proposals.find((item) => item.id === handshake.proposalId);
      if (matchedProposalIds.has(handshake.proposalId)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '一个已确认 Component Proposal 只能产生一个 Registration Handshake：' + handshake.proposalId, location);
      }
      matchedProposalIds.add(handshake.proposalId);
      if (
        !proposal
        || proposal.decision !== handshake.decision
        || !sameFigmaComponentContract(proposal.figmaComponentContract, handshake.figmaComponentContract)
      ) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Handshake 必须保留已批准 Proposal 的 ID、决定和 Figma 组件事实：' + handshake.proposalId, location);
      }
      for (const evidenceItemId of handshake.baselineEvidenceItemIds) {
        const item = evidenceItems.get(source.id)?.get(evidenceItemId);
        if (!item || !['screenshot', 'design-context'].includes(item.role)) {
          block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Component Handshake baselineEvidenceItemIds 只能引用正式 screenshot/design-context 证据：' + handshake.proposalId + ' / ' + evidenceItemId, location);
        }
      }
      const usagePairs = new Set();
      for (const binding of handshake.usageBindings) {
        const pair = binding.instanceNodeId + '/' + binding.screenId;
        if (usagePairs.has(pair)) {
          block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Component Handshake Usage Binding 重复：' + handshake.proposalId + ' / ' + pair, location);
        }
        usagePairs.add(pair);
        if (!allowedScreenIds.has(binding.screenId)) {
          block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Component Handshake Usage Binding 的 Screen 不在 Scope Audit：' + handshake.proposalId + ' / ' + binding.screenId, location);
        }
        const instance = figmaContexts.get(source.id)?.components.get(binding.instanceNodeId);
        const boundScreenId = scopeScreenId(capture?.scopeAudit.screenBindings, instance?.screenRootNodeId);
        if (instance?.kind !== 'instance' || boundScreenId !== binding.screenId) {
          block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Component Handshake Usage 必须通过 Instance screenRootNodeId 的一个或多个 Viewport/Scenario Binding 唯一解析到同一 Product Screen：' + handshake.proposalId + ' / ' + binding.instanceNodeId, location);
        }
      }
      if (matchedInventoryIds.has(inventory.id)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Component Inventory 被多个 Registration Handshake 重复覆盖：' + inventory.id, location);
      }
      matchedInventoryIds.add(inventory.id);
      if (inventory.decision !== 'shared-component') {
        if (handshake.usageBindings.length > 0) {
          block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '非 shared-component Handshake 不得声明组件 Usage Binding：' + handshake.proposalId, location);
        }
        continue;
      }
      const mapping = model.componentMappings.find((item) => item.inventoryId === inventory.id);
      const expectedDefinitionNodeIds = mapping
        ? model.componentVariantDefinitions.filter((item) => item.mappingId === mapping.id).map((item) => item.figmaComponentNodeId).sort()
        : [];
      const expectedUsages = mapping
        ? model.componentVariantCoverage.filter((item) => item.mappingId === mapping.id).flatMap((item) => item.usages)
        : [];
      const expectedUsageNodeIds = expectedUsages.map((item) => item.instanceNodeId).sort();
      const expectedUsagePairs = expectedUsages.map((item) => item.instanceNodeId + '/' + item.screenId).sort();
      const handshakeUsageNodeIds = handshake.usageBindings.map((item) => item.instanceNodeId).sort();
      const handshakeUsagePairs = handshake.usageBindings.map((item) => item.instanceNodeId + '/' + item.screenId).sort();
      if (
        !mapping
        || handshake.figmaComponentNodeId !== mapping.figmaComponentNodeId
        || JSON.stringify([...handshake.variantDefinitionNodeIds].sort()) !== JSON.stringify(expectedDefinitionNodeIds)
        || JSON.stringify([...handshake.variantUsageInstanceNodeIds].sort()) !== JSON.stringify(expectedUsageNodeIds)
        || JSON.stringify(handshakeUsageNodeIds) !== JSON.stringify(expectedUsageNodeIds)
        || JSON.stringify(handshakeUsagePairs) !== JSON.stringify(expectedUsagePairs)
        || !figmaContractMatchesMapping(handshake.figmaComponentContract, mapping)
      ) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Registration 的 Figma 组件事实与 Product Design Mapping、Definition、Usage 未双向闭合：' + inventory.id, location);
      }
    }
    for (const inventory of sourceInventories) {
      if (!matchedInventoryIds.has(inventory.id)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Component Inventory 缺少 Registration Handshake：' + inventory.id, source.registration.path);
      }
    }
    for (const proposal of proposals) {
      if (!matchedProposalIds.has(proposal.id)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '已确认 Component Proposal 缺少 Registration Handshake：' + proposal.id, source.registration.path);
      }
    }
  }

  const contracts = new Map();
  const contractsByMapping = new Map();
  const implementationOwners = new Map();
  const pageInstanceOwners = new Map();
  const figmaPageInstanceOwners = new Map();
  for (const contract of model.componentContracts) {
    const location = 'componentContracts.' + contract.id;
    if (contracts.has(contract.id)) {
      block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract ID 必须唯一：' + contract.id, location);
    }
    contracts.set(contract.id, contract);
    const mapping = contract.mappingId ? mappings.get(contract.mappingId) : null;
    if (contract.mappingId) {
      if (!mapping || mapping.componentId !== contract.componentId || mapping.litTagName !== contract.litTagName) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract 与 Figma ↔ Lit Mapping 不一致：' + contract.id, location);
        continue;
      }
      if (contractsByMapping.has(contract.mappingId)) block('AIH_COMPONENT_CONTRACT_INVALID', '一个 Mapping 只能对应一个 Component Contract：' + contract.mappingId, location);
      contractsByMapping.set(contract.mappingId, contract.id);
    } else if (contract.figmaInstanceNodeIds.length > 0 || contract.pageInstances.some((item) => item.origin === 'figma')) {
      block('AIH_COMPONENT_CONTRACT_INVALID', '无 Figma Mapping 的 Component Contract 不得声明 Figma Instance：' + contract.id, location);
    }
    for (const implementationPath of contract.implementationPaths) {
      if (implementationOwners.has(implementationPath)) block('AIH_COMPONENT_CONTRACT_INVALID', 'Component implementationPath 必须有唯一 Contract Owner：' + implementationPath, location);
      implementationOwners.set(implementationPath, contract.id);
      try { await readFile(areaFile(areaDirectory, implementationPath)); }
      catch { block('AIH_COMPONENT_CONTRACT_INVALID', 'Component implementationPath 不存在：' + contract.id + ' / ' + implementationPath, location); }
    }
    if (mapping) {
      const mappedSlots = mapping.slotMappings.map((item) => item.litSlot).sort();
      if (JSON.stringify(mappedSlots) !== JSON.stringify([...contract.slots].sort())) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract Slot 与 Mapping 不一致：' + contract.id, location);
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
          block('AIH_COMPONENT_CONTRACT_INVALID', 'Mapping 使用了 Contract 未声明的 Property 或 Attribute：' + contract.id + ' / ' + property.litProperty, location);
        }
      }
      if (JSON.stringify([...mapping.eventIds].sort()) !== JSON.stringify([...contract.eventIds].sort())) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Component Contract Event 与 Mapping 不一致：' + contract.id, location);
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
    const expectedUsages = mapping
      ? model.componentVariantCoverage.filter((item) => item.mappingId === mapping.id).flatMap((item) => item.usages)
      : [];
    const expectedInstanceIds = expectedUsages.map((item) => item.instanceNodeId).sort();
    const expectedUsagePairs = expectedUsages.map((item) => item.screenId + '/' + item.instanceNodeId).sort();
    const figmaPageInstances = contract.pageInstances.filter((item) => item.origin === 'figma');
    const pageInstanceIds = figmaPageInstances.map((item) => item.figmaInstanceNodeId).sort();
    const pageUsagePairs = figmaPageInstances.map((item) => item.screenId + '/' + item.figmaInstanceNodeId).sort();
    if (
      JSON.stringify([...contract.figmaInstanceNodeIds].sort()) !== JSON.stringify(expectedInstanceIds)
      || JSON.stringify(pageInstanceIds) !== JSON.stringify(expectedInstanceIds)
      || JSON.stringify(pageUsagePairs) !== JSON.stringify(expectedUsagePairs)
    ) {
      block('AIH_COMPONENT_CONTRACT_INVALID', 'Definition Usage、Contract Figma Instance 与 Page Instance ↔ Screen 必须双向闭合：' + contract.id, location);
    }
    const declaredScreens = model.screens.filter((item) => item.componentIds.includes(contract.componentId)).map((item) => item.id).sort();
    const instanceScreens = [...new Set(contract.pageInstances.map((item) => item.screenId))].sort();
    if (JSON.stringify(declaredScreens) !== JSON.stringify(instanceScreens)) {
      block('AIH_COMPONENT_CONTRACT_INVALID', 'Screen Component 声明与 Contract Page Instance 必须双向闭合：' + contract.id, location);
    }
    const localPairs = new Set();
    for (const instance of contract.pageInstances) {
      const pairKey = instance.screenId + '/' + instance.id;
      if (localPairs.has(pairKey)) block('AIH_COMPONENT_CONTRACT_INVALID', 'Contract Page Instance 重复：' + contract.id + ' / ' + pairKey, location);
      localPairs.add(pairKey);
      if (pageInstanceOwners.has(instance.id)) block('AIH_COMPONENT_CONTRACT_INVALID', 'Page Instance ID 必须全局唯一：' + instance.id, location);
      pageInstanceOwners.set(instance.id, contract.id);
      const screen = model.screens.find((item) => item.id === instance.screenId);
      if (!screen?.componentIds.includes(contract.componentId)) {
        block('AIH_COMPONENT_CONTRACT_INVALID', 'Page Instance 所属 Screen 未声明该 Component：' + contract.id + ' / ' + instance.screenId, location);
      }
      if (instance.origin === 'figma') {
        if (figmaPageInstanceOwners.has(instance.figmaInstanceNodeId)) {
          block('AIH_COMPONENT_CONTRACT_INVALID', 'Figma Instance 只能属于一个 Page Instance：' + instance.figmaInstanceNodeId, location);
        }
        figmaPageInstanceOwners.set(instance.figmaInstanceNodeId, instance.id);
        const coveredInstance = mapping && coveredInstances.get(mapping.id + '/' + instance.figmaInstanceNodeId);
        if (!coveredInstance || coveredInstance.usage.screenId !== instance.screenId) {
          block('AIH_COMPONENT_CONTRACT_INVALID', 'Contract Figma Page Instance 必须与同一 Usage、Scope Screen Binding 的 Screen 闭合：' + contract.id + ' / ' + instance.id, location);
        }
      }
    }
    const knownTargets = new Set([
      contract.componentId,
      ...model.controls.filter((item) => item.componentId === contract.componentId).map((item) => item.id),
      ...model.states.filter((item) => item.ownerId === contract.componentId).map((item) => item.id),
    ]);
    for (const assertion of contract.testAssertions) {
      const matrixEntry = assertion.stateMatrixEntryId && model.stateMatrix.find((item) => (
        item.id === assertion.stateMatrixEntryId
        && item.componentContractId === contract.id
        && item.classification === 'legal'
      ));
      if (!knownTargets.has(assertion.targetId)) block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'Component Contract Test Assertion 引用组件外目标：' + contract.id + ' / ' + assertion.targetId, location);
      if (['disabled', 'aria'].includes(assertion.kind) && !matrixEntry) block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'Disabled/ARIA 断言必须引用本组件合法 State Matrix Entry：' + contract.id, location);
      if (assertion.kind === 'disabled' && typeof assertion.expected !== 'boolean') block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'Disabled 断言 expected 必须是 boolean：' + contract.id, location);
      if (assertion.kind === 'aria' && (typeof assertion.expected !== 'string' || !assertion.attribute?.startsWith('aria-'))) {
        block('AIH_COMPONENT_CONTRACT_TEST_INVALID', 'ARIA 断言必须声明 aria-* Attribute 与字符串 expected：' + contract.id, location);
      }
    }
  }
  for (const mapping of model.componentMappings) {
    if (!contractsByMapping.has(mapping.id)) block('AIH_COMPONENT_CONTRACT_INVALID', '每个 Figma ↔ Lit Mapping 必须有且仅有一个 Component Contract：' + mapping.id, 'componentContracts');
  }
  for (const component of model.components) {
    const owners = model.componentContracts.filter((item) => item.componentId === component.id);
    if (owners.length !== 1) block('AIH_COMPONENT_CONTRACT_INVALID', '每个 Canonical Component 必须有且仅有一个 Component Contract：' + component.id, 'componentContracts');
  }
  for (const screen of model.screens) {
    const shellInstances = model.componentContracts.flatMap((contract) => (
      contract.implementationRole === 'app-shell'
        ? contract.pageInstances
          .filter((instance) => instance.screenId === screen.id)
          .map((instance) => ({ contract, instance }))
        : []
    ));
    if (shellInstances.length !== 1) {
      block(
        'AIH_COMPONENT_CONTRACT_INVALID',
        '每个 Screen 必须且只能声明一个 app-shell Page Instance：' + screen.id + '，实际为 ' + shellInstances.length + ' 个。',
        'componentContracts',
      );
    }
  }
  const tokenPropertyOwners = new Map();
  for (const token of model.tokens) {
    const location = 'tokens.' + token.id;
    if (!Array.isArray(token.targetIds) || token.targetIds.length === 0 || !/^--[a-z0-9-]+$/.test(token.cssProperty || '')) {
      block('AIH_COMPONENT_CONTRACT_INVALID', 'Token 必须声明非空 targetIds 与合法 cssProperty：' + token.id, location);
      continue;
    }
    if (tokenPropertyOwners.has(token.cssProperty)) {
      block(
        'AIH_COMPONENT_CONTRACT_INVALID',
        '同一 CSS Custom Property 只能由一个 Token 拥有：' + token.cssProperty + ' / ' + tokenPropertyOwners.get(token.cssProperty) + ' / ' + token.id,
        location,
      );
    }
    tokenPropertyOwners.set(token.cssProperty, token.id);
    for (const targetId of token.targetIds) {
      const component = model.components.find((item) => item.id === targetId);
      const control = model.controls.find((item) => item.id === targetId);
      const state = model.states.find((item) => item.id === targetId);
      const screenId = model.screens.some((item) => item.id === targetId)
        ? targetId
        : state?.scope === 'workflow'
          ? state.ownerId
          : null;
      const ownerComponentIds = component
        ? [component.id]
        : control
          ? [control.componentId]
          : state?.scope === 'component'
            ? [state.ownerId]
            : screenId
              ? model.componentContracts
                .filter((contract) => (
                  contract.implementationRole === 'app-shell'
                  && contract.pageInstances.some((instance) => instance.screenId === screenId)
                ))
                .map((contract) => contract.componentId)
              : [];
      const ownerContracts = model.componentContracts.filter((contract) => ownerComponentIds.includes(contract.componentId));
      if (ownerContracts.length !== 1) {
        block(
          'AIH_COMPONENT_CONTRACT_INVALID',
          'Token target 必须解析到唯一 Component Contract：' + token.id + ' / ' + targetId,
          location,
        );
      }
    }
  }

  const axesByContract = new Map();
  const stateAxisOwners = new Map();
  const stateAxisIds = new Set();
  const axisSignaturesByContract = new Map();
  const contentBindingTargetsByContract = new Map();
  for (const axis of model.stateAxes) {
    const location = 'stateAxes.' + axis.id;
    if (stateAxisIds.has(axis.id)) {
      block('AIH_STATE_MATRIX_INVALID', 'State Axis ID 必须全局唯一：' + axis.id, location);
    }
    stateAxisIds.add(axis.id);
    const contract = contracts.get(axis.componentContractId);
    if (!contract) {
      block('AIH_STATE_MATRIX_INVALID', 'State Axis 引用未知 Component Contract：' + axis.id, location);
      continue;
    }
    if (!axesByContract.has(contract.id)) axesByContract.set(contract.id, []);
    axesByContract.get(contract.id).push(axis);
    if (!axisSignaturesByContract.has(contract.id)) axisSignaturesByContract.set(contract.id, new Set());
    const axisSignature = axis.kind + '/' + axis.name;
    if (axisSignaturesByContract.get(contract.id).has(axisSignature)) {
      block('AIH_STATE_MATRIX_INVALID', '同一 Component Contract 不得重复声明相同类型与名称的 State Axis：' + contract.id + ' / ' + axisSignature, location);
    }
    axisSignaturesByContract.get(contract.id).add(axisSignature);

    const valueIds = new Set();
    const values = new Set();
    const renderValues = new Set();
    for (const value of axis.values) {
      if (valueIds.has(value.id)) block('AIH_STATE_MATRIX_INVALID', 'State Axis Value ID 重复：' + axis.id + ' / ' + value.id, location);
      if (values.has(value.value)) block('AIH_STATE_MATRIX_INVALID', 'State Axis 有重复语义值：' + axis.id + ' / ' + value.value, location);
      valueIds.add(value.id);
      values.add(value.value);
      const state = value.stateId && model.states.find((item) => item.id === value.stateId);
      if (['runtime-state', 'interaction-state'].includes(axis.kind)) {
        const expectedScope = axis.kind === 'runtime-state' ? 'component' : 'workflow';
        const allowedWorkflowOwners = new Set(contract.pageInstances.map((item) => item.screenId));
        if (
          !state
          || state.scope !== expectedScope
          || (expectedScope === 'component' && state.ownerId !== contract.componentId)
          || (expectedScope === 'workflow' && !allowedWorkflowOwners.has(state.ownerId))
        ) {
          block('AIH_STATE_MATRIX_INVALID', 'Runtime/Interaction State 轴值必须引用本组件或其 Screen 的匹配作用域 State：' + axis.id + ' / ' + value.id, location);
        }
        if (axis.kind === 'interaction-state' && Object.hasOwn(value, 'renderValue')) {
          block('AIH_STATE_MATRIX_INVALID', 'Interaction State 轴值只作为 Workflow 观测标记，不得声明 renderValue：' + axis.id + ' / ' + value.id, location);
        }
        if (value.stateId) {
          const previousAxis = stateAxisOwners.get(value.stateId);
          if (previousAxis && previousAxis !== axis.id) {
            block('AIH_STATE_MATRIX_INVALID', '同一 State 不得被多个 State Axis 重复建模：' + value.stateId, location);
          }
          stateAxisOwners.set(value.stateId, axis.id);
        }
      } else {
        if (value.stateId) {
          block('AIH_STATE_MATRIX_INVALID', 'Variant 与 Content Override 轴值不得伪装成 Runtime/Interaction State：' + axis.id + ' / ' + value.id, location);
        }
        if (
          axis.kind === 'variant'
          && axis.renderBinding.kind === 'mapped-variant'
          && Object.hasOwn(value, 'renderValue')
        ) {
          block('AIH_STATE_MATRIX_INVALID', 'Mapping Variant State Axis 不得重复声明 renderValue：' + axis.id + ' / ' + value.id, location);
        }
        if (
          axis.kind === 'variant'
          && axis.renderBinding.kind !== 'mapped-variant'
          && !Object.hasOwn(value, 'renderValue')
        ) {
          block('AIH_STATE_MATRIX_INVALID', '直接 Lit Variant State Axis 的每个值必须声明 renderValue：' + axis.id + ' / ' + value.id, location);
        }
        if (axis.kind === 'content-override' || (axis.kind === 'variant' && axis.renderBinding.kind !== 'mapped-variant')) {
          const renderKey = canonicalJson(value.renderValue);
          if (renderValues.has(renderKey)) {
            block('AIH_STATE_MATRIX_INVALID', '直接渲染轴值的 renderValue 必须唯一：' + axis.id + ' / ' + value.id, location);
          }
          renderValues.add(renderKey);
        }
      }
    }

    if (axis.kind === 'variant') {
      if (axis.renderBinding.kind === 'mapped-variant') {
        const mapping = contract.mappingId ? mappings.get(contract.mappingId) : null;
        const property = mapping?.propertyMappings.find((item) => item.kind === 'variant' && item.figmaProperty === axis.name);
        const expected = property?.values.map((item) => item.figmaValue).sort() || [];
        const actual = axis.values.map((item) => item.value).sort();
        if (!property || JSON.stringify(expected) !== JSON.stringify(actual)) {
          block('AIH_STATE_MATRIX_INVALID', 'Mapping Variant State Axis 必须一对一精确复用 Figma Variant 的有限值：' + axis.id, location);
        }
      } else if (axis.renderBinding.kind === 'lit-property') {
        if (!contract.properties.some((item) => item.name === axis.renderBinding.name)) {
          block('AIH_STATE_MATRIX_INVALID', '直接 Variant renderBinding 必须引用 Contract 已声明的公开 Lit Property：' + axis.id, location);
        }
      } else if (axis.renderBinding.kind === 'lit-attribute') {
        if (!contract.attributes.some((item) => item.name === axis.renderBinding.name)) {
          block('AIH_STATE_MATRIX_INVALID', '直接 Variant renderBinding 必须引用 Contract 已声明的公开 Lit Attribute：' + axis.id, location);
        }
      }
    }

    if (axis.kind === 'interaction-state') {
      const screenIds = new Set(contract.pageInstances.map((item) => item.screenId));
      const routeIds = new Set(model.routes.filter((item) => screenIds.has(item.screenId)).map((item) => item.id));
      if (
        axis.renderBinding.name
        && !contract.properties.some((property) => property.name === axis.renderBinding.name)
      ) {
        block(
          'AIH_STATE_MATRIX_INVALID',
          'Interaction State renderBinding 必须引用 Contract 已声明的公开 Lit Property：' + axis.id,
          location,
        );
      }
      for (const value of axis.values) {
        const observedInScenario = model.scenarios.some((scenario) => (
          routeIds.has(scenario.routeId)
          && [
            ...scenario.initialStateIds,
            ...scenario.expectedStateIds,
            ...scenario.recoveryStateIds,
          ].includes(value.stateId)
        ));
        if (!observedInScenario) {
          block(
            'AIH_STATE_MATRIX_INVALID',
            'Interaction State Axis 的每个值必须在对应 Screen 的正式 Scenario 中可观察：' + axis.id + ' / ' + value.id,
            location,
          );
        }
      }
    }

    if (axis.kind === 'runtime-state') {
      const property = contract.properties.find((item) => item.name === axis.renderBinding.name);
      if (!property) {
        block(
          'AIH_STATE_MATRIX_INVALID',
          'Runtime State renderBinding 必须引用 Contract 已声明的公开 Lit Property：' + axis.id,
          location,
        );
      }
    }

    if (axis.kind === 'content-override') {
      const binding = axis.renderBinding;
      const propertyNames = new Set(contract.properties.map((item) => item.name));
      const attributes = new Map(contract.attributes.map((item) => [item.name, item]));
      const slotNames = new Set(contract.slots);
      let targetKey = null;
      if (binding.kind === 'lit-property' && propertyNames.has(binding.name)) {
        targetKey = 'property/' + binding.name;
      } else if (binding.kind === 'lit-attribute' && attributes.has(binding.name)) {
        targetKey = 'property/' + attributes.get(binding.name).propertyName;
      } else if (binding.kind === 'slot-text' && slotNames.has(binding.name)) {
        targetKey = 'slot/' + binding.name;
      } else {
        block('AIH_STATE_MATRIX_INVALID', 'Content Override renderBinding 必须引用 Contract 已声明的 Property、Attribute 或 Slot：' + axis.id, location);
      }
      if (targetKey) {
        if (!contentBindingTargetsByContract.has(contract.id)) contentBindingTargetsByContract.set(contract.id, new Map());
        const previousAxis = contentBindingTargetsByContract.get(contract.id).get(targetKey);
        if (previousAxis && previousAxis !== axis.id) {
          block('AIH_STATE_MATRIX_INVALID', '同一渲染目标不得被多个 Content Override Axis 重复控制：' + contract.id + ' / ' + targetKey, location);
        }
        contentBindingTargetsByContract.get(contract.id).set(targetKey, axis.id);
      }
    }
  }

  const matrixEntryOwners = new Map();
  for (const entry of model.stateMatrix) {
    if (matrixEntryOwners.has(entry.id)) {
      block('AIH_STATE_MATRIX_INVALID', 'State Matrix Entry ID 必须全局唯一：' + entry.id, 'stateMatrix.' + entry.id);
    }
    matrixEntryOwners.set(entry.id, entry.componentContractId);
    if (!contracts.has(entry.componentContractId)) {
      block('AIH_STATE_MATRIX_INVALID', 'State Matrix Entry 引用未知 Component Contract：' + entry.id, 'stateMatrix.' + entry.id);
    }
  }

  for (const contract of model.componentContracts) {
    const location = 'stateMatrix.' + contract.id;
    const axes = axesByContract.get(contract.id) || [];
    const axesByKind = new Map(
      ['variant', 'runtime-state', 'interaction-state', 'content-override']
        .map((kind) => [kind, axes.filter((item) => item.kind === kind)]),
    );
    for (const disposition of contract.stateAxisCoverage) {
      const modeled = (axesByKind.get(disposition.kind) || []).length > 0;
      if ((modeled && disposition.status !== 'modeled') || (!modeled && disposition.status !== 'not-applicable')) {
        block('AIH_STATE_MATRIX_INVALID', 'State Axis Coverage 必须与实际有限轴一致：' + contract.id + ' / ' + disposition.kind, 'componentContracts.' + contract.id);
      }
    }
    if ((axesByKind.get('runtime-state') || []).length > 1) {
      block('AIH_STATE_MATRIX_INVALID', '每个 Component Contract 最多声明一个 Runtime State Axis：' + contract.id, location);
    }
    const component = model.components.find((item) => item.id === contract.componentId);
    const runtimeStateIds = (axesByKind.get('runtime-state') || []).flatMap((axis) => axis.values.map((value) => value.stateId)).sort();
    if (JSON.stringify(runtimeStateIds) !== JSON.stringify([...(component?.stateIds || [])].sort())) {
      block('AIH_STATE_MATRIX_INVALID', 'Runtime State Axis 必须全部且仅覆盖 Component 声明的 State：' + contract.id, location);
    }
    const mapping = contract.mappingId ? mappings.get(contract.mappingId) : null;
    const expectedVariantAxes = mapping
      ? mapping.propertyMappings.filter((item) => item.kind === 'variant').map((item) => item.figmaProperty).sort()
      : [];
    const actualVariantAxes = (axesByKind.get('variant') || [])
      .filter((item) => item.renderBinding.kind === 'mapped-variant')
      .map((item) => item.name)
      .sort();
    if (JSON.stringify(expectedVariantAxes) !== JSON.stringify(actualVariantAxes)) {
      block('AIH_STATE_MATRIX_INVALID', 'Mapping Variant State Axis 必须全部且仅覆盖 Mapping 声明的 Variant 属性：' + contract.id, location);
    }

    if (axes.length === 0) {
      block('AIH_STATE_MATRIX_INVALID', 'Component Contract 至少需要一个有限 State Axis：' + contract.id, location);
      continue;
    }
    const axisIds = new Set();
    for (const axis of axes) {
      if (axisIds.has(axis.id)) block('AIH_STATE_MATRIX_INVALID', 'Component Contract 的 State Axis ID 重复：' + axis.id, location);
      axisIds.add(axis.id);
    }
    const expectedKeys = [];
    const visit = (index, selectedValues) => {
      if (index === axes.length) {
        expectedKeys.push(Object.entries(selectedValues).sort(([left], [right]) => left.localeCompare(right)).map(([axisId, valueId]) => axisId + '=' + valueId).join('|'));
        return;
      }
      for (const value of axes[index].values) visit(index + 1, { ...selectedValues, [axes[index].id]: value.id });
    };
    visit(0, {});
    if (expectedKeys.length > 512) {
      block('AIH_STATE_MATRIX_INVALID', 'State Matrix 的有限组合超过 512，必须收窄组件轴：' + contract.id, location);
      continue;
    }
    const entries = model.stateMatrix.filter((item) => item.componentContractId === contract.id);
    const observed = new Map();
    const legalValuePairs = new Set();
    const matrixCoveredDefinitions = new Set();
    for (const entry of entries) {
      const entryLocation = 'stateMatrix.' + entry.id;
      const key = Object.entries(entry.values).sort(([left], [right]) => left.localeCompare(right)).map(([axisId, valueId]) => axisId + '=' + valueId).join('|');
      if (observed.has(key)) block('AIH_STATE_MATRIX_INVALID', 'State Matrix 组合重复：' + contract.id + ' / ' + key, entryLocation);
      observed.set(key, entry);
      for (const [axisId, valueId] of Object.entries(entry.values)) {
        const axis = axes.find((item) => item.id === axisId);
        if (!axis || !axis.values.some((item) => item.id === valueId)) {
          block('AIH_STATE_MATRIX_INVALID', 'State Matrix 引用未知 Axis 或 Value：' + entry.id + ' / ' + axisId + '=' + valueId, entryLocation);
        } else if (entry.classification === 'legal') {
          legalValuePairs.add(axisId + '/' + valueId);
        }
      }
      if (entry.classification === 'legal' && mapping) {
        const selectedVariantProperties = {};
        for (const axis of axesByKind.get('variant') || []) {
          const selected = axis.values.find((item) => item.id === entry.values[axis.id]);
          if (selected) selectedVariantProperties[axis.name] = selected.value;
        }
        const matchedDefinitions = model.componentVariantDefinitions.filter((item) => (
          item.mappingId === mapping.id && sameStringRecord(item.figmaVariantProperties, selectedVariantProperties)
        ));
        if (matchedDefinitions.length !== 1) {
          block('AIH_STATE_MATRIX_INVALID', '合法 Matrix Entry 必须精确解析到一个 Variant Definition：' + entry.id, entryLocation);
        } else {
          matrixCoveredDefinitions.add(matchedDefinitions[0].id);
        }
      }
    }
    for (const key of expectedKeys) {
      if (!observed.has(key)) block('AIH_STATE_MATRIX_INVALID', 'State Matrix 未分类有限组合：' + contract.id + ' / ' + key, location);
    }
    for (const key of observed.keys()) {
      if (!expectedKeys.includes(key)) block('AIH_STATE_MATRIX_INVALID', 'State Matrix 包含轴集合不完整或额外组合：' + contract.id + ' / ' + key, location);
    }
    for (const axis of axes) {
      for (const value of axis.values) {
        if (!legalValuePairs.has(axis.id + '/' + value.id)) {
          block('AIH_STATE_MATRIX_INVALID', '每个 State Axis Value 必须至少出现在一个合法 Matrix Entry：' + axis.id + ' / ' + value.id, location);
        }
      }
    }
    if (mapping) {
      for (const definition of model.componentVariantDefinitions.filter((item) => item.mappingId === mapping.id)) {
        if (!matrixCoveredDefinitions.has(definition.id)) {
          block('AIH_STATE_MATRIX_INVALID', '每个 Variant Definition 必须至少由一个合法 Matrix Entry 覆盖：' + definition.id, location);
        }
      }
    }
    const defaultEntry = entries.find((item) => item.id === contract.defaultStateMatrixEntryId);
    if (!defaultEntry || defaultEntry.classification !== 'legal') {
      block('AIH_STATE_MATRIX_INVALID', 'Component Contract 默认状态必须引用合法 Matrix Entry：' + contract.id, location);
    }
  }

  const uiCaseAnalysis = analyzeUiCaseCoverage(model, upstreamModels['visual-spec']);
  for (const item of uiCaseAnalysis.blockers) block(item.code, item.message, item.location);

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

  const componentParityIds = new Set();
  const componentParityTuples = new Set();
  for (const assertion of model.componentSourceParityAssertions || []) {
    const location = 'componentSourceParityAssertions.' + assertion.id;
    if (componentParityIds.has(assertion.id)) {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Component Source Parity Assertion ID 必须唯一：' + assertion.id, location);
    }
    componentParityIds.add(assertion.id);
    const tuple = assertion.componentContractId + '/' + assertion.pageInstanceId + '/' + assertion.stateMatrixEntryId + '/' + assertion.viewportId;
    if (componentParityTuples.has(tuple)) {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', '同一 Component/Page/Matrix/Viewport 必须合并为一个来源一致性断言：' + tuple, location);
    }
    componentParityTuples.add(tuple);

    const source = model.designSources.find((item) => item.id === assertion.sourceId);
    const contract = contracts.get(assertion.componentContractId);
    const mapping = contract?.mappingId ? mappings.get(contract.mappingId) : null;
    const pageInstance = contract?.pageInstances.find((item) => item.id === assertion.pageInstanceId);
    const matrixEntry = model.stateMatrix.find((item) => (
      item.id === assertion.stateMatrixEntryId
      && item.componentContractId === assertion.componentContractId
      && item.classification === 'legal'
    ));
    const viewport = model.viewports.find((item) => item.id === assertion.viewportId);
    if (
      source?.kind !== 'figma'
      || source.status === 'blocked'
      || !sourceRegistrations.has(assertion.sourceId)
      || !contract
      || !mapping
      || mapping.sourceId !== assertion.sourceId
      || !pageInstance
      || pageInstance.origin !== 'figma'
      || !matrixEntry
      || !viewport
    ) {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Component Source Parity 必须闭合到可用 Figma Registration、Mapping、Figma Page Instance、合法 Matrix Entry 与 Viewport：' + assertion.id, location);
      continue;
    }
    if (policy.mode === 'exact' && source.status !== 'available') {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式的 Component Source Parity 不接受局部来源：' + assertion.sourceId, location);
    }

    const coveredInstance = coveredInstances.get(mapping.id + '/' + pageInstance.figmaInstanceNodeId);
    if (!coveredInstance || coveredInstance.usage.screenId !== pageInstance.screenId) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Component Source Parity 的 Page Instance 未解析到同一 Instance ↔ Screen Usage：' + assertion.pageInstanceId, location);
      continue;
    }
    const axes = axesByContract.get(contract.id) || [];
    const selectedVariantProperties = {};
    const selectedStateIds = [];
    for (const axis of axes) {
      const selected = axis.values.find((item) => item.id === matrixEntry.values[axis.id]);
      if (axis.kind === 'variant' && selected) selectedVariantProperties[axis.name] = selected.value;
      if (selected?.stateId) selectedStateIds.push(selected.stateId);
    }
    if (policy.mode !== 'exact' && !sameStringRecord(selectedVariantProperties, coveredInstance.definition.figmaVariantProperties)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Component Source Parity 的 Matrix Variant 与该 Figma Usage Definition 不一致：' + assertion.id, location);
    }

    const sourceCoverage = source.coverage.find((item) => (
      item.screenId === pageInstance.screenId
      && item.viewportIds.includes(assertion.viewportId)
      && item.evidenceItemIds.includes(assertion.baselineEvidenceItemId)
      && selectedStateIds.every((stateId) => item.stateIds.includes(stateId))
    ));
    const policyCoverage = policy.coverage.find((item) => (
      item.sourceId === assertion.sourceId
      && item.screenId === pageInstance.screenId
      && item.viewportIds.includes(assertion.viewportId)
      && item.evidenceItemIds.includes(assertion.baselineEvidenceItemId)
      && selectedStateIds.every((stateId) => item.stateIds.includes(stateId))
    ));
    if (!sourceCoverage || !policyCoverage) {
      block('AIH_VISUAL_DEVIATION_UNAPPROVED', 'Component Source Parity 超出来源或视觉策略登记的 Screen/State/Viewport/Evidence 覆盖：' + assertion.id, location);
    }
    const baseline = evidenceItems.get(assertion.sourceId)?.get(assertion.baselineEvidenceItemId);
    const handshake = sourceRegistrations.get(assertion.sourceId)?.componentHandshake.find((item) => (
      item.decision === 'shared-component'
      && item.figmaComponentNodeId === mapping.figmaComponentNodeId
    ));
    if (
      !baseline
      || baseline.role !== 'screenshot'
      || baseline.sourceNodeId !== pageInstance.figmaInstanceNodeId
      || !handshake?.baselineEvidenceItemIds.includes(assertion.baselineEvidenceItemId)
    ) {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Component Source Parity 基线必须是该 Handshake 已登记的 Figma Instance screenshot 证据项：' + assertion.id, location);
    }
    for (const aspect of assertion.aspects) {
      if (!policyAspects.has(aspect)) {
        block('AIH_VISUAL_DEVIATION_UNAPPROVED', 'Component Source Parity 超出视觉策略声明方面：' + aspect, location);
      }
    }
    const knownTargets = new Set([
      contract.componentId,
      pageInstance.id,
      ...model.controls.filter((item) => item.componentId === contract.componentId).map((item) => item.id),
    ]);
    for (const check of assertion.checks) {
      if (check.kind === 'computed-style' && !knownTargets.has(check.targetId)) {
        block('AIH_VISUAL_SOURCE_INCOMPLETE', 'Component Source Parity computed-style 引用组件外目标：' + check.targetId, location);
      }
    }
  }

  if (policy.mode === 'guided') {
    for (const contract of model.componentContracts.filter((item) => item.mappingId)) {
      if (!model.componentSourceParityAssertions.some((item) => item.componentContractId === contract.id)) {
        block('AIH_VISUAL_SOURCE_INCOMPLETE', '部分参考模式下每个已映射组件至少需要一个 Component Source Parity 基线：' + contract.id, 'componentSourceParityAssertions');
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
    const expectedComponentParityTuples = new Set();
    for (const contract of model.componentContracts.filter((item) => item.mappingId)) {
      const mapping = mappings.get(contract.mappingId);
      const source = mapping && model.designSources.find((item) => item.id === mapping.sourceId);
      const legalEntries = model.stateMatrix.filter((item) => (
        item.componentContractId === contract.id && item.classification === 'legal'
      ));
      for (const pageInstance of contract.pageInstances.filter((item) => item.origin === 'figma')) {
        const viewportIds = [...new Set(
          (source?.coverage || [])
            .filter((item) => item.screenId === pageInstance.screenId)
            .flatMap((item) => item.viewportIds),
        )];
        if (viewportIds.length === 0) {
          block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式的 Figma Page Instance 缺少来源 Viewport 覆盖：' + pageInstance.id, 'componentSourceParityAssertions');
        }
        for (const viewportId of viewportIds) {
          for (const entry of legalEntries) {
            const tuple = contract.id + '/' + pageInstance.id + '/' + entry.id + '/' + viewportId;
            expectedComponentParityTuples.add(tuple);
            const assertions = model.componentSourceParityAssertions.filter((assertion) => (
              assertion.componentContractId === contract.id
              && assertion.pageInstanceId === pageInstance.id
              && assertion.stateMatrixEntryId === entry.id
              && assertion.viewportId === viewportId
            ));
            if (assertions.length !== 1) {
              block(
                'AIH_VISUAL_SOURCE_INCOMPLETE',
                '完全实现模式要求每个 Figma Page Instance / Viewport / 合法 Matrix Entry 恰好一条 Component Source Parity 断言：' + tuple + '（实际 ' + assertions.length + ' 条）',
                'componentSourceParityAssertions',
              );
            }
          }
        }
      }
    }
    for (const assertion of model.componentSourceParityAssertions) {
      const tuple = assertion.componentContractId + '/' + assertion.pageInstanceId + '/' + assertion.stateMatrixEntryId + '/' + assertion.viewportId;
      if (!expectedComponentParityTuples.has(tuple)) {
        block('AIH_VISUAL_SOURCE_INCOMPLETE', '完全实现模式的 Component Source Parity 断言未绑定声明范围内的 Contract / Figma Page / 合法 Matrix / Viewport：' + tuple, 'componentSourceParityAssertions.' + assertion.id);
      }
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
