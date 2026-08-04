import { readFile } from 'node:fs/promises';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import {
  isLegacyVisualInput,
  sha256,
  validateWithSchema,
} from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { evidenceRecordDigest, validateAssetEvidence } from './lib/asset-evidence.mjs';
import { currentFreshnessPath, deriveSource, loadPrivateIntake, nodeInScope } from './lib/intake.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
const staleItems = new Set();
try {
  const project = await loadProject(root);
  const checklistPath = artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath;
  const coveragePath = artifactPaths(project, 'figma-coverage', 'figma-evidence')?.authorityPath;
  const evidencePath = artifactPaths(project, 'figma-evidence', 'figma-evidence')?.authorityPath;
  if (!checklistPath || !coveragePath || !evidencePath) {
    throw Object.assign(new Error('Figma Evidence Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const checklistBytes = await readFile(repositoryFile(root, checklistPath));
  const coverageBytes = await readFile(repositoryFile(root, coveragePath));
  const evidenceBytes = await readFile(repositoryFile(root, evidencePath));
  const checklist = JSON.parse(checklistBytes);
  const coverage = JSON.parse(coverageBytes);
  const evidence = JSON.parse(evidenceBytes);
  if (isLegacyVisualInput(coverage, coveragePath) || isLegacyVisualInput(evidence, evidencePath)) {
    throw Object.assign(new Error('旧 Figma 视觉链输入被拒绝。'), { code: 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN' });
  }
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-evidence/schemas/figma-coverage.schema.json', coverage));
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-evidence/schemas/figma-evidence.schema.json', evidence));
  if (coverage.metadata?.status !== 'ready' || evidence.metadata?.status !== 'ready') {
    blockers.push({ code: 'FGC_SOURCE_NOT_READY', message: 'Coverage 与 Evidence 必须同时为 ready。' });
  }
  const expectedChecklistDigest = sha256(checklistBytes);
  if (
    coverage.checklistLock?.path !== checklistPath
    || coverage.checklistLock?.revision !== checklist.metadata?.revision
    || coverage.checklistLock?.digest !== expectedChecklistDigest
  ) {
    for (const item of coverage.items ?? []) staleItems.add(item.itemId);
  }
  if (process.argv.includes('--source-revision') || process.argv.includes('--source-digest')) {
    throw Object.assign(new Error('自声明 source revision/digest 已禁止；必须提供当前 Figma 私有 Intake。'), { code: 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN' });
  }
  const freshnessPath = currentFreshnessPath();
  if (!freshnessPath) {
    throw Object.assign(new Error('必须重新采集当前 Figma scope 并提供私有 freshness Intake。'), { code: 'FGC_FRESHNESS_REQUIRED' });
  }
  const freshnessIntake = await loadPrivateIntake(root, freshnessPath);
  const { source: currentSource, nodes: currentNodes } = deriveSource(freshnessIntake.source);
  if (
    !coverage.source?.locator?.startsWith(`figma://${coverage.source?.fileId}`)
    ||
    coverage.source?.scope?.kind === 'file'
    && (
      coverage.source.scope.refs.length !== 1
      || coverage.source.scope.refs[0] !== coverage.source.fileId
    )
  ) blockers.push({ code: 'FGC_SOURCE_INVALID', message: 'file scope 必须唯一指向 source.fileId。' });
  if (
    coverage.source?.fileId !== currentSource.fileId
    || coverage.source?.locator !== currentSource.locator
    || JSON.stringify(coverage.source?.scope) !== JSON.stringify(currentSource.scope)
    || coverage.source?.revision !== currentSource.revision
    || coverage.source?.digest !== currentSource.digest
  ) {
    for (const item of coverage.items ?? []) staleItems.add(item.itemId);
  }
  if (
    evidence.coverageLock?.path !== coveragePath
    || evidence.coverageLock?.revision !== coverage.metadata?.revision
    || evidence.coverageLock?.digest !== sha256(coverageBytes)
    || evidence.source?.fileId !== coverage.source?.fileId
    || evidence.source?.locator !== coverage.source?.locator
    || JSON.stringify(evidence.source?.scope) !== JSON.stringify(coverage.source?.scope)
    || evidence.source?.revision !== coverage.source?.revision
    || evidence.source?.digest !== coverage.source?.digest
  ) {
    for (const item of coverage.items ?? []) staleItems.add(item.itemId);
  }
  const checklistIds = new Set((checklist.items ?? []).map((item) => item.itemId));
  const coverageIds = new Set((coverage.items ?? []).map((item) => item.itemId));
  if (coverageIds.size !== (coverage.items ?? []).length) {
    blockers.push({ code: 'FGC_ITEM_DUPLICATED', message: 'Coverage 包含重复 itemId。' });
  }
  for (const id of checklistIds) {
    const item = (coverage.items ?? []).find((entry) => entry.itemId === id);
    if (!item || item.status !== 'covered') blockers.push({
      code: 'FGC_COVERAGE_MISSING',
      message: `Checklist item 没有完整 Figma Coverage：${id}`,
    });
    const requirement = (checklist.items ?? []).find((entry) => entry.itemId === id);
    if (item?.status === 'covered' && requirement) {
      const expectedRole = requirement.target?.kind?.toLowerCase();
      if (item.anchors.some((anchor) => anchor.role !== expectedRole)) blockers.push({
        code: 'FGC_ROLE_MISMATCH',
        message: `${id} target.kind=${requirement.target?.kind} 只能绑定 anchor.role=${expectedRole}。`,
      });
      const requiredProperties = [
        'geometry', 'layout', 'appearance', 'typography',
        ...((requirement.dimensions.viewports ?? []).length ? ['viewport'] : []),
        ...((requirement.dimensions.states ?? []).length ? ['state'] : []),
        ...((requirement.dimensions.variants ?? []).length ? ['variant'] : []),
        ...((requirement.dimensions.assets ?? []).length ? ['asset'] : []),
        ...((requirement.dimensions.tokens ?? []).length ? ['token'] : []),
        ...((requirement.dimensions.motions ?? []).length ? ['motion'] : []),
      ];
      const properties = new Set(item.anchors.flatMap((anchor) => anchor.properties ?? []));
      const missing = [
        ...requiredProperties.filter((property) => !properties.has(property)),
        ...(requirement.dimensions.viewports ?? []).filter((value) => !item.anchors.some((anchor) => anchor.viewport === value)),
        ...(requirement.dimensions.states ?? []).filter((value) => !item.anchors.some((anchor) => anchor.state === value)),
        ...(requirement.dimensions.variants ?? []).filter((value) => !item.anchors.some((anchor) => anchor.variant === value)),
        ...(requirement.dimensions.contentCases ?? []).filter((value) => !item.anchors.some((anchor) => anchor.contentCase === value)),
      ];
      if (missing.length) blockers.push({ code: 'FGC_PROPERTY_MISSING', message: `${id} 缺少 Figma 属性证据：${missing.join(', ')}` });
    }
  }
  for (const id of coverageIds) {
    if (!checklistIds.has(id)) blockers.push({ code: 'FGC_SCOPE_EXPANSION_FORBIDDEN', message: `Coverage 擅自扩大范围：${id}` });
  }
  for (const item of coverage.items ?? []) {
    for (const anchor of item.anchors ?? []) {
      if (!nodeInScope(currentSource, currentNodes.get(anchor.nodeId))) {
        blockers.push({ code: 'FGC_SCOPE_EXPANSION_FORBIDDEN', message: `${item.itemId} 使用了 Figma scope 外节点：${anchor.nodeId}` });
      }
    }
  }
  const closure = [
    ['assets', 'assetId', 'FGC_ASSET_MISSING'],
    ['tokens', 'tokenId', 'FGC_TOKEN_MISSING'],
    ['motions', 'motionId', 'FGC_MOTION_MISSING'],
  ];
  for (const [dimension, key] of closure) {
    const records = evidence[dimension] ?? [];
    const ids = new Set(records.map((record) => record[key]));
    if (ids.size !== records.length) {
      blockers.push({ code: 'FGC_EVIDENCE_DUPLICATED', message: `${dimension} 包含重复证据 ID。` });
    }
    for (const record of records) {
      const sourceNodeId = dimension === 'assets' ? record.nodeId : record.sourceNodeId;
      if (!nodeInScope(currentSource, currentNodes.get(sourceNodeId))) blockers.push({
        code: 'FGC_SCOPE_EXPANSION_FORBIDDEN',
        message: `${dimension} evidence 使用了 Figma scope 外节点：${sourceNodeId}`,
      });
      if (dimension !== 'assets' && record.digest !== evidenceRecordDigest(record)) {
        blockers.push({
          code: dimension === 'tokens' ? 'FGC_TOKEN_DIGEST_INVALID' : 'FGC_MOTION_DIGEST_INVALID',
          message: `${record[key]} 内容摘要与正式证据字段不匹配。`,
        });
      }
      for (const itemId of record.itemRefs ?? []) {
        if (!checklistIds.has(itemId)) blockers.push({
          code: 'FGC_SCOPE_EXPANSION_FORBIDDEN',
          message: `${dimension} evidence 引用 Checklist 外身份：${itemId}`,
        });
      }
    }
  }
  for (const item of checklist.items ?? []) {
    for (const [dimension, key, code] of closure) {
      for (const id of item.dimensions?.[dimension] ?? []) {
        const record = (evidence[dimension] ?? []).find((entry) => entry[key] === id && entry.itemRefs?.includes(item.itemId));
        if (!record) blockers.push({ code, message: `${item.itemId} 缺少 ${dimension} 证据：${id}` });
      }
    }
  }
  for (const asset of evidence.assets ?? []) {
    const errors = await validateAssetEvidence(root, asset);
    for (const message of errors) blockers.push({
      code: message.startsWith('digest') ? 'FGC_ASSET_DIGEST_INVALID' : 'FGC_ASSET_INVALID',
      message: `${asset.assetId}：${message}`,
    });
  }
  if ((coverage.gaps ?? []).length || (evidence.gaps ?? []).length) {
    blockers.push({ code: 'FGC_GAP_OPEN', message: 'Figma Coverage/Evidence 仍有结构化 Gap。' });
  }
} catch (error) {
  blockers.unshift({ code: error.code || 'FGC_VALIDATION_FAILED', message: error.message });
}
const status = blockers.length ? 'BLOCKED' : staleItems.size ? 'STALE' : 'PASS';
console.log(JSON.stringify({ status, blockers, staleItems: [...staleItems].sort() }));
if (status !== 'PASS') process.exitCode = 1;
