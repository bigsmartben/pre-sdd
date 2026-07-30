import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { sha256, stableJson, validateWithSchema } from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { hashDirectory, hashUihtml } from './hash-uihtml.mjs';
import { productionSourceGraph } from './lib/source-graph.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
try {
  if (
    !process.argv.includes('--from-build')
    || process.env.PSP_UIHTML_BUILD_PARENT !== String(process.ppid)
  ) {
    throw Object.assign(new Error('UIHTML Manifest 只能由成功的 product build 自动记录。'), {
      code: 'VSD_UIHTML_BUILD_ORIGIN_INVALID',
    });
  }
  const preflight = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'validate.mjs'), '--phase', 'product'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
    },
  );
  if (preflight.status !== 0) {
    throw Object.assign(new Error(preflight.stdout || preflight.stderr), { code: 'VSD_DELIVERY_NOT_ACCEPTED' });
  }
  const project = await loadProject(root);
  const deliveryPath = artifactPaths(project, 'delivery-manifest', 'lit-ui')?.authorityPath;
  const manifestPath = artifactPaths(project, 'uihtml-production', 'lit-ui')?.authorityPath;
  if (!deliveryPath || !manifestPath) throw Object.assign(new Error('UIHTML Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const deliveryBytes = await readFile(repositoryFile(root, deliveryPath));
  const delivery = JSON.parse(deliveryBytes);
  if (delivery.metadata?.status !== 'accepted') throw Object.assign(new Error('只有人工 accepted 的 Delivery 可发布 UIHTML。'), { code: 'VSD_DELIVERY_NOT_ACCEPTED' });
  const srcUiDigest = await hashDirectory(repositoryFile(root, 'src/ui'));
  if (delivery.litSource?.srcUiDigest !== srcUiDigest) throw Object.assign(new Error('UIHTML 源码与已评审 Lit 不一致。'), { code: 'VSD_LIT_SOURCE_MISMATCH' });
  const graph = await productionSourceGraph(root);
  blockers.push(...graph.blockers);
  if (blockers.length) throw new Error('生产源码依赖越界。');
  const dependencies = graph.dependencies;
  const candidate = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'UIHTML-PRODUCTION', revision: 1, status: 'accepted' },
    deliveryLock: {
      artifactId: 'VISUAL-SPEC-DELIVERY',
      path: deliveryPath,
      revision: delivery.metadata.revision,
      digest: sha256(deliveryBytes),
    },
    litSource: delivery.litSource,
    adapter: 'real',
    bundle: { path: 'UIHTML', digest: await hashUihtml(repositoryFile(root, 'UIHTML')) },
    dependencies,
  };
  let previous = null;
  try { previous = JSON.parse(await readFile(repositoryFile(root, manifestPath), 'utf8')); } catch { /* initial */ }
  if (previous) {
    if (
      previous.deliveryLock?.revision === candidate.deliveryLock.revision
      && previous.deliveryLock?.digest !== candidate.deliveryLock.digest
    ) {
      throw Object.assign(new Error('Delivery 相同 revision 对应不同字节。'), {
        code: 'VISUAL_SPEC_SOURCE_REVISION_REUSED',
      });
    }
    const left = structuredClone(previous);
    const right = structuredClone(candidate);
    left.metadata.revision = 1;
    right.metadata.revision = 1;
    candidate.metadata.revision = stableJson(left) === stableJson(right) ? previous.metadata.revision : previous.metadata.revision + 1;
  }
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/uihtml-production.schema.json', candidate));
  if (blockers.length) throw new Error('UIHTML Production Manifest 无效。');
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'uihtml-production',
    writes: [{ target: manifestPath, content: stableJson(candidate) }],
  });
} catch (error) {
  if (!blockers.length || error.code) blockers.unshift({ code: error.code || 'VSD_UIHTML_RECORD_FAILED', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
