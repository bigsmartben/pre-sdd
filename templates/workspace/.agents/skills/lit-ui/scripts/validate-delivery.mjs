import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { extname, resolve } from 'node:path';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { sha256, validateWithSchema } from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { hashUihtml } from './hash-uihtml.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
async function files(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

try {
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
  if (preflight.status !== 0) blockers.push({
    code: 'VSD_DELIVERY_NOT_ACCEPTED',
    message: preflight.stdout || preflight.stderr,
  });
  const project = await loadProject(root);
  const manifestPath = artifactPaths(project, 'uihtml-production', 'lit-ui')?.authorityPath;
  const deliveryPath = artifactPaths(project, 'delivery-manifest', 'lit-ui')?.authorityPath;
  if (!manifestPath || !deliveryPath) throw Object.assign(new Error('UIHTML Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const manifest = JSON.parse(await readFile(repositoryFile(root, manifestPath), 'utf8'));
  const deliveryBytes = await readFile(repositoryFile(root, deliveryPath));
  const delivery = JSON.parse(deliveryBytes);
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/delivery-manifest.schema.json', delivery));
  if (delivery.metadata?.status !== 'accepted') {
    blockers.push({ code: 'VSD_DELIVERY_NOT_ACCEPTED', message: 'UIHTML 只接受人工 accepted 的 Delivery。' });
  }
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/uihtml-production.schema.json', manifest));
  if (
    manifest.deliveryLock?.path !== deliveryPath
    || manifest.deliveryLock?.revision !== delivery.metadata?.revision
    || manifest.deliveryLock?.digest !== sha256(deliveryBytes)
  ) blockers.push({ code: 'VSD_UIHTML_STALE', message: 'UIHTML 未绑定当前 Delivery。' });
  if (
    manifest.litSource?.commit !== delivery.litSource?.commit
    || manifest.litSource?.srcUiDigest !== delivery.litSource?.srcUiDigest
  ) blockers.push({ code: 'VSD_LIT_SOURCE_MISMATCH', message: 'UIHTML 与已评审 Lit 不是同一源码。' });
  const uihtmlRoot = repositoryFile(root, manifest.bundle?.path ?? 'UIHTML');
  if (!(await stat(resolve(uihtmlRoot, 'index.html'))).isFile()) blockers.push({ code: 'UIHTML_RUNTIME_DEP_MISSING', message: 'UIHTML/index.html 不存在。' });
  if (await hashUihtml(uihtmlRoot) !== manifest.bundle?.digest) blockers.push({ code: 'VSD_UIHTML_DIGEST_INVALID', message: 'UIHTML Bundle 摘要不匹配。' });
  const forbidden = /(?:visual-spec|figma-(?:coverage|evidence)|review-findings|user-path-plan|test-cases|mockcase|\bmsw\b|axe-core|@playwright\/test|review-main|src\/review|src\/testing)/i;
  for (const dependency of manifest.dependencies ?? []) {
    if (forbidden.test(dependency)) blockers.push({ code: 'VSD_PRODUCTION_DEPENDENCY_FORBIDDEN', message: `生产依赖越界：${dependency}` });
  }
  for (const path of await files(uihtmlRoot)) {
    if (!['.html', '.js', '.css', '.json', '.map'].includes(extname(path).toLowerCase())) continue;
    const content = await readFile(path, 'utf8');
    if (forbidden.test(content)) blockers.push({ code: 'VSD_PRODUCTION_DEPENDENCY_FORBIDDEN', message: `生产 Bundle 泄漏 Review/Test/Spec 依赖：${path}` });
  }
} catch (error) {
  blockers.unshift({ code: error.code || 'UIHTML_RUNTIME_DEP_MISSING', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', blockers }));
if (blockers.length) process.exitCode = 1;
