#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import {
  artifactPaths,
  artifactDefinition,
  loadProject,
  readJson,
  repositoryFile,
  repositoryRootFrom,
} from '../../../runtime/project.mjs';
import {
  createSchemaValidatorCache,
  same,
  sameStringSet,
  validateFigmaAssetClosure,
  validateFigmaDesignContext,
  validateFigmaWorkflow,
} from './lib/figma-contract-validation.mjs';
import { analyzePng } from './validate-png-assets.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const json = process.argv.includes('--json');
const blockers = [];
const schemaValidators = createSchemaValidatorCache((schemaPath) => readJson(root, schemaPath));

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function within(directory, path) {
  const base = resolve(directory);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}

function packetFile(packetPath, relativePath) {
  const directory = dirname(packetPath);
  const target = resolve(directory, ...relativePath.split('/'));
  if (!within(directory, target)) {
    throw Object.assign(new Error('Packet 文件越出会话临时目录：' + relativePath), { code: 'AIH_ASSET_MISSING' });
  }
  return target;
}

function areaFile(areaDirectory, relativePath) {
  const target = resolve(areaDirectory, ...relativePath.split('/'));
  if (!within(areaDirectory, target)) {
    throw Object.assign(new Error('目标越出 Canonical UI Area：' + relativePath), { code: 'AIH_ASSET_CLOSURE_FAILED' });
  }
  return target;
}

async function validatePacket(schemaPath, value, label, code = 'AIH_ASSET_CLASSIFICATION_INCOMPLETE') {
  const validate = await schemaValidators.get(schemaPath);
  if (validate(value)) return true;
  for (const error of validate.errors || []) {
    block(code, label + ' 结构无效：' + (error.instancePath || '/') + ' ' + error.message, schemaPath);
  }
  return false;
}


function validateHandshake(plan, context, registration, evidence) {
  const proposals = new Map(plan.scopeAudit.componentProposals.map((item) => [item.id, item]));
  const components = new Map(context.components.map((item) => [item.nodeId, item]));
  const catalogs = new Map(context.componentSetCatalog.map((item) => [item.componentSetNodeId, item]));
  const handshakes = new Map();
  const owners = new Map();
  const evidenceItems = new Map((evidence.items || []).map((item) => [item.id, item]));
  const screensByRoot = new Map();
  for (const binding of plan.scopeAudit.screenBindings) {
    if (!screensByRoot.has(binding.figmaRootNodeId)) screensByRoot.set(binding.figmaRootNodeId, new Set());
    screensByRoot.get(binding.figmaRootNodeId).add(binding.screenId);
  }

  for (const handshake of registration.componentHandshake) {
    if (handshakes.has(handshake.proposalId)) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Handshake 重复：' + handshake.proposalId, 'componentHandshake');
    }
    handshakes.set(handshake.proposalId, handshake);
    const proposal = proposals.get(handshake.proposalId);
    if (
      !proposal
      || proposal.decision !== handshake.decision
      || !same(proposal.figmaComponentContract, handshake.figmaComponentContract)
    ) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Handshake 必须原样保留 Figma Component Contract：' + handshake.proposalId, 'componentHandshake');
    }
    const signatures = new Set();
    for (const nodeId of handshake.finalNodeIds) {
      const component = components.get(nodeId);
      if (!component || owners.has(nodeId)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Handshake 引用未知或重复拥有组件节点：' + nodeId, 'componentHandshake');
      } else {
        signatures.add(component.structureSignature);
      }
      owners.set(nodeId, handshake.proposalId);
    }
    if (!sameStringSet(handshake.structureSignatures, [...signatures])) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Handshake 结构签名与正式组件不一致：' + handshake.proposalId, 'componentHandshake');
    }
    for (const itemId of handshake.baselineEvidenceItemIds) {
      const item = evidenceItems.get(itemId);
      if (!['screenshot', 'design-context'].includes(item?.role)) {
        block('AIH_SOURCE_INTEGRITY_FAILED', 'Baseline Evidence 必须引用正式截图或 Design Context：' + itemId, 'componentHandshake');
      }
    }
    if (handshake.decision !== 'shared-component') {
      if (handshake.usageBindings.length > 0) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '非共享提案不得声明 Instance Usage。', 'componentHandshake');
      }
      continue;
    }
    const rootComponent = components.get(handshake.figmaComponentNodeId);
    const expectedDefinitions = rootComponent?.kind === 'component-set'
      ? catalogs.get(rootComponent.nodeId)?.definitionNodeIds || []
      : rootComponent?.kind === 'component' ? [rootComponent.nodeId] : [];
    if (!sameStringSet(handshake.variantDefinitionNodeIds, expectedDefinitions)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Handshake 未覆盖全部 Variant Definition：' + handshake.proposalId, 'componentHandshake');
    }
    const expectedInstances = context.components
      .filter((item) => item.kind === 'instance' && expectedDefinitions.includes(item.mainComponentNodeId))
      .map((item) => item.nodeId);
    if (!sameStringSet(handshake.variantUsageInstanceNodeIds, expectedInstances)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Handshake 未覆盖全部使用中 Instance：' + handshake.proposalId, 'componentHandshake');
    }
    if (!sameStringSet(handshake.usageBindings.map((item) => item.instanceNodeId), expectedInstances)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Usage Binding 必须精确覆盖 Instance：' + handshake.proposalId, 'componentHandshake');
    }
    for (const usage of handshake.usageBindings) {
      const instance = components.get(usage.instanceNodeId);
      if (!screensByRoot.get(instance?.screenRootNodeId)?.has(usage.screenId)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Usage Binding 未解析到同一 Product Screen：' + usage.instanceNodeId, 'componentHandshake');
      }
    }
    const finalAxes = rootComponent?.kind === 'component-set' ? catalogs.get(rootComponent.nodeId)?.axes || [] : [];
    const contractAxes = handshake.figmaComponentContract.variantAxes;
    if (!sameStringSet(finalAxes.map((axis) => axis.name), contractAxes.map((axis) => axis.name))) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Component Contract 与最终 Component Set 轴不一致：' + handshake.proposalId, 'componentHandshake');
    } else {
      for (const axis of finalAxes) {
        const contractAxis = contractAxes.find((item) => item.name === axis.name);
        if (!sameStringSet(axis.values, contractAxis?.values || [])) {
          block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Component Contract 与最终轴值不一致：' + handshake.proposalId + '/' + axis.name, 'componentHandshake');
        }
      }
    }
  }
  if (!sameStringSet([...handshakes.keys()], [...proposals.keys()])) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '每个组件提案必须恰好有一个 Registration Handshake。', 'componentHandshake');
  }
  if (!sameStringSet([...owners.keys()], [...components.keys()])) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Handshake 必须唯一分区全部正式组件节点。', 'componentHandshake');
  }
}

