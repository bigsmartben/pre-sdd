import { readFile } from 'node:fs/promises';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { argument, collectSourceClosure, readArtifact, report, sameLock, sha256, stableJson, validateSchema, ARTIFACTS } from './lib/core.mjs';

const root = repositoryRootFrom(import.meta.dirname);
try {
  const required = ['item', 'route', 'page', 'widget', 'state', 'viewport', 'figma-evidence', 'source', 'evidence', 'description'];
  for (const name of required) if (!argument(name)) throw Object.assign(new Error(`缺少 --${name}。`), { code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE' });
  const project = await loadProject(root);
  const path = (id) => artifactPaths(project, id, 'flutter-ui').authorityPath;
  const preview = await readArtifact(root, path(ARTIFACTS.preview.id));
  const findings = await readArtifact(root, path(ARTIFACTS.findings.id));
  if (preview.data.metadata.status !== 'reviewing') throw Object.assign(new Error('只能在 reviewing Preview 上记录 Finding。'), { code: 'FLUTTER_PREVIEW_STALE' });
  if (!sameLock(findings.data.previewLock, preview)) throw Object.assign(new Error('REVIEW-FINDINGS 未绑定当前 Preview。'), { code: 'FLUTTER_PREVIEW_STALE' });
  const l1 = await readArtifact(root, path(ARTIFACTS.l1.id));
  const item = l1.data.items.find((entry) => entry.itemId === argument('item'));
  if (!item || item.route !== argument('route') || item.page !== argument('page') || item.widgetId !== argument('widget') || !item.states.includes(argument('state')) || !item.viewports.includes(argument('viewport'))) throw Object.assign(new Error('Finding 未闭合到当前 L1 Widget/State/Viewport。'), { code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE' });
  const closurePaths = new Set((await collectSourceClosure(root)).files.map((entry) => entry.path));
  const sourcePaths = argument('source').split(',').filter(Boolean);
  if (sourcePaths.some((entry) => !entry.startsWith('lib/ui/') || !closurePaths.has(entry))) throw Object.assign(new Error('Finding source 必须引用当前 lib/ui/** 闭包。'), { code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE' });
  const figmaCoverage = await readArtifact(root, artifactPaths(project, 'figma-coverage', 'figma-evidence').authorityPath);
  const figmaEvidence = await readArtifact(root, artifactPaths(project, 'figma-evidence', 'figma-evidence').authorityPath);
  const knownFigmaRefs = new Set([...(figmaCoverage.data.items ?? []).flatMap((entry) => (entry.anchors ?? []).map((anchor) => anchor.nodeId)), ...(figmaEvidence.data.assets ?? []).map((entry) => entry.assetId), ...(figmaEvidence.data.tokens ?? []).map((entry) => entry.tokenId), ...(figmaEvidence.data.motions ?? []).map((entry) => entry.motionId)]);
  const figmaEvidenceRefs = argument('figma-evidence').split(',').filter(Boolean);
  if (!figmaEvidenceRefs.length || figmaEvidenceRefs.some((entry) => !knownFigmaRefs.has(entry))) throw Object.assign(new Error('Finding 引用了未知 Figma Evidence。'), { code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE' });
  const evidencePath = argument('evidence');
  const evidenceBytes = await readFile(repositoryFile(root, evidencePath));
  const next = Math.max(0, ...findings.data.findings.map((entry) => Number(entry.findingId.slice(4)))) + 1;
  const level = argument('level', 'L1');
  if (level === 'L2' && (!argument('test-case') || !argument('path-step'))) throw Object.assign(new Error('L2 Finding 必须绑定 Test Case 与 Path Step。'), { code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE' });
  if (level === 'L2') {
    const l2 = await readArtifact(root, path(ARTIFACTS.l2.id));
    const matched = l2.data.paths.some((entry) => entry.testCaseRef === argument('test-case') && entry.checklistItemRefs.includes(argument('item')) && entry.steps.some((step) => step.pathStepId === argument('path-step')));
    if (!matched) throw Object.assign(new Error('L2 Finding 未闭合到当前 Test Case/Path Step。'), { code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE' });
  }
  findings.data.findings.push({
    findingId: `RVW-${String(next).padStart(4, '0')}`, severity: argument('severity', 'Major'), status: 'open', level,
    itemId: argument('item'), testCaseId: level === 'L2' ? argument('test-case') : null, pathStepId: level === 'L2' ? argument('path-step') : null,
    route: argument('route'), page: argument('page'), widgetId: argument('widget'), state: argument('state'), variant: argument('variant'), viewport: argument('viewport'),
    figmaEvidenceRefs, source: { commit: preview.data.source.commit, digest: preview.data.source.digest, paths: sourcePaths },
    preview: { target: preview.data.preview.target, runtimeProfile: preview.data.preview.runtimeProfile, buildDigest: preview.data.preview.buildDigest }, evidence: { path: evidencePath, digest: sha256(evidenceBytes) }, description: argument('description'), rootCause: null, repair: null, verification: null,
  });
  findings.data.metadata.revision += 1; findings.data.metadata.status = 'active';
  const schemaBlockers = await validateSchema(root, ARTIFACTS.findings.schema, findings.data);
  if (schemaBlockers.length) throw Object.assign(new Error(JSON.stringify(schemaBlockers)), { code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE' });
  await commitManagedWrites({ root, ownerId: 'flutter-ui-review-finding', writes: [{ target: findings.path, content: stableJson(findings.data) }] });
  report([], { findingId: findings.data.findings.at(-1).findingId });
} catch (error) { report([{ code: error.code || 'FLUTTER_FINDING_FAILED', message: error.message }]); }
