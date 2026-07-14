import { spawnSync } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import {
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const args = process.argv.slice(2);
let areaId;
let script;
const forwarded = [];

for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--area' && args[index + 1]) areaId = args[++index];
  else if (args[index] === '--script' && args[index + 1]) script = args[++index];
  else forwarded.push(args[index]);
}

if (!areaId || !script) {
  console.error('[AIH_PROJECT_BINDING_INVALID] 必须提供 --area 与 --script。');
  process.exit(1);
}

const { project } = await loadProjectAndManifest(root);
const matches = [];
for (const [stageId, stage] of Object.entries(project.stages)) {
  if (stage.areas?.[areaId]) {
    matches.push({ stageId, path: stage.root + '/' + stage.areas[areaId].root });
  }
}
if (matches.length !== 1) {
  console.error('[AIH_PROJECT_BINDING_INVALID] area 必须唯一绑定：' + areaId);
  process.exit(1);
}

const matchedStage = project.stages[matches[0].stageId];
if (matchedStage.status === 'uninitialized') {
  console.error('[AIH_STAGE_UNINITIALIZED] 阶段尚未初始化，不能运行 area 命令：' + areaId);
  process.exit(1);
}
if (matchedStage.status !== 'active') {
  console.error('[AIH_PROJECT_BINDING_INVALID] area 所属阶段不可执行：' + matches[0].stageId);
  process.exit(1);
}

const target = repositoryFile(root, matches[0].path);
const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
const rootBin = resolve(root, 'node_modules', '.bin');
const harnessRuntimeBin = resolve(import.meta.dirname, '..', '..', 'node_modules', '.bin');
const environment = {
  ...process.env,
  [pathKey]: [rootBin, harnessRuntimeBin, process.env[pathKey] || ''].join(delimiter),
};
const npmArguments = ['--prefix', target, 'run', script, ...forwarded];
const executable = process.env.npm_execpath ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
const commandArguments = process.env.npm_execpath
  ? [process.env.npm_execpath, ...npmArguments]
  : npmArguments;
const result = spawnSync(executable, commandArguments, {
  cwd: root,
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
  shell: !process.env.npm_execpath && process.platform === 'win32',
});
if (result.error) console.error('[AIH_VALIDATION_FAILED] 无法执行项目命令：' + result.error.message);
process.exit(result.status ?? 1);
