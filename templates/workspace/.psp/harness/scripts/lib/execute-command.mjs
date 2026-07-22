import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { stageIsReadable } from './stage-state.mjs';

function blockerCodes(output) {
  const codes = new Set();
  for (const match of String(output || '').matchAll(/\[(AIH_[A-Z0-9_]+)\]/g)) codes.add(match[1]);
  return [...codes];
}

function dependencyRoot(root) {
  return resolve(process.env.PRE_SDD_PACKAGE_ROOT || root);
}

function expandTestPaths(root, patterns) {
  const files = [];
  for (const pattern of patterns) {
    const slash = pattern.lastIndexOf('/');
    const directory = pattern.slice(0, slash);
    const filePattern = pattern.slice(slash + 1);
    const suffix = filePattern.startsWith('*') ? filePattern.slice(1) : filePattern;
    for (const entry of readdirSync(resolve(root, ...directory.split('/'))).sort()) {
      if (entry.endsWith(suffix)) files.push(resolve(root, ...directory.split('/'), entry));
    }
  }
  return files;
}

function npmCliInvocation(args) {
  const candidates = [
    process.env.npm_execpath,
    resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].filter(Boolean);
  const npmCli = candidates.find((candidate) => existsSync(resolve(candidate)));
  if (!npmCli) {
    const error = new Error('无法定位可信的 npm CLI 入口。');
    error.code = 'AIH_RUNTIME_UNAVAILABLE';
    throw error;
  }
  return { executable: process.execPath, args: [resolve(npmCli), ...args] };
}

function executionArguments(root, command, forwarded = []) {
  const executor = command.executor;
  if (executor.kind === 'module') {
    return { executable: process.execPath, args: [resolve(root, ...executor.path.split('/')), ...(executor.args || []), ...forwarded], cwd: root };
  }
  if (executor.kind === 'node-test') {
    return { executable: process.execPath, args: ['--test', ...expandTestPaths(root, executor.paths)], cwd: root };
  }
  if (executor.kind === 'area-script') {
    const project = parseYaml(readFileSync(resolve(root, 'psp.project.yaml'), 'utf8'));
    const matches = Object.values(project.stages || {}).flatMap((stage) => stage.areas?.[executor.area]
      ? [{ stage, area: stage.areas[executor.area] }]
      : []);
    if (matches.length !== 1 || !stageIsReadable(matches[0].stage)) {
      const error = new Error('Area 未唯一绑定或阶段未 active：' + executor.area);
      error.code = 'AIH_STAGE_UNINITIALIZED';
      throw error;
    }
    const areaRoot = resolve(root, ...matches[0].stage.root.split('/'), ...matches[0].area.root.split('/'));
    const invocation = npmCliInvocation(['--prefix', areaRoot, 'run', executor.script]);
    return { ...invocation, cwd: root };
  }
  const error = new Error('不支持的 command executor：' + executor.kind);
  error.code = 'AIH_COMMAND_INVALID';
  throw error;
}

export function executeRegisteredCommand(root, command, options = {}) {
  const startedAt = new Date().toISOString();
  let execution;
  try {
    const prepared = executionArguments(root, command, options.arguments || []);
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    execution = spawnSync(prepared.executable, prepared.args, {
      cwd: prepared.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        PSP_REPOSITORY_ROOT: root,
        AI_HARNESS_ROOT: root,
        [pathKey]: [resolve(dependencyRoot(root), 'node_modules', '.bin'), process.env[pathKey] || ''].join(delimiter),
        ...(options.environment || {}),
      },
      timeout: options.timeout || 120_000,
      windowsHide: true,
      shell: false,
    });
  } catch (error) {
    execution = { status: 1, stdout: '', stderr: '[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message };
  }
  const stdout = execution.stdout?.trim() || '';
  const timedOut = execution.error?.code === 'ETIMEDOUT';
  const stderr = execution.stderr?.trim() || (execution.error?.message || '');
  const codes = timedOut ? ['AIH_COMMAND_TIMEOUT'] : blockerCodes(stdout + '\n' + stderr);
  return {
    id: command.id,
    command: command.run,
    status: execution.status === 0 ? 'PASS' : 'FAIL',
    exitCode: execution.status ?? 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    blockers: execution.status === 0 ? [] : (codes.length > 0 ? codes : ['AIH_VALIDATION_FAILED']),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}
