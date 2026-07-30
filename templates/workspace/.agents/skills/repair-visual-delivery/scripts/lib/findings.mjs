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
    findings: path('lit-ui', 'review-findings'),
    checklist: path('visual-spec', 'checklist'),
    figmaCoverage: path('figma-workflow', 'figma-coverage'),
    figmaEvidence: path('figma-workflow', 'figma-evidence'),
    authorization: path('visual-spec', 'ready-authorization'),
    plan: path('user-path-cases', 'user-path-plan'),
    l1: path('lit-ui', 'lit-visual-coverage'),
    l2: path('lit-ui', 'user-path-coverage'),
    delivery: path('lit-ui', 'delivery-manifest'),
    uihtml: path('lit-ui', 'uihtml-production'),
    mock: path('mockcase', 'mock-scenario-suite'),
  };
  if (!paths.findings || !paths.delivery) {
    throw Object.assign(new Error('Finding Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const bytes = await readFile(repositoryFile(root, paths.findings));
  const findings = JSON.parse(bytes);
  const errors = await validateWithSchema(root, '.agents/skills/lit-ui/schemas/review-findings.schema.json', findings);
  if (errors.length) throw Object.assign(new Error(errors.map((item) => item.message).join('; ')), { code: 'RVW_SCHEMA_INVALID' });
  const deliveryBytes = await readFile(repositoryFile(root, paths.delivery));
  const delivery = JSON.parse(deliveryBytes);
  if (
    findings.deliveryLock?.path !== paths.delivery
    || findings.deliveryLock?.revision !== delivery.metadata?.revision
    || findings.deliveryLock?.digest !== sha256(deliveryBytes)
  ) throw Object.assign(new Error('Review Findings 未绑定当前 Delivery。'), { code: 'RVW_DELIVERY_STALE' });
  return { project, paths, findings, bytes };
}

export function findingById(findings, findingId) {
  const finding = findings.findings.find((item) => item.findingId === findingId);
  if (!finding) throw Object.assign(new Error('Finding 不存在：' + findingId), { code: 'RVW_FINDING_NOT_FOUND' });
  return finding;
}

export function assertAuthority(category, path) {
  const allowed = {
    SCHEMA: /^\.agents\/skills\/visual-spec\/schemas\//,
    CHECKLIST_BASELINE: /^(01-product-design\/|\.psp\/visual-spec\/checklist\.json$)/,
    FIGMA_SOURCE: /^figma:\/\//,
    FIGMA_BINDING: /^\.psp\/visual-spec\/figma-(coverage|evidence)\.json$/,
    LIT_L1: /^src\/ui\//,
    MOCK_ADAPTER: /^(MockCase\/|src\/testing\/)/,
    LIT_L2: /^src\/ui\//,
    REVIEW_TOOL: /^src\/review\//,
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

export async function bindFindingsToDelivery(root, findings, deliveryWrite, deliveryPath) {
  const deliveryContent = deliveryWrite?.content
    ?? await readFile(repositoryFile(root, deliveryPath), 'utf8');
  const delivery = deliveryWrite?.data
    ?? JSON.parse(deliveryContent);
  findings.deliveryLock = {
    artifactId: 'VISUAL-SPEC-DELIVERY',
    path: deliveryPath,
    revision: delivery.metadata.revision,
    digest: sha256(Buffer.from(deliveryContent)),
  };
}
