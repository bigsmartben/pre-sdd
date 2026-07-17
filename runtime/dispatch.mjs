import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundArea, loadWorkspace } from './workspace.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeWorkspace = resolve(packageRoot, 'templates', 'workspace');

function dependencyRoot() {
  return resolve(process.env.PRE_SDD_DEPENDENCY_ROOT || packageRoot);
}

function childEnvironment(workspaceRoot, { nodeTest = false } = {}) {
  const dependencyLoader = '--import=' + pathToFileURL(resolve(packageRoot, 'runtime', 'register-dependency-loader.mjs')).href;
  const dependencies = dependencyRoot();
  const nodeOptions = process.env.NODE_OPTIONS || '';
  const environment = {
    ...process.env,
    PSP_REPOSITORY_ROOT: workspaceRoot,
    AI_HARNESS_ROOT: workspaceRoot,
    PRE_SDD_PACKAGE_ROOT: dependencies,
    PRE_SDD_RUNTIME_ENTRY: resolve(packageRoot, 'bin', 'pre-sdd.mjs'),
    PRE_SDD_DEPENDENCY_ROOT: dependencies,
    PRE_SDD_DEPENDENCY_ENTRY: resolve(dependencies, 'package.json'),
    NODE_OPTIONS: nodeOptions.includes(dependencyLoader)
      ? nodeOptions
      : [nodeOptions, dependencyLoader].filter(Boolean).join(' '),
  };
  if (nodeTest) delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function runNode(arguments_, workspaceRoot, options) {
  const result = spawnSync(process.execPath, arguments_, {
    cwd: workspaceRoot,
    env: childEnvironment(workspaceRoot, options),
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) console.error('[AIH_RUNTIME_UNAVAILABLE] ' + result.error.message);
  return result.status ?? 1;
}

function npmCliInvocation(arguments_) {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(resolve(candidate)));
  if (!npmCli) {
    throw Object.assign(new Error('无法定位可信的 npm CLI 入口。'), { code: 'AIH_RUNTIME_UNAVAILABLE' });
  }
  return { executable: process.execPath, arguments: [resolve(npmCli), ...arguments_] };
}

async function expandTestPaths(patterns, workspaceRoot) {
  const files = [];
  for (const pattern of patterns) {
    const slash = pattern.lastIndexOf('/');
    const directory = pattern.slice(0, slash);
    const suffix = pattern.slice(slash + 2);
    const entries = await readdir(resolve(workspaceRoot, ...directory.split('/')));
    for (const entry of entries.sort()) {
      if (entry.endsWith(suffix)) files.push(resolve(workspaceRoot, ...directory.split('/'), entry));
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
  const runtimeBin = resolve(dependencyRoot(), 'node_modules', '.bin');
  const invocation = npmCliInvocation(['--prefix', target, 'run', executor.script, ...forwarded]);
  const result = spawnSync(invocation.executable, invocation.arguments, {
    cwd: workspaceRoot,
    env: { ...childEnvironment(workspaceRoot), [pathKey]: [runtimeBin, process.env[pathKey] || ''].join(delimiter) },
    stdio: 'inherit',
    windowsHide: true,
  });
  return result.status ?? 1;
}

export async function dispatchHarness(npmScript, workspaceRoot, forwarded = []) {
  let loaded;
  try {
    loaded = await loadWorkspace(workspaceRoot);
  } catch (error) {
    console.error('[' + (error.code || 'AIH_PROJECT_BINDING_INVALID') + '] ' + error.message);
    return 1;
  }
  if (loaded.manifest.runtime?.protocol !== 'pre-sdd-harness/v2') {
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
      resolve(loaded.root, ...executor.path.split('/')),
      ...(executor.args || []),
      ...forwarded,
    ], loaded.root);
  }
  if (executor.kind === 'node-test') {
    return runNode(['--test', ...await expandTestPaths(executor.paths, loaded.root), ...forwarded], loaded.root, { nodeTest: true });
  }
  if (executor.kind === 'area-script') return runAreaScript(executor, loaded.root, forwarded);
  console.error('[AIH_COMMAND_INVALID] 不支持的 executor：' + JSON.stringify(executor));
  return 1;
}

export { packageRoot, runtimeWorkspace };
