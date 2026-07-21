import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const tierIndex = process.argv.indexOf('--tier');
const tier = tierIndex >= 0 ? process.argv[tierIndex + 1] : 'all';
const slow = '(?:generated workspace runs its local Harness|workspace-local runtime typechecks|Canonical UI dev|packed software installs|git package installs|npm exec can initialize)';
const filterArguments = tier === 'slow'
  ? ['--test-name-pattern=' + slow]
  : tier === 'fast'
    ? ['--test-skip-pattern=' + slow]
    : [];
const initPath = resolve(import.meta.dirname, 'init.test.mjs');
const paths = tier === 'slow' ? [initPath] : [initPath, resolve(import.meta.dirname, 'png-assets.test.mjs')];
const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
const child = spawnSync(process.execPath, ['--test', ...filterArguments, ...paths], {
  stdio: 'inherit',
  windowsHide: true,
  env: environment,
});
process.exitCode = child.status ?? 1;
