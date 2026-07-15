import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const caseIndex = args.indexOf('--case');
const requested = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
const describe = args.includes('--describe');
const casesRoot = resolve(import.meta.dirname, '../cases');

function blocked(message, details = {}) {
  const result = {
    status: 'BLOCKED',
    blockers: [{
      code: 'AIH_TECHNICAL_VALIDATION_FAILED',
      message,
      ...details,
    }],
  };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

if (!requested || requested === '--case') {
  blocked('必须使用 --case EXP-NNN 选择一个验证实验。');
}
if (!/^EXP-[0-9]{3}$/.test(requested)) {
  blocked('实验标识符必须符合 EXP-NNN：' + requested);
}

const files = (await readdir(casesRoot)).filter((file) => file.endsWith('.case.mjs')).sort();
const selectedFile = requested + '.case.mjs';
if (!files.includes(selectedFile)) {
  blocked('未找到实验代码：' + requested, { availableCases: files });
}
const sourceContent = await readFile(resolve(casesRoot, selectedFile), 'utf8');
const sourceSha256 = createHash('sha256').update(sourceContent).digest('hex');
const loaded = await import(pathToFileURL(resolve(casesRoot, selectedFile)).href);
const selected = { ...loaded.experiment, file: selectedFile };
if (selected.id !== requested) {
  blocked('实验文件名与导出的实验标识符不一致：' + requested);
}
if (typeof selected.run !== 'function') {
  blocked('实验未导出可执行 run(context)：' + requested);
}

if (describe) {
  console.log(JSON.stringify({
    status: 'PASS',
    experiment: selected.id,
    source: 'cases/' + selected.file,
    sourceSha256,
    requiredEnvironment: selected.requiredEnvironment || [],
    blockers: [],
  }, null, 2));
  process.exit(0);
}

const missingEnvironment = (selected.requiredEnvironment || []).filter((name) => !process.env[name]);
if (missingEnvironment.length > 0) {
  blocked('实验缺少必需环境变量。', { experiment: requested, missingEnvironment });
}

try {
  const startedAt = Date.now();
  const execution = await selected.run({
    env: process.env,
    fetch,
    timeoutSignal: (milliseconds = 10_000) => AbortSignal.timeout(milliseconds),
  });
  const status = execution?.status;
  if (!['passed', 'failed'].includes(status)) {
    blocked('实验必须返回 status=passed|failed。', { experiment: requested });
  }
  const output = {
    status: status === 'passed' ? 'PASS' : 'BLOCKED',
    experiment: requested,
    source: 'cases/' + selected.file,
    sourceSha256,
    executedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    result: execution,
    blockers: status === 'passed' ? [] : [{
      code: 'AIH_TECHNICAL_VALIDATION_FAILED',
      message: execution.summary || '三方 API 实验断言失败。',
    }],
  };
  console.log(JSON.stringify(output, null, 2));
  if (output.status !== 'PASS') process.exitCode = 1;
} catch (error) {
  blocked('实验执行异常：' + error.message, { experiment: requested });
}