async function loadArea(actor) {
  const project = await loadProject(root);
  if (project.stages?.['product-design']?.status !== 'active') {
    block('AIH_STAGE_UNINITIALIZED', 'Figma Asset Operation 只允许在 active Product Design 阶段执行。', 'product-design');
  }
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const areaDirectory = repositoryFile(root, paths.authorityRoot + '/' + actor);
  try {
    await access(areaDirectory);
  } catch {
    block('AIH_ASSET_CLOSURE_FAILED', 'Canonical UI 参与者 Area 不存在：' + actor, paths.authorityRoot);
  }
  const artifact = artifactDefinition(project, 'canonical-ui-prototype', 'product-design');
  if (!artifact || artifact.authorityKind !== 'area-set') {
    block('AIH_ASSET_CLOSURE_FAILED', 'Canonical UI Artifact 未绑定 area-set。', 'canonical-ui-prototype');
  }
  return areaDirectory;
}

async function readAreaReference(areaDirectory, reference, role) {
  try {
    const path = areaFile(areaDirectory, reference.path);
    const content = await readFile(path);
    if (sha256(content) !== reference.sha256) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration 引用文件哈希不匹配：' + role, reference.path);
      return null;
    }
    return { path, content, value: JSON.parse(content.toString('utf8')) };
  } catch (error) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration 引用文件不可读：' + role + ' / ' + error.message, reference.path);
    return null;
  }
}

