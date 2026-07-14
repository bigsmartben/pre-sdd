import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTypecheck } from './typecheck.mjs';
import { runBuild, runDev } from './vite.mjs';
import { boundArea, loadWorkspace } from './workspace.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeWorkspace = resolve(packageRoot, 'templates', 'workspace');
const require = createRequire(import.meta.url);

function childEnvironment(workspaceRoot) {
  const vitePackage = dirname(require.resolve('vite/package.json'));
  return {
    ...process.env,
    PSP_REPOSITORY_ROOT: workspaceRoot,
    AI_HARNESS_ROOT: workspaceRoot,
    PRE_SDD_RUNTIME_WORKSPACE: runtimeWorkspace,
    PRE_SDD_RUNTIME_ENTRY: resolve(packageRoot, 'bin', 'pre-sdd.mjs'),
    PRE_SDD_VITE_BIN: resolve(vitePackage, 'bin', 'vite.js'),
    PRE_SDD_VITE_CONFIG: resolve(packageRoot, 'runtime', 'vite-preview.config.mjs'),
  };
}

function runNode(arguments_, workspaceRoot) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: workspaceRoot,
    env: childEnvironment(workspaceRoot),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error('[AIH_RUNTIME_UNAVAILABLE] ' + result.error.message);
  return result.status ?? 1;
}

async function expandTestPaths(patterns) {
  const files = [];
  for (const pattern of patterns) {
    const slash = pattern.lastIndexOf('/');
    const directory = pattern.slice(0, slash);
    const suffix = pattern.slice(slash + 2);
    const entries = await readdir(resolve(runtimeWorkspace, ...directory.split('/')));
    for (const entry of entries.sort()) {
      if (entry.endsWith(suffix)) files.push(resolve(runtimeWorkspace, ...directory.split('/'), entry));
    }
  }
  return files;
}

async function runAreaScript(executor, workspaceRoot, forwarded) {
  const { project } = await loadWorkspace(workspaceRoot);
  const binding = boundArea(project, executor.area);
  if (binding.stage.status !== 'active') {
    console.error('[AIH_STAGE_UNINITIALIZED] 阶段尚未初始化，不能运行 area 命令：' + executor.area);
    return 1;
  }
  const target = resolve(workspaceRoot, ...binding.path.split('/'));
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
  const runtimeBin = resolve(packageRoot, 'node_modules', '.bin');
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(executable, ['--prefix', target, 'run', executor.script, ...forwarded], {
    cwd: workspaceRoot,
    env: { ...childEnvironment(workspaceRoot), [pathKey]: [runtimeBin, process.env[pathKey] || ''].join(delimiter) },
    stdio: 'inherit',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}

async function installBrowser() {
  const playwrightRoot = dirname(require.resolve('playwright/package.json'));
  return spawnSync(process.execPath, [resolve(playwrightRoot, 'cli.js'), 'install', 'chromium'], {
    stdio: 'inherit',
    windowsHide: true,
  }).status ?? 1;
}

export async function dispatchHarness(npmScript, workspaceRoot, forwarded = []) {
  let loaded;
  try {
    loaded = await loadWorkspace(workspaceRoot);
  } catch (error) {
    console.error('[' + (error.code || 'AIH_PROJECT_BINDING_INVALID') + '] ' + error.message);
    return 1;
  }
  if (loaded.manifest.runtime?.protocol !== 'pre-sdd-harness/v1') {
    console.error('[AIH_RUNTIME_INCOMPATIBLE] 工作区需要的 Harness 协议不受当前 pre-sdd 支持。');
    return 1;
  }
  const item = [...loaded.manifest.commands, ...loaded.manifest.operations]
    .find((candidate) => candidate.npmScript === npmScript);
  if (!item?.executor) {
    console.error('[AIH_COMMAND_INVALID] Manifest 未声明运行入口：' + npmScript);
    return 1;
  }
  const executor = item.executor;
  if (executor.kind === 'module') {
    return runNode([
      resolve(runtimeWorkspace, ...executor.path.split('/')),
      ...(executor.args || []),
      ...forwarded,
    ], loaded.root);
  }
  if (executor.kind === 'node-test') {
    return runNode(['--test', ...await expandTestPaths(executor.paths), ...forwarded], loaded.root);
  }
  if (executor.kind === 'area-script') return runAreaScript(executor, loaded.root, forwarded);
  if (executor.kind === 'runtime') {
    if (executor.capability === 'typecheck') return runTypecheck(loaded.root, packageRoot);
    if (executor.capability === 'build') return runBuild(loaded.root, packageRoot);
    if (executor.capability === 'dev') return runDev(loaded.root);
    if (executor.capability === 'install-browser') return installBrowser();
    if (executor.capability === 'html-mock-runtime') {
      return runNode([resolve(runtimeWorkspace, '.psp/harness/scripts/validate-html-mock-runtime.mjs'), ...forwarded], loaded.root);
    }
  }
  console.error('[AIH_COMMAND_INVALID] 不支持的 executor：' + JSON.stringify(executor));
  return 1;
}

export { packageRoot, runtimeWorkspace };
