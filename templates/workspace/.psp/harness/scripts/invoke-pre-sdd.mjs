import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const projectText = await readFile(resolve(root, 'psp.project.yaml'), 'utf8');
const manifestMatch = projectText.match(/^\s*manifest:\s*(.+)\s*$/m);
if (!manifestMatch) {
  console.error('[AIH_PROJECT_BINDING_INVALID] psp.project.yaml 未声明 harness.manifest。');
  process.exit(1);
}
const manifest = JSON.parse(await readFile(resolve(root, manifestMatch[1].trim()), 'utf8'));
const runtime = manifest.runtime;
const args = process.argv.slice(2);

function run(command, commandArgs, shell = false) {
  return spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    shell,
  });
}

let result;
if (process.env.PRE_SDD_RUNTIME_ENTRY) {
  result = run(process.execPath, [process.env.PRE_SDD_RUNTIME_ENTRY, ...args]);
} else {
  const executable = process.platform === 'win32' ? runtime.command + '.cmd' : runtime.command;
  const locator = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [runtime.command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  result = locator.status === 0
    ? run(executable, args, process.platform === 'win32')
    : { error: Object.assign(new Error('命令不存在：' + runtime.command), { code: 'ENOENT' }) };
}

if (result.error?.code === 'ENOENT') {
  const npmArgs = ['exec', '--yes', '--package=' + runtime.fallbackPackage, '--', runtime.command, ...args];
  if (process.env.npm_execpath) result = run(process.execPath, [process.env.npm_execpath, ...npmArgs]);
  else result = run(process.platform === 'win32' ? 'npm.cmd' : 'npm', npmArgs, process.platform === 'win32');
}

if (result.error) {
  console.error('[AIH_RUNTIME_UNAVAILABLE] ' + result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
