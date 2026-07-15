import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

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

function executionArguments(root, command) {
  const executor = command.executor;
  if (executor.kind === 'module') {
    return { executable: process.execPath, args: [resolve(root, ...executor.path.split('/')), ...(executor.args || [])], cwd: root };
  }
  if (executor.kind === 'node-test') {
    return { executable: process.execPath, args: ['--test', ...expandTestPaths(root, executor.paths)], cwd: root };
  }
  if (executor.kind === 'area-script') {
    const project = parseYaml(readFileSync(resolve(root, 'psp.project.yaml'), 'utf8'));
    const matches = Object.values(project.stages || {}).flatMap((stage) => stage.areas?.[executor.area]
      ? [{ stage, area: stage.areas[executor.area] }]
      : []);
    if (matches.length !== 1 || matches[0].stage.status !== 'active') {
      const error = new Error('Area 未唯一绑定或阶段未 active：' + executor.area);
      error.code = 'AIH_STAGE_UNINITIALIZED';
      throw error;
    }
    const areaRoot = resolve(root, ...matches[0].stage.root.split('/'), ...matches[0].area.root.split('/'));
    const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return { executable, args: ['--prefix', areaRoot, 'run', executor.script], cwd: root, shell: process.platform === 'win32' };
  }
  const error = new Error('不支持的 command executor：' + executor.kind);
  error.code = 'AIH_COMMAND_INVALID';
  throw error;
}

export function executeRegisteredCommand(root, command, options = {}) {
  const startedAt = new Date().toISOString();
  let execution;
  try {
    const prepared = executionArguments(root, command);
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
      shell: prepared.shell || false,
    });
  } catch (error) {
    execution = { status: 1, stdout: '', stderr: '[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message };
  }
  const stdout = execution.stdout?.trim() || '';
  const stderr = execution.stderr?.trim() || '';
  const codes = blockerCodes(stdout + '\n' + stderr);
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
