import { tmpdir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import {
  isLegacyVisualInput,
  sha256,
  stableJson,
  validateWithSchema,
} from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { evidenceRecordDigest, validateAssetEvidence } from './lib/asset-evidence.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function inside(parent, child) {
  const value = relative(resolve(parent), resolve(child));
  return value !== '' && value !== '..' && !value.startsWith('..\\') && !value.startsWith('../') && !isAbsolute(value);
}

function nextRevision(previous, candidate) {
  if (!previous) return 1;
  const left = structuredClone(previous);
  const right = structuredClone(candidate);
  left.metadata.revision = 1;
  right.metadata.revision = 1;
  return stableJson(left) === stableJson(right) ? previous.metadata.revision : previous.metadata.revision + 1;
}

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
try {
  const capturePath = argument('capture');
  if (!capturePath || !inside(tmpdir(), capturePath)) {
    throw Object.assign(new Error('Figma 临时采集输入必须位于操作系统临时目录。'), { code: 'FGC_CAPTURE_PATH_INVALID' });
  }
  const capture = JSON.parse(await readFile(resolve(capturePath), 'utf8'));
  if (isLegacyVisualInput(capture, capturePath)) {
    throw Object.assign(new Error('旧 Figma Packet 或视觉映射禁止进入新链。'), { code: 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN' });
  }
  const project = await loadProject(root);
  const checklistPath = artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath;
  const coveragePath = artifactPaths(project, 'figma-coverage', 'figma-workflow')?.authorityPath;
  const evidencePath = artifactPaths(project, 'figma-evidence', 'figma-workflow')?.authorityPath;
  if (!checklistPath || !coveragePath || !evidencePath) {
    throw Object.assign(new Error('Figma Workflow Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const checklistBytes = await readFile(repositoryFile(root, checklistPath));
  const checklist = JSON.parse(checklistBytes);
  if (checklist.metadata?.status !== 'ready' || (checklist.gaps ?? []).length) {
    throw Object.assign(new Error('Figma 绑定只接受 Ready Checklist。'), { code: 'VISUAL_SPEC_SOURCE_NOT_READY' });
  }
  if (
    capture.source?.provider !== 'figma'
    || !capture.source?.fileId
    || !/^figma:\/\/[^\s]+$/.test(capture.source?.locator ?? '')
    || !capture.source.locator.startsWith(`figma://${capture.source.fileId}`)
    || !['file', 'page', 'node'].includes(capture.source?.scope?.kind)
    || !(capture.source?.scope?.refs?.length > 0)
    || (
      capture.source?.scope?.kind === 'file'
      && (
        capture.source.scope.refs.length !== 1
        || capture.source.scope.refs[0] !== capture.source.fileId
      )
    )
    || !capture.source?.revision
    || !/^sha256:[a-f0-9]{64}$/.test(capture.source?.digest ?? '')
    || !capture.source?.capturedAt
    || Number.isNaN(Date.parse(capture.source.capturedAt))
  ) {
    throw Object.assign(new Error('Figma source identity/revision/digest/capturedAt 不完整。'), { code: 'FGC_SOURCE_INVALID' });
  }
  const checklistIds = new Set((checklist.items ?? []).map((item) => item.itemId));
  const captured = new Map();
  for (const item of capture.items ?? []) {
    if (!checklistIds.has(item.itemId)) {
      blockers.push({ code: 'FGC_SCOPE_EXPANSION_FORBIDDEN', message: `Figma 额外内容不得扩大 Checklist：${item.itemId}` });
    } else if (
      capture.source.scope.kind === 'node'
      && (item.anchors ?? []).some((anchor) => !capture.source.scope.refs.includes(anchor.nodeId))
    ) {
      blockers.push({ code: 'FGC_SCOPE_EXPANSION_FORBIDDEN', message: `${item.itemId} 使用了 Figma node scope 外节点。` });
    } else if (captured.has(item.itemId)) {
      blockers.push({ code: 'FGC_ITEM_DUPLICATED', message: `Figma item 重复：${item.itemId}` });
    } else {
      captured.set(item.itemId, item);
    }
  }
  if (blockers.length) throw new Error('Figma capture 不闭合。');
  const coverageItems = [];
  const coverageGaps = [];
  for (const item of checklist.items ?? []) {
    const found = captured.get(item.itemId);
    const anchors = found?.anchors ?? [];
    const requiredProperties = [
      'geometry',
      'layout',
      'appearance',
      'typography',
      ...((item.dimensions.viewports ?? []).length ? ['viewport'] : []),
      ...((item.dimensions.states ?? []).length ? ['state'] : []),
      ...((item.dimensions.variants ?? []).length ? ['variant'] : []),
      ...((item.dimensions.assets ?? []).length ? ['asset'] : []),
      ...((item.dimensions.tokens ?? []).length ? ['token'] : []),
      ...((item.dimensions.motions ?? []).length ? ['motion'] : []),
    ];
    const properties = new Set(anchors.flatMap((anchor) => anchor.properties ?? []));
    const missing = [
      ...requiredProperties.filter((property) => !properties.has(property)).map((property) => `property:${property}`),
      ...(item.dimensions.viewports ?? []).filter((value) => !anchors.some((anchor) => anchor.viewport === value)).map((value) => `viewport:${value}`),
      ...(item.dimensions.states ?? []).filter((value) => !anchors.some((anchor) => anchor.state === value)).map((value) => `state:${value}`),
      ...(item.dimensions.variants ?? []).filter((value) => !anchors.some((anchor) => anchor.variant === value)).map((value) => `variant:${value}`),
      ...(item.dimensions.contentCases ?? []).filter((value) => !anchors.some((anchor) => anchor.contentCase === value)).map((value) => `contentCase:${value}`),
    ];
    const status = found?.status === 'covered' && missing.length ? 'missing' : (found?.status ?? 'missing');
    coverageItems.push({
      itemId: item.itemId,
      status,
      anchors: status === 'covered' ? anchors : [],
    });
    if (status !== 'covered') coverageGaps.push({
      code: status === 'stale' ? 'FGC_SOURCE_STALE' : missing.length ? 'FGC_PROPERTY_MISSING' : 'FGC_ITEM_MISSING',
      itemId: item.itemId,
      reason: missing.length ? `Figma 属性不可读取：${missing.join(', ')}` : (found?.reason ?? 'Figma 没有提供显式覆盖证据'),
    });
  }
  const coverage = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: {
      artifactId: 'FIGMA-COVERAGE',
      revision: 1,
      status: coverageGaps.length ? 'draft' : 'ready',
    },
    checklistLock: {
      artifactId: 'VISUAL-SPEC-CHECKLIST',
      path: checklistPath,
      revision: checklist.metadata.revision,
      digest: sha256(checklistBytes),
    },
    source: capture.source,
    items: coverageItems,
    gaps: coverageGaps,
  };
  let previousCoverage = null;
  try { previousCoverage = JSON.parse(await readFile(repositoryFile(root, coveragePath), 'utf8')); } catch { /* first bind */ }
  if (
    previousCoverage?.source?.fileId === coverage.source.fileId
    && previousCoverage?.source?.revision === coverage.source.revision
    && previousCoverage?.source?.digest !== coverage.source.digest
  ) {
    throw Object.assign(new Error('Figma source 相同 revision 对应不同摘要。'), {
      code: 'VISUAL_SPEC_SOURCE_REVISION_REUSED',
    });
  }
  coverage.metadata.revision = nextRevision(previousCoverage, coverage);
  const coverageBytes = Buffer.from(stableJson(coverage));

  const assets = [...(capture.assets ?? [])].sort((a, b) => a.assetId.localeCompare(b.assetId));
  const tokens = [...(capture.tokens ?? [])]
    .map((record) => ({ ...record, digest: evidenceRecordDigest(record) }))
    .sort((a, b) => a.tokenId.localeCompare(b.tokenId));
  const motions = [...(capture.motions ?? [])]
    .map((record) => ({ ...record, digest: evidenceRecordDigest(record) }))
    .sort((a, b) => a.motionId.localeCompare(b.motionId));
  const evidenceGaps = [];
  const hasEvidence = (records, id, itemId, key) => records.some((record) => record[key] === id && record.itemRefs?.includes(itemId));
  for (const [kind, records, key] of [
    ['asset', assets, 'assetId'],
    ['token', tokens, 'tokenId'],
    ['motion', motions, 'motionId'],
  ]) {
    if (new Set(records.map((record) => record[key])).size !== records.length) {
      blockers.push({ code: 'FGC_EVIDENCE_DUPLICATED', message: `${kind} evidence 包含重复 ID。` });
    }
    for (const record of records) {
      for (const itemId of record.itemRefs ?? []) {
        if (!checklistIds.has(itemId)) blockers.push({
          code: 'FGC_SCOPE_EXPANSION_FORBIDDEN',
          message: `${kind} evidence 引用 Checklist 外身份：${itemId}`,
        });
      }
    }
  }
  if (blockers.length) throw new Error('Figma Evidence 擅自扩大范围。');
  for (const asset of assets) {
    const errors = await validateAssetEvidence(root, asset);
    if (errors.length) {
      evidenceGaps.push({
        code: 'FGC_ASSET_MISSING',
        itemId: asset.itemRefs?.[0] ?? checklist.items?.[0]?.itemId,
        dimension: 'asset',
        reason: `${asset.assetId} 正式文件不可验证：${errors.join('; ')}`,
      });
    }
  }
  for (const item of checklist.items ?? []) {
    for (const id of item.dimensions.assets ?? []) {
      if (!hasEvidence(assets, id, item.itemId, 'assetId')) evidenceGaps.push({ code: 'FGC_ASSET_MISSING', itemId: item.itemId, dimension: 'asset', reason: `缺少 ${id}` });
    }
    for (const id of item.dimensions.tokens ?? []) {
      if (!hasEvidence(tokens, id, item.itemId, 'tokenId')) evidenceGaps.push({ code: 'FGC_TOKEN_MISSING', itemId: item.itemId, dimension: 'token', reason: `缺少 ${id}` });
    }
    for (const id of item.dimensions.motions ?? []) {
      if (!hasEvidence(motions, id, item.itemId, 'motionId')) evidenceGaps.push({ code: 'FGC_MOTION_MISSING', itemId: item.itemId, dimension: 'motion', reason: `缺少 ${id}` });
    }
  }
  const evidence = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: {
      artifactId: 'FIGMA-EVIDENCE',
      revision: 1,
      status: evidenceGaps.length || coverage.metadata.status !== 'ready' ? 'draft' : 'ready',
    },
    coverageLock: {
      artifactId: 'FIGMA-COVERAGE',
      path: coveragePath,
      revision: coverage.metadata.revision,
      digest: sha256(coverageBytes),
    },
    source: capture.source,
    assets,
    tokens,
    motions,
    gaps: evidenceGaps,
  };
  let previousEvidence = null;
  try { previousEvidence = JSON.parse(await readFile(repositoryFile(root, evidencePath), 'utf8')); } catch { /* first bind */ }
  evidence.metadata.revision = nextRevision(previousEvidence, evidence);
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-workflow/schemas/figma-coverage.schema.json', coverage));
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-workflow/schemas/figma-evidence.schema.json', evidence));
  if (blockers.length) throw new Error('Figma Coverage/Evidence 不符合新 Schema。');
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'figma-coverage-evidence',
    writes: [
      { target: coveragePath, content: stableJson(coverage) },
      { target: evidencePath, content: stableJson(evidence) },
    ],
  });
  if (coverageGaps.length || evidenceGaps.length) {
    blockers.push({
      code: 'FGC_COVERAGE_INCOMPLETE',
      message: `Figma 证据仍有 ${coverageGaps.length + evidenceGaps.length} 个结构化 Gap。`,
    });
  }
} catch (error) {
  if (!blockers.length || error.code) blockers.unshift({
    code: error.code || 'FGC_BINDING_FAILED',
    message: error.message,
  });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
