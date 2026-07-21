import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const tierIndex = process.argv.indexOf('--tier');
const tier = tierIndex >= 0 ? process.argv[tierIndex + 1] : 'all';
const slow = '(?:browser validator|visual policy supports|exact visual repair|Human Visual Acceptance|Component Contract runner|incremental validation)';
const filterArguments = tier === 'slow'
  ? ['--test-name-pattern=' + slow]
  : tier === 'fast'
    ? ['--test-skip-pattern=' + slow]
    : [];
const path = resolve(import.meta.dirname, 'product.test.mjs');
const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
const child = spawnSync(process.execPath, ['--test', ...filterArguments, path], {
  stdio: 'inherit',
  windowsHide: true,
  env: environment,
});
const status = child.status === 0 ? 'PASS' : 'BLOCKED';
if (process.argv.includes('--json')) console.log(JSON.stringify({ status, tier, blockers: status === 'PASS' ? [] : [{ code: 'AIH_PRODUCT_TEST_FAILED', message: 'Product Design ' + tier + ' test suite failed.' }] }));
process.exitCode = child.status ?? 1;