async function validateRegistration(actor, registrationPath) {
  if (!within(tmpdir(), registrationPath)) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 必须位于操作系统临时目录。', registrationPath);
    return null;
  }
  let registration;
  try {
    registration = JSON.parse(await readFile(registrationPath, 'utf8'));
  } catch (error) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 不可读：' + error.message, registrationPath);
    return null;
  }
  if (!await validatePacket('.agents/skills/figma-workflow/source-registration.schema.json', registration, 'Registration Packet', 'AIH_SOURCE_INTEGRITY_FAILED')) {
    return null;
  }
  const areaDirectory = await loadArea(actor);
  if (blockers.length > 0) return null;
  const evidenceReference = { path: registration.evidencePath, sha256: registration.evidenceSha256 };
  const [capture, context, receipt, evidence] = await Promise.all([
    readAreaReference(areaDirectory, registration.capturePlan, 'Capture Plan'),
    readAreaReference(areaDirectory, registration.designContext, 'Design Context'),
    readAreaReference(areaDirectory, registration.ingestReceipt, 'Ingest Receipt'),
    readAreaReference(areaDirectory, evidenceReference, 'Evidence'),
  ]);
  if (!capture || !context || !receipt || !evidence) return null;
  const [planValid, contextValid, receiptValid, evidenceValid] = await Promise.all([
    validatePacket('.agents/skills/figma-workflow/capture-plan.schema.json', capture.value, 'Capture Plan', 'AIH_SOURCE_CAPTURE_BLOCKED'),
    validatePacket('.agents/skills/figma-workflow/figma-design-context.schema.json', context.value, 'Design Context', 'AIH_VISUAL_SOURCE_INCOMPLETE'),
    validatePacket('.agents/skills/figma-workflow/ingest-receipt.schema.json', receipt.value, 'Ingest Receipt', 'AIH_ASSET_CLOSURE_FAILED'),
    validatePacket('.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json', evidence.value, 'Evidence', 'AIH_SOURCE_INTEGRITY_FAILED'),
  ]);
  if (!planValid || !contextValid || !receiptValid || !evidenceValid) return null;

  const plan = capture.value;
  validateFigmaWorkflow(plan, block);
  validateFigmaDesignContext(plan, registration.capturePlan.sha256, context.value, block);
  validateHandshake(plan, context.value, registration, evidence.value);
  validateFigmaAssetClosure({
    plan,
    planSha256: registration.capturePlan.sha256,
    context: context.value,
    receipt: receipt.value,
    evidence: evidence.value,
    registration,
    location: registrationPath,
  }, block);
  return registration;
}

function expectedExportDimensions(assetExport) {
  return {
    width: Math.round(assetExport.cropBounds.width * assetExport.scale),
    height: Math.round(assetExport.cropBounds.height * assetExport.scale),
  };
}

