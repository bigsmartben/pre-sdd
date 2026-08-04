import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import {
  isLegacyVisualInput,
  sha256,
  stableJson,
  validateWithSchema,
} from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { evidenceRecordDigest, inspectAsset } from './lib/asset-evidence.mjs';
import { deriveSource, inside, loadPrivateIntake, nodeInScope } from './lib/intake.mjs';
import { tmpdir } from 'node:os';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function nextRevision(previous, candidate) {
  if (!previous) return 1;
  const left = structuredClone(previous);
  const right = structuredClone(candidate);
  left.metadata.revision = 1;
  right.metadata.revision = 1;
  return stableJson(left) === stableJson(right) ? previous.metadata.revision : previous.metadata.revision + 1;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function expectedRole(item) {
  return item.target?.kind?.toLowerCase();
}

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
try {
  if (process.argv.includes('--capture')) {
    fail('LEGACY_VISUAL_WORKFLOW_FORBIDDEN', '旧 Figma Packet、capture 或视觉映射入口被拒绝。');
  }
  const intakePath = argument('intake');
  if (intakePath && inside(tmpdir(), intakePath)) {
    const rawIntake = JSON.parse(await readFile(resolve(intakePath), 'utf8'));
    if (isLegacyVisualInput(rawIntake, intakePath)) fail('LEGACY_VISUAL_WORKFLOW_FORBIDDEN', '旧 Figma Packet 或视觉映射输入被拒绝。');
  }
  const intake = await loadPrivateIntake(root, intakePath);
  const project = await loadProject(root);
  const checklistPath = artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath;
  const coveragePath = artifactPaths(project, 'figma-coverage', 'figma-evidence')?.authorityPath;
  const evidencePath = artifactPaths(project, 'figma-evidence', 'figma-evidence')?.authorityPath;
  if (!checklistPath || !coveragePath || !evidencePath) fail('VISUAL_SPEC_SOURCE_LOCK_INVALID', 'Figma Evidence Registry 不完整。');

  const checklistBytes = await readFile(repositoryFile(root, checklistPath));
  const checklist = JSON.parse(checklistBytes);
  if (checklist.metadata?.status !== 'ready' || (checklist.gaps ?? []).length) {
    fail('VISUAL_SPEC_SOURCE_NOT_READY', 'Figma Evidence 只接受 Ready Checklist。');
  }
  const { source, nodes, nodeDigests } = deriveSource(intake.source);
  if (!source.locator.startsWith(`figma://${source.fileId}`)) fail('FGC_SOURCE_INVALID', 'Figma locator 与 fileId 不一致。');
  if (nodes.size !== intake.source.nodes.length) fail('FGC_NODE_DUPLICATED', 'Figma Intake 包含重复 nodeId。');
  for (const node of nodes.values()) {
    if (!nodeInScope(source, node)) fail('FGC_SCOPE_EXPANSION_FORBIDDEN', `Figma node 超出声明 scope：${node.nodeId}`);
  }

  const checklistIds = new Set((checklist.items ?? []).map((item) => item.itemId));
  const captured = new Map();
  for (const item of intake.items) {
    if (!checklistIds.has(item.itemId)) fail('FGC_SCOPE_EXPANSION_FORBIDDEN', `Figma 额外内容不得扩大 Checklist：${item.itemId}`);
    if (captured.has(item.itemId)) fail('FGC_ITEM_DUPLICATED', `Figma item 重复：${item.itemId}`);
    for (const anchor of item.anchors) {
      const node = nodes.get(anchor.nodeId);
      if (!node || !nodeInScope(source, node)) fail('FGC_SCOPE_EXPANSION_FORBIDDEN', `${item.itemId} 使用 scope 外节点：${anchor.nodeId}`);
    }
    captured.set(item.itemId, item);
  }

  const coverageItems = [];
  const coverageGaps = [];
  for (const requirement of checklist.items ?? []) {
    const found = captured.get(requirement.itemId);
    const anchors = found?.anchors ?? [];
    const role = expectedRole(requirement);
    if (found?.status === 'covered' && anchors.some((anchor) => anchor.role !== role)) {
      fail('FGC_ROLE_MISMATCH', `${requirement.itemId} target.kind=${requirement.target.kind} 只能绑定 anchor.role=${role}。`);
    }
    const requiredProperties = [
      'geometry', 'layout', 'appearance', 'typography',
      ...((requirement.dimensions.viewports ?? []).length ? ['viewport'] : []),
      ...((requirement.dimensions.states ?? []).length ? ['state'] : []),
      ...((requirement.dimensions.variants ?? []).length ? ['variant'] : []),
      ...((requirement.dimensions.assets ?? []).length ? ['asset'] : []),
      ...((requirement.dimensions.tokens ?? []).length ? ['token'] : []),
      ...((requirement.dimensions.motions ?? []).length ? ['motion'] : []),
    ];
    const properties = new Set(anchors.flatMap((anchor) => anchor.properties));
    const missing = [
      ...requiredProperties.filter((property) => !properties.has(property)).map((property) => `property:${property}`),
      ...(requirement.dimensions.viewports ?? []).filter((value) => !anchors.some((anchor) => anchor.viewport === value)).map((value) => `viewport:${value}`),
      ...(requirement.dimensions.states ?? []).filter((value) => !anchors.some((anchor) => anchor.state === value)).map((value) => `state:${value}`),
      ...(requirement.dimensions.variants ?? []).filter((value) => !anchors.some((anchor) => anchor.variant === value)).map((value) => `variant:${value}`),
      ...(requirement.dimensions.contentCases ?? []).filter((value) => !anchors.some((anchor) => anchor.contentCase === value)).map((value) => `contentCase:${value}`),
    ];
    const status = found?.status === 'covered' && missing.length ? 'missing' : (found?.status ?? 'missing');
    coverageItems.push({
      itemId: requirement.itemId,
      status,
      anchors: status === 'covered' ? anchors.map((anchor) => ({ ...anchor, nodeDigest: nodeDigests.get(anchor.nodeId) })) : [],
    });
    if (status !== 'covered') coverageGaps.push({
      code: status === 'stale' ? 'FGC_SOURCE_STALE' : missing.length ? 'FGC_PROPERTY_MISSING' : 'FGC_ITEM_MISSING',
      itemId: requirement.itemId,
      reason: missing.length ? `Figma 属性不可读取：${missing.join(', ')}` : (found?.reason ?? 'Figma 没有提供显式覆盖证据'),
    });
  }

  const coverage = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'FIGMA-COVERAGE', revision: 1, status: coverageGaps.length ? 'draft' : 'ready' },
    checklistLock: {
      artifactId: 'VISUAL-SPEC-CHECKLIST', path: checklistPath,
      revision: checklist.metadata.revision, digest: sha256(checklistBytes),
    },
    source,
    items: coverageItems,
    gaps: coverageGaps,
  };
  let previousCoverage = null;
  try { previousCoverage = JSON.parse(await readFile(repositoryFile(root, coveragePath), 'utf8')); } catch { /* first finalize */ }
  if (previousCoverage?.source?.fileId === source.fileId && previousCoverage?.source?.revision === source.revision && previousCoverage?.source?.digest !== source.digest) {
    fail('VISUAL_SPEC_SOURCE_REVISION_REUSED', 'Figma source 相同 revision 对应不同实际采集摘要。');
  }
  coverage.metadata.revision = nextRevision(previousCoverage, coverage);
  const coverageBytes = Buffer.from(stableJson(coverage));

  const assetWrites = [];
  const assets = [];
  for (const candidate of [...intake.assets].sort((a, b) => a.assetId.localeCompare(b.assetId))) {
    const node = nodes.get(candidate.nodeId);
    if (!node || !nodeInScope(source, node)) fail('FGC_SCOPE_EXPANSION_FORBIDDEN', `${candidate.assetId} 使用 scope 外节点：${candidate.nodeId}`);
    if (!inside(tmpdir(), candidate.sourcePath)) fail('FGC_ASSET_EXPORT_INVALID', `${candidate.assetId} 导出源必须位于操作系统临时目录。`);
    const bytes = await readFile(resolve(candidate.sourcePath));
    const metadata = inspectAsset(bytes, candidate.format);
    if (!metadata) fail('FGC_ASSET_EXPORT_INVALID', `${candidate.assetId} 不是有效的 ${candidate.format} 导出文件。`);
    const extension = extname(candidate.path).toLowerCase();
    const expected = candidate.format === 'jpg' ? ['.jpg', '.jpeg'] : [`.${candidate.format}`];
    if (!expected.includes(extension)) fail('FGC_ASSET_EXPORT_INVALID', `${candidate.assetId} 正式路径扩展名与 format 不一致。`);
    assets.push({
      assetId: candidate.assetId,
      nodeId: candidate.nodeId,
      nodeDigest: nodeDigests.get(candidate.nodeId),
      path: candidate.path,
      format: candidate.format,
      width: ['woff', 'woff2'].includes(candidate.format) ? null : metadata.width,
      height: ['woff', 'woff2'].includes(candidate.format) ? null : metadata.height,
      digest: sha256(bytes),
      itemRefs: candidate.itemRefs,
    });
    assetWrites.push({ target: candidate.path, content: bytes });
  }
  const tokens = [...intake.tokens].map((record) => ({ ...record, digest: evidenceRecordDigest(record) })).sort((a, b) => a.tokenId.localeCompare(b.tokenId));
  const motions = [...intake.motions].map((record) => ({ ...record, digest: evidenceRecordDigest(record) })).sort((a, b) => a.motionId.localeCompare(b.motionId));
  const evidenceGaps = [];
  const closure = [['asset', assets, 'assetId', 'nodeId'], ['token', tokens, 'tokenId', 'sourceNodeId'], ['motion', motions, 'motionId', 'sourceNodeId']];
  for (const [kind, records, key, nodeKey] of closure) {
    if (new Set(records.map((record) => record[key])).size !== records.length) fail('FGC_EVIDENCE_DUPLICATED', `${kind} evidence 包含重复 ID。`);
    for (const record of records) {
      const node = nodes.get(record[nodeKey]);
      if (!node || !nodeInScope(source, node)) fail('FGC_SCOPE_EXPANSION_FORBIDDEN', `${record[key]} 使用 scope 外节点：${record[nodeKey]}`);
      for (const itemId of record.itemRefs) if (!checklistIds.has(itemId)) fail('FGC_SCOPE_EXPANSION_FORBIDDEN', `${record[key]} 引用 Checklist 外身份：${itemId}`);
    }
  }
  const hasEvidence = (records, id, itemId, key) => records.some((record) => record[key] === id && record.itemRefs.includes(itemId));
  for (const requirement of checklist.items ?? []) {
    for (const id of requirement.dimensions.assets ?? []) if (!hasEvidence(assets, id, requirement.itemId, 'assetId')) evidenceGaps.push({ code: 'FGC_ASSET_MISSING', itemId: requirement.itemId, dimension: 'asset', reason: `缺少 ${id}` });
    for (const id of requirement.dimensions.tokens ?? []) if (!hasEvidence(tokens, id, requirement.itemId, 'tokenId')) evidenceGaps.push({ code: 'FGC_TOKEN_MISSING', itemId: requirement.itemId, dimension: 'token', reason: `缺少 ${id}` });
    for (const id of requirement.dimensions.motions ?? []) if (!hasEvidence(motions, id, requirement.itemId, 'motionId')) evidenceGaps.push({ code: 'FGC_MOTION_MISSING', itemId: requirement.itemId, dimension: 'motion', reason: `缺少 ${id}` });
  }
  const evidence = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'FIGMA-EVIDENCE', revision: 1, status: evidenceGaps.length || coverage.metadata.status !== 'ready' ? 'draft' : 'ready' },
    coverageLock: { artifactId: 'FIGMA-COVERAGE', path: coveragePath, revision: coverage.metadata.revision, digest: sha256(coverageBytes) },
    source,
    assets,
    tokens,
    motions,
    gaps: evidenceGaps,
  };
  let previousEvidence = null;
  try { previousEvidence = JSON.parse(await readFile(repositoryFile(root, evidencePath), 'utf8')); } catch { /* first finalize */ }
  evidence.metadata.revision = nextRevision(previousEvidence, evidence);
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-evidence/schemas/figma-coverage.schema.json', coverage));
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-evidence/schemas/figma-evidence.schema.json', evidence));
  if (blockers.length) fail('FGC_OUTPUT_INVALID', 'Figma Coverage/Evidence 不符合正式 Schema。');
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'figma-evidence',
    writes: [...assetWrites, { target: coveragePath, content: stableJson(coverage) }, { target: evidencePath, content: stableJson(evidence) }],
  });
  if (coverageGaps.length || evidenceGaps.length) blockers.push({ code: 'FGC_COVERAGE_INCOMPLETE', message: `Figma 证据仍有 ${coverageGaps.length + evidenceGaps.length} 个结构化 Gap。` });
} catch (error) {
  if (!blockers.length || error.code) blockers.unshift({ code: error.code || 'FGC_FINALIZE_FAILED', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
