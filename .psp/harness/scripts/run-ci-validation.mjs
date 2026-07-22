import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

function execute(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: options.stdio || 'pipe',
    timeout: options.timeout,
  });
}

function gitPaths(root, args) {
  const result = execute('git', args, { cwd: root });
  if (result.status !== 0) {
    throw Object.assign(new Error('无法读取 Git 路径：' + (result.stderr || result.error?.message || 'unknown error')), { code: 'AIH_CI_POLICY_INVALID' });
  }
  return result.stdout.split('\0').filter(Boolean);
}

export function repositoryPaths(root) {
  return gitPaths(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
}

export function pullRequestPaths(root, base = process.env.GITHUB_BASE_SHA || 'HEAD^') {
  return gitPaths(root, ['diff', '--name-only', '-z', base + '...HEAD']);
}

export function resolveRepositoryValidation(root, paths, executionContext) {
  const args = ['.psp/harness/scripts/resolve-validation.mjs'];
  for (const path of paths) args.push('--path', path);
  args.push('--context', executionContext, '--json');
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
  if (receipt.executionContext !== executionContext) {
    throw Object.assign(new Error('Resolver 返回的执行上下文与请求不一致。'), { code: 'AIH_CI_POLICY_INVALID', receipt });
  }
  return receipt;
}

export function npmInvocation(npmScript) {
  if (process.platform === 'win32') {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'npm run ' + npmScript] };
  }
  return { command: 'npm', args: ['run', npmScript] };
}

export function validateEvidenceReport(root, report) {
  const schema = JSON.parse(readFileSync(resolve(root, '.psp/harness/schemas/evidence-report.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (!validate(report)) {
    const details = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
    throw Object.assign(new Error('Evidence Report 不符合登记 Schema：' + details), { code: 'AIH_SCHEMA_INVALID' });
  }
  return report;
}

export function runValidationCommands(root, receipt) {
  const started = Date.now();
  const validation = [];
  let failed = false;
  for (const item of receipt.plan) {
    if (failed) {
      validation.push({ ...item, status: 'NOT_RUN', durationMs: 0, blockers: [] });
      continue;
    }
    process.stdout.write('[RUN] ' + item.command + '\n');
    const invocation = npmInvocation(item.command.replace(/^npm run /, ''));
    const commandStarted = Date.now();
    const result = execute(invocation.command, invocation.args, { cwd: root, stdio: 'inherit', timeout: item.timeoutMs });
    const durationMs = Date.now() - commandStarted;
    if (result.status !== 0) {
      const timedOut = result.error?.code === 'ETIMEDOUT';
      const code = timedOut ? 'AIH_COMMAND_TIMEOUT' : 'AIH_VALIDATION_FAILED';
      if (result.error) process.stderr.write('[' + code + '] ' + result.error.message + '\n');
      validation.push({ ...item, status: 'FAIL', durationMs, blockers: [{ code }] });
      failed = true;
    } else {
      validation.push({ ...item, status: 'PASS', durationMs, blockers: [] });
    }
  }
  const status = failed ? 'FAIL' : 'PASS';
  const report = {
    protocol: receipt.protocol,
    executionContext: receipt.executionContext,
    status,
    scope: receipt.scopes,
    changes: [],
    validation,
    residuals: validation.flatMap((item) => item.blockers || []),
    metrics: {
      plannedCommandCount: receipt.plan.length,
      executedCommandCount: validation.filter((item) => item.status !== 'NOT_RUN').length,
      cacheHitCount: validation.filter((item) => item.cache?.status === 'HIT').length,
      notRunCount: validation.filter((item) => item.status === 'NOT_RUN').length,
      totalDurationMs: Date.now() - started,
    },
  };
  if (status === 'PASS' && receipt.executionContext === 'release') {
    report.credential = 'validated-scaffold-change';
  }
  return validateEvidenceReport(root, report);
}

export function planValidation(root, executionContext, options = {}) {
  const paths = executionContext === 'pull-request'
    ? pullRequestPaths(root, options.base)
    : repositoryPaths(root);
  if (paths.length === 0) {
    throw Object.assign(new Error('验证范围为空。'), { code: 'AIH_CI_POLICY_INVALID' });
  }
  const receipt = resolveRepositoryValidation(root, paths, executionContext);
  return { ...receipt, repositoryPathCount: paths.length };
}

async function main() {
  const root = resolve(process.cwd());
  const contextIndex = process.argv.indexOf('--context');
  const executionContext = contextIndex >= 0 ? process.argv[contextIndex + 1] : null;
  if (!['pull-request', 'main', 'release'].includes(executionContext)) {
    process.stderr.write('[AIH_CI_POLICY_INVALID] 必须显式提供 --context pull-request|main|release。\n');
    process.exitCode = 1;
    return;
  }
  const baseIndex = process.argv.indexOf('--base');
  const base = baseIndex >= 0 ? process.argv[baseIndex + 1] : undefined;
  let plan;
  try {
    plan = planValidation(root, executionContext, { base });
  } catch (error) {
    process.stderr.write('[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message + '\n');
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes('--plan')) {
    if (process.argv.includes('--json')) console.log(JSON.stringify(plan, null, 2));
    else for (const item of plan.plan) console.log(item.command);
    return;
  }
  process.stdout.write('[READY] ' + executionContext + ' 已覆盖 ' + plan.repositoryPathCount + ' 个仓库路径。\n');
  let result;
  try {
    result = runValidationCommands(root, plan);
  } catch (error) {
    process.stderr.write('[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message + '\n');
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
