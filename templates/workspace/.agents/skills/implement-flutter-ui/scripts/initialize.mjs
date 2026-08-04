import { cp, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { repositoryRootFrom } from '../../../runtime/project.mjs';
import { exists, report } from '../../flutter-ui/scripts/lib/core.mjs';
import { validateReady } from './validate-ready.mjs';

const root = repositoryRootFrom(import.meta.dirname);
let temporary = null;
try {
  const readiness = await validateReady(root);
  if (readiness.length) throw Object.assign(new Error(JSON.stringify(readiness)), { code: 'FLUTTER_IMPLEMENTATION_NOT_READY' });
  for (const path of ['pubspec.yaml', 'lib', 'android', 'ios', 'web']) if (await exists(resolve(root, path))) throw Object.assign(new Error(`目标已存在，拒绝覆盖：${path}`), { code: 'FLUTTER_INITIALIZE_CONFLICT' });
  const flutter = spawnSync('flutter', ['--version'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (flutter.status !== 0) throw Object.assign(new Error('Flutter SDK 不可用。'), { code: 'FLUTTER_SDK_MISSING' });
  temporary = await mkdtemp(resolve(tmpdir(), 'pre-sdd-flutter-'));
  const created = spawnSync('flutter', ['create', '--project-name', 'pre_sdd_ui', '--platforms', 'android,ios,web', '--no-pub', temporary], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (created.status !== 0) throw Object.assign(new Error(created.stdout || created.stderr), { code: 'FLUTTER_INITIALIZE_FAILED' });
  for (const path of ['android', 'ios', 'web']) await cp(resolve(temporary, path), resolve(root, path), { recursive: true, errorOnExist: true, force: false });
  const template = resolve(import.meta.dirname, '..', 'templates', 'flutter-workspace');
  for (const path of ['pubspec.yaml', 'analysis_options.yaml', 'lib', 'test']) await cp(resolve(template, path), resolve(root, path), { recursive: (await stat(resolve(template, path))).isDirectory(), errorOnExist: true, force: false });
  const pub = spawnSync('flutter', ['pub', 'get'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (pub.status !== 0) throw Object.assign(new Error(pub.stdout || pub.stderr), { code: 'FLUTTER_INITIALIZE_FAILED' });
  report([]);
} catch (error) { report([{ code: error.code || 'FLUTTER_INITIALIZE_FAILED', message: error.message }]); }
finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
