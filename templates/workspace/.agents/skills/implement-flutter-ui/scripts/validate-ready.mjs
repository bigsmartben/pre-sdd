import { artifactPaths, loadProject, repositoryRootFrom } from '../../../runtime/project.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, resolve } from 'node:path';
import { readArtifact, report, sameLock } from '../../flutter-ui/scripts/lib/core.mjs';

export async function validateReady(root) {
  const blockers = [];
  const validator = resolve(import.meta.dirname, '../../figma-evidence/scripts/validate.mjs');
  const freshnessPath = process.env.PSP_FIGMA_FRESHNESS_PATH;
  const args = [validator, '--json'];
  if (freshnessPath) args.push('--figma-freshness', freshnessPath);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PSP_REPOSITORY_ROOT: root },
  });
  if (result.status !== 0) blockers.push({
    code: 'FLUTTER_FIGMA_SOURCE_STALE',
    message: result.stdout || result.stderr || '当前 Figma freshness 未通过。',
  });
  const project = await loadProject(root);
  const path = (stage, id) => artifactPaths(project, id, stage)?.authorityPath;
  try {
    const checklist = await readArtifact(root, path('visual-spec', 'checklist'));
    const authorization = await readArtifact(root, path('visual-spec', 'ready-authorization'));
    const figmaCoverage = await readArtifact(root, path('figma-evidence', 'figma-coverage'));
    const figmaEvidence = await readArtifact(root, path('figma-evidence', 'figma-evidence'));
    if (authorization.data.status !== 'ready' || checklist.data.metadata.status !== 'ready' || figmaCoverage.data.metadata.status !== 'ready' || figmaEvidence.data.metadata.status !== 'ready') throw new Error('Visual/Figma 输入不是 ready。');
    if ((checklist.data.gaps ?? []).length || (figmaCoverage.data.gaps ?? []).length || (figmaEvidence.data.gaps ?? []).length) throw new Error('Visual/Figma 输入仍有 Gap。');
    if (authorization.data.checklist.path !== checklist.path || authorization.data.checklist.revision !== checklist.data.metadata.revision || authorization.data.checklist.digest !== checklist.digest) throw new Error('Ready Authorization 的 Checklist Lock 已 stale。');
    if (!sameLock({ path: authorization.data.figmaCoverage.path, revision: authorization.data.figmaCoverage.revision, digest: authorization.data.figmaCoverage.digest }, figmaCoverage)) throw new Error('Ready Authorization 的 Figma Coverage Lock 已 stale。');
    if (!sameLock({ path: authorization.data.figmaEvidence.path, revision: authorization.data.figmaEvidence.revision, digest: authorization.data.figmaEvidence.digest }, figmaEvidence)) throw new Error('Ready Authorization 的 Figma Evidence Lock 已 stale。');
    if (checklist.data.items.some((item) => item.requiredDeliveryLevel === 'USER_PATH')) {
      const plan = await readArtifact(root, path('user-path-cases', 'user-path-plan'));
      const mock = await readArtifact(root, path('mockcase', 'mock-scenario-suite'));
      if (plan.data.metadata.status !== 'ready' || mock.data.metadata.status !== 'ready' || plan.data.gaps.length || mock.data.gaps.length) throw new Error('USER_PATH 要求 Ready Path Plan 与 Mock Scenario。');
    }
  } catch (error) { blockers.push({ code: error.code || 'FLUTTER_IMPLEMENTATION_NOT_READY', message: error.message }); }
  return blockers;
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const root = repositoryRootFrom(import.meta.dirname);
  report(await validateReady(root));
}
