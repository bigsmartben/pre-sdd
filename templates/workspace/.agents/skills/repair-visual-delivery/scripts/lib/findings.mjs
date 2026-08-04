import { readFile } from 'node:fs/promises';
import { artifactPaths, loadProject, repositoryFile } from '../../../../runtime/project.mjs';
import { sha256, stableJson, validateWithSchema } from '../../../visual-spec/scripts/lib/visual-spec.mjs';

export function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export async function context(root) {
  const project = await loadProject(root);
  const path = (stage, id) => artifactPaths(project, id, stage)?.authorityPath;
  const paths = {
    findings: path('flutter-ui', 'review-findings'),
    checklist: path('visual-spec', 'checklist'),
    figmaCoverage: path('figma-evidence', 'figma-coverage'),
    figmaEvidence: path('figma-evidence', 'figma-evidence'),
    authorization: path('visual-spec', 'ready-authorization'),
    plan: path('user-path-cases', 'user-path-plan'),
    l1: path('flutter-ui', 'flutter-visual-coverage'),
    l2: path('flutter-ui', 'flutter-user-path-coverage'),
    preview: path('flutter-ui', 'preview-manifest'),
    manifest: path('flutter-ui', 'ui-spec-manifest'),
    mock: path('mockcase', 'mock-scenario-suite'),
  };
  if (!paths.findings || !paths.preview) {
    throw Object.assign(new Error('Finding Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const bytes = await readFile(repositoryFile(root, paths.findings));
  const findings = JSON.parse(bytes);
  const errors = await validateWithSchema(root, '.agents/skills/flutter-ui/schemas/review-findings.schema.json', findings);
  if (errors.length) throw Object.assign(new Error(errors.map((item) => item.message).join('; ')), { code: 'RVW_SCHEMA_INVALID' });
  const previewBytes = await readFile(repositoryFile(root, paths.preview));
  const preview = JSON.parse(previewBytes);
  if (
    findings.previewLock?.path !== paths.preview
    || findings.previewLock?.revision !== preview.metadata?.revision
    || findings.previewLock?.digest !== sha256(previewBytes)
  ) throw Object.assign(new Error('Review Findings 未绑定当前 Flutter Preview。'), { code: 'RVW_PREVIEW_STALE' });
  return { project, paths, findings, bytes };
}

export function findingById(findings, findingId) {
  const finding = findings.findings.find((item) => item.findingId === findingId);
  if (!finding) throw Object.assign(new Error('Finding 不存在：' + findingId), { code: 'RVW_FINDING_NOT_FOUND' });
  return finding;
}

export async function repairEvidence(root, authorityPath, figmaEvidencePath) {
  const verificationPath = authorityPath.startsWith('figma://') ? figmaEvidencePath : authorityPath;
  if (!verificationPath) throw Object.assign(new Error('修复验证路径不存在。'), { code: 'RVW_REPAIR_INVALID' });
  let bytes;
  try { bytes = await readFile(repositoryFile(root, verificationPath)); } catch (error) {
    throw Object.assign(new Error('修复验证源不可读：' + error.message), { code: 'RVW_REPAIR_INVALID' });
  }
  let revision = null;
  try {
    const data = JSON.parse(bytes);
    revision = data?.metadata?.revision ?? data?.revision ?? null;
    if (revision !== null && (!Number.isInteger(revision) || revision < 1)) throw new Error('revision 非法');
  } catch (error) {
    if (error instanceof SyntaxError) revision = null;
    else throw Object.assign(new Error('修复验证源 revision 非法。'), { code: 'RVW_REPAIR_INVALID' });
  }
  return { authorityPath, verificationPath, revision, digest: sha256(bytes) };
}

export function assertAuthority(category, path) {
  const allowed = {
    SCHEMA: /^\.agents\/skills\/visual-spec\/schemas\//,
    CHECKLIST_BASELINE: /^(01-product-design\/|\.psp\/visual-spec\/checklist\.json$)/,
    FIGMA_SOURCE: /^figma:\/\//,
    FIGMA_BINDING: /^\.psp\/visual-spec\/figma-(coverage|evidence)\.json$/,
    FLUTTER_L1: /^lib\/ui\//,
    MOCK_ADAPTER: /^(MockCase\/|lib\/testing\/)/,
    FLUTTER_L2: /^lib\/ui\//,
    REVIEW_TOOL: /^lib\/review\//,
  }[category];
  if (!allowed || !allowed.test(path ?? '')) {
    throw Object.assign(new Error(`${category} 与 authorityPath 不匹配：${path}`), { code: 'RVW_ROOT_CAUSE_INVALID' });
  }
}

export async function loadOptional(root, path) {
  if (!path) return null;
  try {
    const bytes = await readFile(repositoryFile(root, path));
    return { path, bytes, data: JSON.parse(bytes) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function staleArtifact(record, itemId, scenarioIds = null) {
  if (!record?.data) return null;
  const data = structuredClone(record.data);
  const version = data.metadata ?? data;
  if (!Object.hasOwn(version, 'status') || !Number.isInteger(version.revision)) return null;
  version.status = 'stale';
  version.revision += 1;
  if (version.artifactId === 'FLUTTER-UI-PREVIEW' && data.preview) data.preview.acceptanceStatus = 'stale';
  for (const key of ['items', 'paths', 'scenarios']) {
    for (const item of data[key] ?? []) {
      const related = item.itemId === itemId
        || item.checklistItemRefs?.includes(itemId)
        || (key === 'scenarios' && (!scenarioIds || scenarioIds.has(item.scenarioId)));
      if (related && Object.hasOwn(item, 'status')) item.status = 'stale';
    }
  }
  return { target: record.path, content: stableJson(data), data };
}

export async function bindFindingsToPreview(root, findings, previewWrite, previewPath) {
  const previewContent = previewWrite?.content
    ?? await readFile(repositoryFile(root, previewPath), 'utf8');
  const preview = previewWrite?.data
    ?? JSON.parse(previewContent);
  findings.previewLock = {
    artifactId: 'FLUTTER-UI-PREVIEW',
    path: previewPath,
    revision: preview.metadata.revision,
    digest: sha256(Buffer.from(previewContent)),
  };
}