function svgDimensions(content) {
  const source = content.toString('utf8');
  const tag = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) throw new Error('SVG 缺少根 <svg> 元素');
  const number = (name) => {
    const value = tag.match(new RegExp('\\\\s' + name + '=["\\\']([0-9]+(?:\\\\.[0-9]+)?)(?:px)?["\\\']', 'i'))?.[1];
    return value ? Number(value) : null;
  };
  const width = number('width');
  const height = number('height');
  if (width && height) return { width: Math.round(width), height: Math.round(height) };
  const viewBox = tag.match(/\sviewBox=["']\s*[-+0-9.eE]+\s+[-+0-9.eE]+\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s*["']/i);
  if (!viewBox) throw new Error('SVG 缺少可验证的 width/height 或 viewBox');
  return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
}

function pngPadding(analysis) {
  if (!analysis.contentBounds) return null;
  const [left, top, rightEdge, bottomEdge] = analysis.contentBounds;
  return {
    top,
    right: analysis.width - rightEdge - 1,
    bottom: analysis.height - bottomEdge - 1,
    left,
  };
}

async function ingest(actor, capturePlanPath, acquisitionPath) {
  if (!within(tmpdir(), capturePlanPath) || !within(tmpdir(), acquisitionPath)) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Capture Plan 与 Acquisition Packet 必须位于操作系统临时目录。');
    return null;
  }
  let planContent;
  let acquisitionContent;
  try {
    [planContent, acquisitionContent] = await Promise.all([readFile(capturePlanPath), readFile(acquisitionPath)]);
  } catch (error) {
    block('AIH_ASSET_MISSING', 'Capture Plan 或 Acquisition Packet 不可读：' + error.message);
    return null;
  }
  const plan = JSON.parse(planContent.toString('utf8'));
  const acquisition = JSON.parse(acquisitionContent.toString('utf8'));
  if (!plan.scopeAudit) {
    block('AIH_FIGMA_AUDIT_INCOMPLETE', 'Capture Plan 缺少 Scope Audit。', 'scopeAudit');
    return null;
  }
  if (!plan.writebackApproval || !plan.writebackReceipt) {
    block('AIH_FIGMA_WRITEBACK_UNAPPROVED', 'Capture Plan 缺少写回批准或写回收据。', 'writebackApproval');
    return null;
  }
  if (!plan.finalFigmaAcceptance) {
    block('AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED', 'Capture Plan 缺少写回后的最终人工验收。', 'finalFigmaAcceptance');
    return null;
  }
  const [planValid, acquisitionValid] = await Promise.all([
    validatePacket('.agents/skills/figma-workflow/capture-plan.schema.json', plan, 'Capture Plan', 'AIH_SOURCE_CAPTURE_BLOCKED'),
    validatePacket('.agents/skills/figma-workflow/acquisition-packet.schema.json', acquisition, 'Acquisition Packet'),
  ]);
  if (!planValid || !acquisitionValid) return null;
  validateFigmaWorkflow(plan, block);
  const planHash = sha256(planContent);
  if (
    plan.sourceId !== acquisition.sourceId
    || !same(plan.sourceVersion, acquisition.sourceVersion)
    || acquisition.capturePlanSha256 !== planHash
  ) {
    block('AIH_ASSET_HASH_MISMATCH', 'Capture Plan 与 Acquisition Packet 的身份、版本或哈希不一致。');
  }
  const downloadedAt = Date.parse(acquisition.downloadedAt);
  if (downloadedAt < Date.parse(plan.formalCapture.startedAt) || downloadedAt > Date.parse(plan.formalCapture.completedAt)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Asset 下载时间必须位于 Formal Capture 边界内。', 'downloadedAt');
  }

  const plannedAssets = new Map(
    plan.candidateVisualNodes.filter((item) => item.strategy === 'asset').map((item) => [item.nodeId, item]),
  );
  const acquiredAssets = new Map();
  for (const file of acquisition.files) {
    if (acquiredAssets.has(file.sourceNodeId) || !plannedAssets.has(file.sourceNodeId)) {
      block('AIH_ASSET_CLOSURE_FAILED', 'Acquisition 文件重复或没有对应 Asset：' + file.sourceNodeId, 'files');
    }
    acquiredAssets.set(file.sourceNodeId, file);
  }
  if (!sameStringSet([...plannedAssets.keys()], [...acquiredAssets.keys()])) {
    block('AIH_ASSET_MISSING', 'Acquisition Packet 未覆盖全部计划 Asset。', 'files');
  }

  const areaDirectory = await loadArea(actor);
  if (blockers.length > 0) return null;
  const verified = [];
  const destinations = new Set();
  for (const [nodeId, candidate] of plannedAssets) {
    const file = acquiredAssets.get(nodeId);
    if (!file) continue;
    const planned = candidate.assetExport;
    if (
      file.assetBoundaryNodeId !== candidate.assetBoundaryNodeId
      || file.targetPath !== planned.targetPath
      || file.assetKind !== candidate.assetKind
      || file.captureScope !== candidate.captureScope
      || file.containsDynamicContent !== candidate.containsDynamicContent
      || file.format !== planned.format
      || file.scale !== planned.scale
      || !same(file.cropBounds, planned.cropBounds)
      || !same(file.transparentPadding, planned.transparentPadding)
      || !same(file.dimensions, planned.expectedDimensions)
      || acquisition.downloadOperation !== planned.downloadOperation
      || !same(expectedExportDimensions(planned), planned.expectedDimensions)
    ) {
      block('AIH_ASSET_CLOSURE_FAILED', '下载参数与 Capture Plan 不一致：' + nodeId, file.path);
      continue;
    }
    if (!file.targetPath.startsWith('public/assets/' + plan.sourceId + '/') || destinations.has(file.targetPath)) {
      block('AIH_ASSET_CLOSURE_FAILED', 'Asset 目标越界或重复：' + file.targetPath, nodeId);
      continue;
    }
    destinations.add(file.targetPath);
    const sourcePath = packetFile(acquisitionPath, file.path);
    let content;
    try {
      content = await readFile(sourcePath);
    } catch {
      block('AIH_ASSET_MISSING', 'Acquisition 文件不存在：' + file.path, nodeId);
      continue;
    }
    if (sha256(content) !== file.sha256) {
      block('AIH_ASSET_HASH_MISMATCH', '下载文件哈希不匹配：' + file.path, nodeId);
      continue;
    }
    if (extname(file.path).toLowerCase() !== '.' + file.format || extname(file.targetPath).toLowerCase() !== '.' + file.format) {
      block('AIH_ASSET_CLOSURE_FAILED', '文件扩展名与声明格式不一致：' + file.path, nodeId);
      continue;
    }
    try {
      const actualDimensions = file.format === 'png'
        ? await (async () => {
          const analysis = await analyzePng(sourcePath, { edgeMargin: 1 });
          if (
            Object.values(file.transparentPadding).some((value) => value > 0)
            && (analysis.errors.length > 0 || !same(pngPadding(analysis), file.transparentPadding))
          ) {
            block('AIH_ASSET_CLOSURE_FAILED', 'PNG 透明边距与计划不一致：' + file.path, nodeId);
          }
          return { width: analysis.width, height: analysis.height };
        })()
        : svgDimensions(content);
      if (!same(actualDimensions, file.dimensions)) {
        block('AIH_ASSET_CLOSURE_FAILED', 'Asset 实际尺寸与预期不一致：' + file.path, nodeId);
      }
    } catch (error) {
      block('AIH_ASSET_CLOSURE_FAILED', '无法验证 Asset：' + error.message, nodeId);
    }
    const target = areaFile(areaDirectory, file.targetPath);
    try {
      const existingHash = sha256(await readFile(target));
      if (existingHash !== file.sha256 && existingHash !== planned.previousSha256) {
        block('AIH_ASSET_INGEST_CONFLICT', '正式 Asset 已存在且不匹配 previousSha256：' + file.targetPath, nodeId);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    verified.push({ candidate, file, sourcePath, target });
  }

  const ingestedAt = new Date().toISOString();
  if (Date.parse(ingestedAt) < Date.parse(plan.formalCapture.startedAt) || Date.parse(ingestedAt) > Date.parse(plan.formalCapture.completedAt)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Ingest Receipt 时间必须位于 Formal Capture 边界内。', 'ingestedAt');
  }
  if (blockers.length > 0) return null;

  const formalPlanPath = 'design-sources/' + plan.sourceId + '/capture-plan.json';
  const formalReceiptPath = 'design-sources/' + plan.sourceId + '/ingest-receipt.json';
  const receipt = {
    version: '2.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlan: { path: formalPlanPath, sha256: planHash },
    downloadOperation: acquisition.downloadOperation,
    ingestedAt,
    assets: verified.map(({ candidate, file }) => ({
      sourceNodeId: file.sourceNodeId,
      assetBoundaryNodeId: file.assetBoundaryNodeId,
      path: file.targetPath,
      assetKind: candidate.assetKind,
      captureScope: candidate.captureScope,
      containsDynamicContent: candidate.containsDynamicContent,
      format: file.format,
      scale: file.scale,
      cropBounds: file.cropBounds,
      transparentPadding: file.transparentPadding,
      expectedDimensions: file.dimensions,
      sha256: file.sha256,
      consumerTargets: candidate.consumerTargets,
      status: 'verified',
    })),
    status: 'PASS',
  };
  const writes = [
    { target: areaFile(areaDirectory, formalPlanPath), content: planContent },
    { target: areaFile(areaDirectory, formalReceiptPath), content: Buffer.from(JSON.stringify(receipt, null, 2) + '\n') },
    ...verified.map((item) => ({ target: item.target, source: item.sourcePath })),
  ];
  for (const write of writes) {
    await mkdir(dirname(write.target), { recursive: true });
    if (write.source) await copyFile(write.source, write.target);
    else await writeFile(write.target, write.content);
  }
  return { sourceId: plan.sourceId, capturePlan: formalPlanPath, receipt: formalReceiptPath, assets: receipt.assets };
}

const actor = argument('--actor');
const registrationArgument = argument('--registration');
const capturePlanArgument = argument('--capture-plan');
const acquisitionArgument = argument('--acquisition');

try {
  if (!/^ACTOR-[0-9]{3}$/.test(actor || '')) {
    block('AIH_ASSET_CLOSURE_FAILED', '必须提供合法 --actor ACTOR-NNN。');
  } else if (registrationArgument) {
    const registration = await validateRegistration(actor, resolve(registrationArgument));
    if (registration && blockers.length === 0) {
      const result = {
        status: 'PASS',
        sourceId: registration.sourceId,
        componentHandshakes: registration.componentHandshake.length,
        assets: registration.assets.length,
        gaps: registration.gaps,
      };
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log('[PASS] Figma Registration Packet 闭合。');
    }
  } else if (!capturePlanArgument || !acquisitionArgument) {
    block('AIH_ASSET_MISSING', '必须同时提供 --capture-plan 与 --acquisition，或提供 --registration。');
  } else {
    const result = await ingest(actor, resolve(capturePlanArgument), resolve(acquisitionArgument));
    if (result && blockers.length === 0) {
      const output = { status: 'PASS', actor, ...result };
      if (json) console.log(JSON.stringify(output, null, 2));
      else console.log('[PASS] 已受控导入 ' + result.assets.length + ' 个 Figma Asset。');
    }
  }
} catch (error) {
  block(error.code || 'AIH_ASSET_CLOSURE_FAILED', error.message);
}

if (blockers.length > 0) {
  const result = { status: 'BLOCKED', blockers };
  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
  process.exitCode = 1;
}
