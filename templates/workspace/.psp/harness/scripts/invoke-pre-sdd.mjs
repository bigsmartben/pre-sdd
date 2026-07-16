import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '../../..');
const projectText = await readFile(resolve(root, 'psp.project.yaml'), 'utf8');
const manifestMatch = projectText.match(/^\s*manifest:\s*(.+)\s*$/m);
if (!manifestMatch) {
  console.error('[AIH_PROJECT_BINDING_INVALID] psp.project.yaml 未声明 harness.manifest。');
  process.exit(1);
}
const manifest = JSON.parse(await readFile(resolve(root, manifestMatch[1].trim()), 'utf8'));
const args = process.argv.slice(2);
const localRuntimeEntry = resolve(root, manifest.runtime.entrypoint);
const packageText = await readFile(resolve(root, 'package.json'), 'utf8');
const lockText = await readFile(resolve(root, manifest.runtime.dependencyLock), 'utf8');

function run(command, commandArgs, { cwd = root, environment = process.env, shell = false } = {}) {
  return spawnSync(command, commandArgs, {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
    shell,
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function runNpm(commandArgs, cwd) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...commandArgs], { cwd });
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', commandArgs, {
    cwd,
    shell: process.platform === 'win32',
  });
}

async function dependencyRoot() {
  const local = resolve(root, 'node_modules');
  if (await exists(resolve(local, 'yaml/package.json'))) return root;

  const key = createHash('sha256')
    .update(lockText)
    .update('\0' + process.platform + '\0' + process.arch + '\0' + process.versions.modules)
    .digest('hex')
    .slice(0, 24);
  const cacheParent = resolve(tmpdir(), 'pre-sdd-workspace-runtime');
  const cache = join(cacheParent, key);
  const ready = join(cache, '.pre-sdd-ready');
  if (await exists(ready)) return cache;

  await mkdir(cacheParent, { recursive: true });
  const staging = await mkdtemp(join(cacheParent, '.install-'));
  try {
    await Promise.all([
      writeFile(resolve(staging, 'package.json'), packageText, 'utf8'),
      writeFile(resolve(staging, 'package-lock.json'), lockText, 'utf8'),
    ]);
    const installed = runNpm(['ci', '--ignore-scripts', '--omit=dev'], staging);
    if (installed.error || installed.status !== 0) {
      const detail = installed.error?.message || 'npm ci 返回 ' + installed.status;
      throw Object.assign(new Error('无法按工作区 package-lock.json 准备运行依赖：' + detail), {
        code: 'AIH_RUNTIME_UNAVAILABLE',
      });
    }
    await writeFile(resolve(staging, '.pre-sdd-ready'), key + '\n', 'utf8');
    try {
      await rename(staging, cache);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !await exists(ready)) throw error;
    }
    return cache;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

let result;
try {
  if (!await exists(localRuntimeEntry)) {
    throw Object.assign(new Error('工作区缺少初始化时固定的本地 pre-sdd 运行时。'), {
      code: 'AIH_RUNTIME_UNAVAILABLE',
    });
  }
  const dependencies = await dependencyRoot();
  const dependencyLoader = '--import=' + pathToFileURL(resolve(localRuntimeEntry, '../../runtime/register-dependency-loader.mjs')).href;
  result = run(process.execPath, [localRuntimeEntry, ...args], {
    environment: {
      ...process.env,
      PRE_SDD_DEPENDENCY_ROOT: dependencies,
      PRE_SDD_DEPENDENCY_ENTRY: resolve(dependencies, 'package.json'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, dependencyLoader].filter(Boolean).join(' '),
    },
  });
  if (result.error) throw result.error;
} catch (error) {
  console.error('[' + (error.code || 'AIH_RUNTIME_UNAVAILABLE') + '] ' + error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
