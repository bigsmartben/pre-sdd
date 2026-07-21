import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.stdio || 'pipe',
  });
}

export function repositoryPaths(root) {
  const result = execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root });
  if (result.status !== 0) {
    throw Object.assign(new Error('无法读取 Git 仓库路径：' + (result.stderr || result.error?.message || 'unknown error')), { code: 'AIH_CI_POLICY_INVALID' });
  }
  return result.stdout.split('\0').filter(Boolean);
}

export function resolveRepositoryValidation(root, paths, intent = 'checkpoint') {
  const resolver = '.psp/harness/scripts/resolve-validation.mjs';
  const args = [resolver];
  for (const path of paths) args.push('--path', path);
  args.push('--intent', intent, '--json');
  if (intent === 'readiness') args.push('--release');
  const result = execute(process.execPath, args, { cwd: root });
  let receipt;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    throw Object.assign(new Error('Resolver 未返回有效 JSON：' + (result.stderr || result.stdout)), { code: 'AIH_CI_POLICY_INVALID' });
  }
  if (result.status !== 0 || receipt.status !== 'READY') {
    const details = (receipt.blockers || []).map((item) => '[' + item.code + '] ' + item.message).join('\n');
    throw Object.assign(new Error(details || 'Resolver 未返回 READY。'), { code: receipt.blockers?.[0]?.code || 'AIH_VALIDATION_FAILED', receipt });
  }
  if (receipt.intent !== intent || (intent === 'readiness' && receipt.completionEligible !== true)) {
    throw Object.assign(new Error('Resolver 返回的验证意图或完成资格与请求不一致。'), {
      code: 'AIH_CI_POLICY_INVALID',
      receipt,
    });
  }
  return receipt;
}

export function npmInvocation(npmScript) {
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm run ' + npmScript],
    };
  }
  return { command: 'npm', args: ['run', npmScript] };
}

export function runValidationCommands(root, receipt) {
  const validation = [];
  for (let index = 0; index < receipt.commandIds.length; index += 1) {
    const id = receipt.commandIds[index];
    const run = receipt.commands[index];
    const npmScript = run.replace(/^npm run /, '');
    process.stdout.write('[RUN] ' + run + '\n');
    const invocation = npmInvocation(npmScript);
    const result = execute(invocation.command, invocation.args, { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) {
      if (result.error) process.stderr.write('[AIH_VALIDATION_FAILED] ' + result.error.message + '\n');
      validation.push({ id, command: run, status: 'FAIL' });
      for (let remaining = index + 1; remaining < receipt.commandIds.length; remaining += 1) {
        validation.push({ id: receipt.commandIds[remaining], command: receipt.commands[remaining], status: 'NOT_RUN' });
      }
      return { status: 'FAIL', validation };
    }
    validation.push({ id, command: run, status: 'PASS' });
  }
  return { status: 'PASS', validation };
}

export function planContinuousIntegration(root = process.cwd()) {
  const paths = repositoryPaths(root);
  const receipt = resolveRepositoryValidation(root, paths, 'checkpoint');
  return { ...receipt, repositoryPathCount: paths.length };
}

export function planReleaseValidation(root = process.cwd()) {
  const paths = repositoryPaths(root);
  const receipt = resolveRepositoryValidation(root, paths, 'readiness');
  return { ...receipt, repositoryPathCount: paths.length };
}

async function main() {
  const root = resolve(process.cwd());
  const release = process.argv.includes('--release');
  let plan;
  try {
    plan = release ? planReleaseValidation(root) : planContinuousIntegration(root);
  } catch (error) {
    process.stderr.write('[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message + '\n');
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--plan')) {
    if (process.argv.includes('--json')) console.log(JSON.stringify(plan, null, 2));
    else for (const command of plan.commands) console.log(command);
    return;
  }

  process.stdout.write('[READY] ' + plan.intent + ' 已覆盖 ' + plan.repositoryPathCount + ' 个仓库路径。\n');
  const result = runValidationCommands(root, plan);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
