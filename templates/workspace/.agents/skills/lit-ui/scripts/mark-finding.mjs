import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { sha256, stableJson, validateWithSchema } from '../../visual-spec/scripts/lib/visual-spec.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
let findingId = null;
try {
  const preflight = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'validate.mjs'), '--phase', 'delivery', '--allow-open-findings'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
    },
  );
  if (preflight.status !== 0) {
    throw Object.assign(new Error(preflight.stdout || preflight.stderr), { code: 'RVW_DELIVERY_STALE' });
  }
  const project = await loadProject(root);
  const deliveryPath = artifactPaths(project, 'delivery-manifest', 'lit-ui')?.authorityPath;
  const findingsPath = artifactPaths(project, 'review-findings', 'lit-ui')?.authorityPath;
  if (!deliveryPath || !findingsPath) throw Object.assign(new Error('Finding Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const delivery = JSON.parse(await readFile(repositoryFile(root, deliveryPath), 'utf8'));
  const findings = JSON.parse(await readFile(repositoryFile(root, findingsPath), 'utf8'));
  const itemId = argument('item');
  const item = delivery.items?.find((entry) => entry.itemId === itemId);
  if (!item) throw Object.assign(new Error('Delivery 中不存在 itemId：' + itemId), { code: 'RVW_ITEM_INVALID' });
  if (delivery.metadata?.status !== 'reviewing') {
    throw Object.assign(new Error('只能在 reviewing Delivery 上记录 Finding。'), { code: 'RVW_DELIVERY_STALE' });
  }
  const level = argument('level', item.deliveryLevel === 'USER_PATH' ? 'L2' : 'L1');
  const testCaseId = argument('test-case');
  const pathStepId = argument('path-step');
  if (level === 'L2' && (!testCaseId || !pathStepId)) {
    throw Object.assign(new Error('L2 Finding 必须绑定 Test Case 与 Path Step。'), { code: 'RVW_CONTEXT_INCOMPLETE' });
  }
  if (level === 'L2' && item.deliveryLevel !== 'USER_PATH') {
    throw Object.assign(new Error('VISUAL-only Item 不能创建 L2 Finding。'), { code: 'RVW_CONTEXT_INCOMPLETE' });
  }
  const screenshot = argument('screenshot');
  const screenshotBytes = await readFile(repositoryFile(root, screenshot));
  const evidenceRefs = argument('figma-evidence', '').split(',').map((value) => value.trim()).filter(Boolean);
  if (!evidenceRefs.length) throw Object.assign(new Error('Finding 必须绑定 Figma Evidence。'), { code: 'RVW_CONTEXT_INCOMPLETE' });
  const path = (stage, id) => artifactPaths(project, id, stage)?.authorityPath;
  const coverage = JSON.parse(await readFile(repositoryFile(root, path('figma-workflow', 'figma-coverage')), 'utf8'));
  const evidence = JSON.parse(await readFile(repositoryFile(root, path('figma-workflow', 'figma-evidence')), 'utf8'));
  const validEvidenceRefs = new Set([
    ...(coverage.items ?? []).flatMap((entry) => (entry.anchors ?? []).map((anchor) => anchor.nodeId)),
    ...(evidence.assets ?? []).map((entry) => entry.assetId),
    ...(evidence.tokens ?? []).map((entry) => entry.tokenId),
    ...(evidence.motions ?? []).map((entry) => entry.motionId),
  ]);
  for (const ref of evidenceRefs) {
    if (!validEvidenceRefs.has(ref)) throw Object.assign(new Error('Finding 引用未知 Figma Evidence：' + ref), {
      code: 'RVW_CONTEXT_INCOMPLETE',
    });
  }
  const l1 = JSON.parse(await readFile(repositoryFile(root, path('lit-ui', 'lit-visual-coverage')), 'utf8'));
  const l1Item = l1.items?.find((entry) => entry.itemId === itemId);
  const viewport = argument('viewport');
  const state = argument('state');
  if (!l1Item || !(l1Item.viewports ?? []).includes(viewport) || !(l1Item.states ?? []).includes(state)) {
    throw Object.assign(new Error('Finding viewport/state 不在当前 L1 覆盖中。'), { code: 'RVW_CONTEXT_INCOMPLETE' });
  }
  if (level === 'L2') {
    const l2 = JSON.parse(await readFile(repositoryFile(root, path('lit-ui', 'user-path-coverage')), 'utf8'));
    const l2Path = (l2.paths ?? []).find((entry) => (
      entry.testCaseRef === testCaseId
      && entry.checklistItemRefs?.includes(itemId)
      && entry.steps?.some((step) => step.pathStepId === pathStepId)
    ));
    if (!l2Path) throw Object.assign(new Error('Finding Test Case/Path Step 不属于当前 Item。'), {
      code: 'RVW_CONTEXT_INCOMPLETE',
    });
  }
  const numbers = (findings.findings ?? []).map((entry) => Number(entry.findingId.slice(4))).filter(Number.isInteger);
  findingId = `RVW-${String((numbers.length ? Math.max(...numbers) : 0) + 1).padStart(4, '0')}`;
  findings.findings.push({
    findingId,
    status: 'open',
    level,
    itemId,
    route: item.route,
    component: item.component,
    viewport,
    state,
    testCaseId: level === 'L2' ? testCaseId : null,
    pathStepId: level === 'L2' ? pathStepId : null,
    figmaEvidenceRefs: evidenceRefs,
    litSource: {
      commit: delivery.litSource.commit,
      srcUiDigest: delivery.litSource.srcUiDigest,
      reviewBuildDigest: delivery.reviewBuild.digest,
    },
    screenshot: { path: screenshot, digest: sha256(screenshotBytes) },
    description: argument('description'),
    rootCause: null,
    repair: null,
    verification: null,
  });
  findings.metadata.revision += 1;
  findings.metadata.status = 'active';
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/review-findings.schema.json', findings));
  if (blockers.length) throw new Error('Finding 上下文不完整。');
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'visual-spec-review-finding',
    writes: [{ target: findingsPath, content: stableJson(findings) }],
  });
} catch (error) {
  if (!blockers.length || error.code) blockers.unshift({ code: error.code || 'RVW_MARK_FAILED', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', findingId, transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
