import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { sha256, stableJson, validateWithSchema } from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { hashDirectory } from './hash-uihtml.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}
async function load(root, path) {
  const bytes = await readFile(repositoryFile(root, path));
  return { bytes, digest: sha256(bytes), data: JSON.parse(bytes) };
}
function revision(previous, candidate) {
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
  const commit = argument('commit');
  if (!/^[a-f0-9]{7,64}$/.test(commit ?? '')) throw Object.assign(new Error('必须用 --commit 绑定当前 Lit 源提交。'), { code: 'VSD_LIT_SOURCE_MISSING' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (head.status === 0 && !head.stdout.trim().startsWith(commit)) {
    throw Object.assign(new Error('声明的 Lit commit 不是当前 Git HEAD。'), { code: 'VSD_LIT_SOURCE_MISMATCH' });
  }
  if (head.status === 0) {
    const dirty = spawnSync('git', [
      'status', '--porcelain', '--untracked-files=all', '--',
      'src/ui', 'src/product-main.ts', 'src/adapters/real',
    ], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (dirty.status !== 0 || dirty.stdout.trim()) {
      throw Object.assign(new Error('src/ui、生产入口与真实 Adapter 必须完整属于声明的 Git commit，不能包含未提交改动。'), {
        code: 'VSD_LIT_SOURCE_MISMATCH',
      });
    }
  }
  const preflight = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'validate.mjs'), '--phase', 'review'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
    },
  );
  if (preflight.status !== 0) {
    throw Object.assign(new Error(preflight.stdout || preflight.stderr), { code: 'VSD_COVERAGE_NOT_READY' });
  }
  const project = await loadProject(root);
  const path = (stage, id) => artifactPaths(project, id, stage)?.authorityPath;
  const paths = {
    checklist: path('visual-spec', 'checklist'),
    figmaCoverage: path('figma-workflow', 'figma-coverage'),
    figmaEvidence: path('figma-workflow', 'figma-evidence'),
    l1: path('lit-ui', 'lit-visual-coverage'),
    l2: path('lit-ui', 'user-path-coverage'),
    delivery: path('lit-ui', 'delivery-manifest'),
    findings: path('lit-ui', 'review-findings'),
  };
  if (Object.entries(paths).some(([key, value]) => key !== 'l2' && !value)) {
    throw Object.assign(new Error('Delivery Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const checklist = await load(root, paths.checklist);
  const figmaCoverage = await load(root, paths.figmaCoverage);
  const figmaEvidence = await load(root, paths.figmaEvidence);
  const l1 = await load(root, paths.l1);
  const needsL2 = checklist.data.items.some((item) => item.requiredDeliveryLevel === 'USER_PATH');
  const l2 = needsL2 ? await load(root, paths.l2) : null;
  const srcUiDigest = await hashDirectory(repositoryFile(root, 'src/ui'));
  if (l1.data.litSource?.commit !== commit || l1.data.litSource?.srcUiDigest !== srcUiDigest) {
    throw Object.assign(new Error('L1 Coverage 未绑定当前 src/ui commit/digest。'), { code: 'VSD_LIT_SOURCE_MISMATCH' });
  }
  if (l1.data.items.some((item) => item.status !== 'accepted') || l2?.data.paths.some((item) => item.status !== 'accepted')) {
    throw Object.assign(new Error('Delivery 要求声明的 L1/L2 均 accepted。'), { code: 'VSD_COVERAGE_NOT_ACCEPTED' });
  }
  const sources = [
    ['VISUAL-SPEC-CHECKLIST', paths.checklist, checklist],
    ['FIGMA-COVERAGE', paths.figmaCoverage, figmaCoverage],
    ['FIGMA-EVIDENCE', paths.figmaEvidence, figmaEvidence],
    ['LIT-VISUAL-COVERAGE', paths.l1, l1],
    ...(l2 ? [['USER-PATH-COVERAGE', paths.l2, l2]] : []),
  ];
  const l1ById = new Map(l1.data.items.map((item) => [item.itemId, item]));
  const candidate = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'VISUAL-SPEC-DELIVERY', revision: 1, status: 'reviewing' },
    sourceLocks: sources.map(([artifactId, sourcePath, source]) => ({
      artifactId,
      path: sourcePath,
      revision: source.data.metadata.revision,
      digest: source.digest,
    })),
    litSource: { commit, srcUiDigest },
    reviewBuild: {
      path: '.psp/review-dist',
      digest: await hashDirectory(repositoryFile(root, '.psp/review-dist')),
    },
    entry: { path: 'review.html', mode: 'real-lit' },
    items: checklist.data.items.map((item) => ({
      itemId: item.itemId,
      deliveryLevel: item.requiredDeliveryLevel,
      route: l1ById.get(item.itemId).route,
      component: l1ById.get(item.itemId).component,
      scenarioIds: l1ById.get(item.itemId).scenarioIds,
    })),
    reviewAcceptance: null,
  };
  let oldDelivery = null;
  try { oldDelivery = (await load(root, paths.delivery)).data; } catch { /* initial */ }
  for (const current of candidate.sourceLocks) {
    const old = (oldDelivery?.sourceLocks ?? []).find((lock) => lock.artifactId === current.artifactId);
    if (old && old.revision === current.revision && old.digest !== current.digest) {
      blockers.push({
        code: 'VISUAL_SPEC_SOURCE_REVISION_REUSED',
        message: `${current.artifactId} 在相同 revision 下改变了字节。`,
      });
    }
  }
  if (blockers.length) throw new Error('Delivery 来源复用了 revision。');
  candidate.metadata.revision = revision(oldDelivery, candidate);
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/delivery-manifest.schema.json', candidate));
  if (blockers.length) throw new Error('Delivery Manifest Schema 无效。');
  const deliveryContent = stableJson(candidate);
  let oldFindings = null;
  try { oldFindings = (await load(root, paths.findings)).data; } catch { /* initial */ }
  if (
    oldFindings?.findings?.some((finding) => ['open', 'triaged', 'repairing'].includes(finding.status))
    && oldFindings.deliveryLock?.digest !== sha256(Buffer.from(deliveryContent))
  ) {
    throw Object.assign(new Error('仍有未完成根因修复的 Finding；禁止换绑新 Delivery。'), { code: 'RVW_FINDINGS_STALE' });
  }
  const nextDeliveryLock = {
    artifactId: 'VISUAL-SPEC-DELIVERY',
    path: paths.delivery,
    revision: candidate.metadata.revision,
    digest: sha256(Buffer.from(deliveryContent)),
  };
  const findings = oldFindings ? structuredClone(oldFindings) : {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'REVIEW-FINDINGS', revision: 1, status: 'clear' },
    deliveryLock: nextDeliveryLock,
    findings: [],
  };
  if (oldFindings && oldFindings.deliveryLock?.digest !== nextDeliveryLock.digest) {
    findings.deliveryLock = nextDeliveryLock;
    findings.metadata.revision += 1;
  }
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/review-findings.schema.json', findings));
  if (blockers.length) throw new Error('Finding Schema 无效。');
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'visual-spec-delivery',
    writes: [
      { target: paths.delivery, content: deliveryContent },
      { target: paths.findings, content: stableJson(findings) },
    ],
  });
} catch (error) {
  if (!blockers.length || error.code) blockers.unshift({ code: error.code || 'VSD_DELIVERY_PREPARE_FAILED', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
