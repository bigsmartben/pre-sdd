import { spawn, spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { artifactPaths, loadProject, repositoryRootFrom } from '../../../runtime/project.mjs';
import { argument, readArtifact, report, ARTIFACTS } from './lib/core.mjs';
import { validateWorkspace } from './validate.mjs';

function failed(result, fallback) {
  if (result.status === 0) return;
  const message = result.stdout || result.stderr || fallback;
  const code = /No supported devices|device|emulator|simulator|SDK|Xcode|Android toolchain/i.test(message) ? 'FLUTTER_SDK_MISSING' : 'FLUTTER_PREVIEW_OPEN_FAILED';
  throw Object.assign(new Error(message), { code });
}

async function waitForUrl(url) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch { /* server starting */ }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw Object.assign(new Error(`Web Preview server 未就绪：${url}`), { code: 'FLUTTER_PREVIEW_OPEN_FAILED' });
}

function openChrome(url, cwd) {
  const commands = platform() === 'darwin'
    ? [['open', ['-a', 'Google Chrome', url]]]
    : platform() === 'win32'
      ? [['cmd', ['/d', '/s', '/c', 'start', '', 'chrome', url]]]
      : [['google-chrome', [url]], ['chromium', [url]], ['chromium-browser', [url]]];
  let last = null;
  for (const [command, args] of commands) {
    last = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true });
    if (last.status === 0) return;
  }
  failed(last, '声明的 Chrome Web Preview runtime 启动失败。');
}

const root = repositoryRootFrom(import.meta.dirname);
try {
  const target = argument('target');
  if (!['android', 'ios', 'web'].includes(target)) throw Object.assign(new Error('必须显式指定 target=android|ios|web。'), { code: 'FLUTTER_TARGET_REQUIRED' });
  const device = target === 'web' ? argument('device', 'chrome') : argument('device');
  if (!device) throw Object.assign(new Error(`${target} Preview 必须显式提供 --device。`), { code: 'FLUTTER_DEVICE_REQUIRED' });
  if (target === 'web' && device !== 'chrome') throw Object.assign(new Error('Web Preview runtimeProfile=web-chrome-fixed，只允许 --device chrome。'), { code: 'FLUTTER_PREVIEW_TARGET_MISMATCH' });
  const blockers = await validateWorkspace(root, 'preview', false, false, true);
  if (blockers.length) throw Object.assign(new Error(JSON.stringify(blockers)), { code: blockers[0].code });
  const project = await loadProject(root);
  const preview = await readArtifact(root, artifactPaths(project, ARTIFACTS.preview.id, 'flutter-ui').authorityPath);
  if (preview.data.preview.target !== target) throw Object.assign(new Error(`当前 Preview target=${preview.data.preview.target}，不能按 ${target} 打开。`), { code: 'FLUTTER_PREVIEW_TARGET_MISMATCH' });
  const buildPath = preview.data.preview.buildPath;
  let serverPid = null;
  if (target === 'android') {
    const listed = spawnSync('flutter', ['devices', '--machine'], { cwd: root, encoding: 'utf8', windowsHide: true });
    failed(listed, '无法读取 Android 设备清单。');
    let selected;
    try { selected = JSON.parse(listed.stdout).find((entry) => entry.id === device); } catch { /* handled below */ }
    if (!selected || selected.emulator !== true || !String(selected.targetPlatform ?? '').startsWith('android')) throw Object.assign(new Error('android-emulator-fixed 只允许显式选择 Android Emulator。'), { code: 'FLUTTER_PREVIEW_TARGET_MISMATCH' });
    const result = spawnSync('flutter', ['run', '--no-resident', '-d', device, '--use-application-binary', buildPath], { cwd: root, encoding: 'utf8', windowsHide: true });
    failed(result, 'Android Preview 启动失败。');
  } else if (target === 'ios') {
    const install = spawnSync('xcrun', ['simctl', 'install', device, buildPath], { cwd: root, encoding: 'utf8', windowsHide: true });
    failed(install, 'iOS Preview 安装失败。');
    const bundle = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print:CFBundleIdentifier', resolve(root, buildPath, 'Info.plist')], { cwd: root, encoding: 'utf8', windowsHide: true });
    failed(bundle, '无法读取 iOS Preview Bundle ID。');
    const launch = spawnSync('xcrun', ['simctl', 'launch', device, bundle.stdout.trim()], { cwd: root, encoding: 'utf8', windowsHide: true });
    failed(launch, 'iOS Preview 启动失败。');
  } else {
    const port = Number(argument('port', '7357'));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Object.assign(new Error('Web Preview --port 必须是 1024..65535。'), { code: 'FLUTTER_PREVIEW_OPEN_FAILED' });
    const url = `http://127.0.0.1:${port}/`;
    const server = spawn(process.execPath, [resolve(import.meta.dirname, 'serve-web-preview.mjs'), '--root', resolve(root, buildPath), '--port', String(port)], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
    server.unref(); serverPid = server.pid;
    await waitForUrl(url);
    openChrome(url, root);
  }
  report([], { target, device, runtimeProfile: preview.data.preview.runtimeProfile, serverPid });
} catch (error) { report([{ code: error.code || 'FLUTTER_PREVIEW_OPEN_FAILED', message: error.message }]); }
