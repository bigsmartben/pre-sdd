import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { argument, collectSourceClosure, hashPath, lockFor, readArtifact, report, stableJson, validateSchema, ARTIFACTS } from './lib/core.mjs';
import { validateWorkspace } from './validate.mjs';

const profiles = { android: 'android-emulator-fixed', ios: 'ios-simulator-fixed', web: 'web-chrome-fixed' };
const outputs = { android: 'build/app/outputs/flutter-apk/app-debug.apk', ios: 'build/ios/iphonesimulator/Runner.app', web: 'build/web' };
const builds = {
  android: ['build', 'apk', '--debug', '--target', 'lib/review/review_main.dart'],
  ios: ['build', 'ios', '--simulator', '--no-codesign', '--target', 'lib/review/review_main.dart'],
  web: ['build', 'web', '--target', 'lib/review/review_main.dart'],
};

function assertCommitClosureClean(root) {
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'lib/ui', 'lib/adapters/contracts', 'lib/adapters/real', 'lib/main.dart', 'pubspec.yaml', 'pubspec.lock', 'android', 'ios', 'web'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw Object.assign(new Error('Flutter Source Closure 必须完整属于声明的 commit。'), { code: 'FLUTTER_SOURCE_COMMIT_MISMATCH' });
}

export async function buildPreview(root, { target, commit }) {
  if (!Object.hasOwn(profiles, target)) throw Object.assign(new Error('必须显式指定 target=android|ios|web。'), { code: 'FLUTTER_TARGET_REQUIRED' });
  if (!/^[a-f0-9]{7,64}$/.test(commit ?? '')) throw Object.assign(new Error('必须用 --commit 绑定 Git HEAD。'), { code: 'FLUTTER_SOURCE_COMMIT_REQUIRED' });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (head.status !== 0 || !head.stdout.trim().startsWith(commit)) throw Object.assign(new Error('声明的 commit 不是当前 Git HEAD。'), { code: 'FLUTTER_SOURCE_COMMIT_MISMATCH' });
  assertCommitClosureClean(root);
  const flutter = spawnSync('flutter', ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (flutter.status !== 0) throw Object.assign(new Error('Flutter SDK 不可用。'), { code: 'FLUTTER_SDK_MISSING' });
  const doctor = spawnSync('flutter', ['doctor', '--machine'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (doctor.status !== 0) throw Object.assign(new Error(doctor.stderr || 'Flutter doctor 失败。'), { code: 'FLUTTER_SDK_MISSING' });
  const preflight = await validateWorkspace(root, 'coverage');
  if (preflight.length) throw Object.assign(new Error(JSON.stringify(preflight)), { code: 'FLUTTER_COVERAGE_INCOMPLETE' });
  for (const args of [['pub', 'get'], ['analyze'], ['test'], builds[target]]) {
    const result = spawnSync('flutter', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) {
      const message = result.stdout || result.stderr || `flutter ${args.join(' ')} 失败。`;
      const code = args === builds[target] && /SDK|Xcode|Android toolchain|license|platform/i.test(message) ? 'FLUTTER_SDK_MISSING' : 'FLUTTER_PREVIEW_BUILD_FAILED';
      throw Object.assign(new Error(message), { code });
    }
  }
  assertCommitClosureClean(root);
  const project = await loadProject(root);
  const path = (id) => artifactPaths(project, id, 'flutter-ui')?.authorityPath;
  const l1 = await readArtifact(root, path(ARTIFACTS.l1.id));
  const checklistPath = artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath;
  const checklist = await readArtifact(root, checklistPath);
  const needsL2 = checklist.data.items.some((item) => item.requiredDeliveryLevel === 'USER_PATH');
  let l2 = null;
  if (needsL2) l2 = await readArtifact(root, path(ARTIFACTS.l2.id));
  const closure = await collectSourceClosure(root);
  const previewPath = path(ARTIFACTS.preview.id);
  let previous = null;
  try { previous = JSON.parse(await readFile(repositoryFile(root, previewPath), 'utf8')); } catch { /* first revision */ }
  const preview = {
    schemaVersion: 'psp.dev/flutter-ui/v1',
    metadata: { artifactId: 'FLUTTER-UI-PREVIEW', revision: (previous?.metadata?.revision ?? 0) + 1, status: 'reviewing' },
    source: { framework: 'flutter', language: 'dart', root: 'lib/ui', commit, digest: closure.digest },
    coverageLocks: [lockFor('FLUTTER-VISUAL-COVERAGE', l1), ...(l2 ? [lockFor('FLUTTER-USER-PATH-COVERAGE', l2)] : [])],
    preview: { target, runtimeProfile: profiles[target], buildPath: outputs[target], buildDigest: await hashPath(root, outputs[target]), reviewAdapterDigest: await hashPath(root, 'lib/review'), acceptanceStatus: 'pending', acceptedBy: null, acceptedAt: null },
    platformPolicy: { flutterNativeAdaptations: 'accepted', crossPlatformPixelParityRequired: false, previewAcceptanceMode: 'selected-target' },
  };
  const blockers = await validateSchema(root, ARTIFACTS.preview.schema, preview);
  if (blockers.length) throw Object.assign(new Error(JSON.stringify(blockers)), { code: 'FLUTTER_ARTIFACT_SCHEMA_INVALID' });
  const previewContent = stableJson(preview);
  const previewArtifact = { path: previewPath, data: preview, digest: (await import('./lib/core.mjs')).sha256(Buffer.from(previewContent)) };
  let findings;
  try {
    findings = (await readArtifact(root, path(ARTIFACTS.findings.id))).data;
    findings.metadata.revision += 1;
    findings.metadata.status = findings.findings.every((entry) => entry.status === 'closed') ? 'clear' : 'active';
    findings.previewLock = lockFor('FLUTTER-UI-PREVIEW', previewArtifact);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    findings = { schemaVersion: 'psp.dev/flutter-ui/v1', metadata: { artifactId: 'REVIEW-FINDINGS', revision: 1, status: 'clear' }, previewLock: lockFor('FLUTTER-UI-PREVIEW', previewArtifact), findings: [] };
  }
  await commitManagedWrites({ root, ownerId: 'flutter-ui-preview', writes: [{ target: previewPath, content: previewContent }, { target: path(ARTIFACTS.findings.id), content: stableJson(findings) }] });
  return preview;
}

const root = repositoryRootFrom(import.meta.dirname);
try { const preview = await buildPreview(root, { target: argument('target'), commit: argument('commit') }); report([], { target: preview.preview.target, revision: preview.metadata.revision }); }
catch (error) { report([{ code: error.code || 'FLUTTER_PREVIEW_BUILD_FAILED', message: error.message }]); }
