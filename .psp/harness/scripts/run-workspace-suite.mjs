import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const suites = new Map([
  ['harness', { command: 'test:harness', tests: ['.psp/harness/tests', '.agents/skills/project-consistency/tests'] }],
  ['product', {
    command: 'test:product',
    tests: ['.agents/skills/product-design/tests', '.agents/skills/mockcase-coverage/tests'],
    changePattern: '^(uninitialized product|generic initialization|Use Cases validator|Use Cases readiness|atomic UC|non-UI Use Case|legacy Wireflow|Visual Spec|Canonical UI input gate|Figma source registration packet|mockcase-coverage|Product Design apply operation|stale candidates)',
  }],
  ['architecture', {
    command: 'test:architecture',
    tests: ['.agents/skills/architecture-design/tests'],
    changePattern: '^(architecture empty scaffold|architecture initialization|architecture artifact operation|complete Architecture mapping|optional Product Design reference|each Architecture artifact|strict validation accepts|all architecture artifacts declare fixed inputs)',
  }],
]);

function run(command, args, cwd, environment = process.env) {
  return spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: 'inherit',
    windowsHide: true,
  });
}

async function testFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) files.push(path);
  }
  return files.sort();
}

const suiteIndex = process.argv.indexOf('--suite');
const suite = suiteIndex >= 0 ? process.argv[suiteIndex + 1] : undefined;
const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : undefined;
const suiteDefinition = suites.get(suite);

if (!suiteDefinition || !['template', 'generated'].includes(mode)) {
  console.error('[AIH_COMMAND_INVALID] --suite 必须是 harness、product 或 architecture，--mode 必须是 template 或 generated。');
  process.exit(1);
}

const temporaryRoot = await mkdtemp(resolve(tmpdir(), `pre-sdd-${suite}-${mode}-`));
const workspace = resolve(temporaryRoot, 'workspace');
let status = 1;
try {
  if (mode === 'generated') {
    await mkdir(workspace);
    const initialized = run(process.execPath, [resolve(repositoryRoot, 'bin/pre-sdd.mjs'), 'init', workspace], repositoryRoot);
    if (initialized.status !== 0) process.exitCode = initialized.status ?? 1;
    else {
      const invocation = resolve(workspace, '.psp/harness/scripts/invoke-pre-sdd.mjs');
      const tested = run(process.execPath, [invocation, 'harness', suiteDefinition.command], workspace);
      status = tested.status ?? 1;
      process.exitCode = status;
    }
  } else {
    await cp(resolve(repositoryRoot, 'templates/workspace'), workspace, { recursive: true });
    const files = (await Promise.all(suiteDefinition.tests.map((tests) => testFiles(resolve(workspace, tests))))).flat().sort();
    const dependencyLoader = '--import=' + pathToFileURL(resolve(repositoryRoot, 'runtime/register-dependency-loader.mjs')).href;
    const testArgs = ['--test'];
    if (suiteDefinition.changePattern) testArgs.push('--test-name-pattern=' + suiteDefinition.changePattern);
    testArgs.push(...files);
    const tested = run(process.execPath, testArgs, workspace, {
      ...process.env,
      PRE_SDD_RUNTIME_ENTRY: resolve(repositoryRoot, 'bin/pre-sdd.mjs'),
      PRE_SDD_DEPENDENCY_ROOT: repositoryRoot,
      PRE_SDD_DEPENDENCY_ENTRY: resolve(repositoryRoot, 'package.json'),
      NODE_OPTIONS: [process.env.NODE_OPTIONS, dependencyLoader].filter(Boolean).join(' '),
    });
    status = tested.status ?? 1;
    process.exitCode = status;
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

if (status === 0) console.log(`[PASS] ${mode === 'template' ? '临时模板副本' : '临时生成工作区'} ${suiteDefinition.command} 通过。`);
