import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { validateCases } from './validate.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

try {
  const input = resolve(argument('input'));
  const output = resolve(argument('output', 'Cases/ui-cases.json'));
  const model = JSON.parse(await readFile(input, 'utf8'));
  const blockers = validateCases(model);
  if (blockers.length) {
    console.log(JSON.stringify({ status: 'BLOCKED', blockers }));
    process.exitCode = 1;
  } else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(model, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: 'PASS', output, gaps: model.gaps.length }));
  }
} catch (error) {
  console.log(JSON.stringify({
    status: 'BLOCKED',
    blockers: [{ code: error?.code === 'EEXIST' ? 'UI_CASE_OUTPUT_EXISTS' : 'UI_CASE_GENERATION_FAILED', message: error instanceof Error ? error.message : String(error) }],
  }));
  process.exitCode = 1;
}
