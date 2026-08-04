import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { collectSourceClosure, hashPath } from '../../templates/workspace/.agents/skills/flutter-ui/scripts/lib/core.mjs';

const enabled = process.env.RUN_FLUTTER_INTEGRATION === '1';
const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const template = resolve(repositoryRoot, 'templates/workspace/.agents/skills/implement-flutter-ui/templates/flutter-workspace');

function run(root, args) {
  const result = spawnSync('flutter', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20 * 60 * 1000 });
  assert.equal(result.status, 0, result.stdout || result.stderr || `flutter ${args.join(' ')} failed`);
}

test('Flutter template passes analyze, Widget coverage, and fixed-profile Android Preview build', { skip: !enabled, timeout: 30 * 60 * 1000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'pre-sdd-flutter-integration-'));
  try {
    run(root, ['create', '--project-name', 'pre_sdd_ui', '--platforms', 'android,ios,web', '--no-pub', '.']);
    for (const path of ['pubspec.yaml', 'analysis_options.yaml', 'lib', 'test']) {
      await rm(resolve(root, path), { recursive: true, force: true });
      await cp(resolve(template, path), resolve(root, path), { recursive: (await stat(resolve(template, path))).isDirectory() });
    }
    run(root, ['pub', 'get']);
    for (const args of [['init'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-m', 'fixture']]) {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stdout || result.stderr);
    }
    const closure = await collectSourceClosure(root);
    assert.equal(closure.files.some((entry) => /android\/.*MainActivity\.(?:kt|java)$/.test(entry.path)), true);
    run(root, ['analyze']);
    run(root, ['test', '--coverage']);
    run(root, ['build', 'apk', '--debug', '--target', 'lib/review/review_main.dart']);
    assert.equal((await stat(resolve(root, 'build/app/outputs/flutter-apk/app-debug.apk'))).isFile(), true);
    assert.match(await hashPath(root, 'build/app/outputs/flutter-apk/app-debug.apk'), /^sha256:[a-f0-9]{64}$/);
    assert.match(await hashPath(root, 'lib/review'), /^sha256:[a-f0-9]{64}$/);
    const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'lib/ui', 'lib/adapters/contracts', 'lib/adapters/real', 'lib/main.dart', 'pubspec.yaml', 'pubspec.lock', 'android', 'ios', 'web'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(dirty.stdout.trim(), '');
  } finally { await rm(root, { recursive: true, force: true }); }
});
