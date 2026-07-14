import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const entrypoint = resolve(repositoryRoot, 'bin/pre-sdd.mjs');
const temporaryRoots = [];

test.after(async () => {
  await Promise.all(temporaryRoots.map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

function runCli(args, cwd = repositoryRoot) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findDirectory(root, name) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === name) return join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await findDirectory(join(root, entry.name), name);
      if (nested) return nested;
    }
  }
  return null;
}

test('pre-sdd init creates only the bound pure workspace', async () => {
  const target = await temporaryDirectory('pre-sdd-init-');
  const initialized = runCli(['init', target]);
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);

  const project = parseYaml(await readFile(resolve(target, 'psp.project.yaml'), 'utf8'));
  assert.equal(project.stages['product-design'].status, 'uninitialized');
  assert.equal(project.stages['architecture-design'].status, 'uninitialized');
  for (const stage of Object.values(project.stages)) {
    assert.equal(await exists(resolve(target, stage.root, '.gitkeep')), true);
    assert.deepEqual(await readdir(resolve(target, stage.root)), ['.gitkeep']);
  }
  for (const forbidden of [
    '01-product-design/PSP.md',
    '01-product-design/UC.md',
    '01-product-design/HTML-Mock',
    '01-product-design/.psp/models',
    '02-architecture-design/README.md',
    '02-architecture-design/技术验证',
    '02-architecture-design/.psp/models',
  ]) assert.equal(await exists(resolve(target, forbidden)), false, forbidden);
  assert.equal(await findDirectory(target, 'node_modules'), null);

  const productStrict = runCli(['harness', 'validate:product:strict', '--workspace', target]);
  assert.notEqual(productStrict.status, 0);
  assert.match(productStrict.stderr + productStrict.stdout, /AIH_STAGE_UNINITIALIZED/);
  const architectureStrict = runCli(['harness', 'validate:architecture:strict', '--workspace', target]);
  assert.notEqual(architectureStrict.status, 0);
  assert.match(architectureStrict.stderr + architectureStrict.stdout, /AIH_STAGE_UNINITIALIZED/);
});

test('initialization blocks owned paths without touching user files', async () => {
  const target = await temporaryDirectory('pre-sdd-collision-');
  await writeFile(resolve(target, 'README.md'), 'user owned\n', 'utf8');
  await writeFile(resolve(target, 'notes.txt'), 'keep\n', 'utf8');
  const initialized = runCli(['init', target]);
  assert.notEqual(initialized.status, 0);
  assert.match(initialized.stderr, /PRE_SDD_PATH_COLLISION/);
  assert.equal(await readFile(resolve(target, 'README.md'), 'utf8'), 'user owned\n');
  assert.equal(await readFile(resolve(target, 'notes.txt'), 'utf8'), 'keep\n');
  assert.equal(await exists(resolve(target, '.psp')), false);
});

test('global runtime typechecks and builds an initialized product without local node_modules', async () => {
  const target = await temporaryDirectory('pre-sdd-runtime-');
  assert.equal(runCli(['init', target]).status, 0);
  const product = runCli(['harness', 'init:product', '--workspace', target]);
  assert.equal(product.status, 0, product.stderr + product.stdout);
  const typecheck = runCli(['harness', 'typecheck', '--workspace', target]);
  assert.equal(typecheck.status, 0, typecheck.stderr + typecheck.stdout);
  const build = runCli(['harness', 'build', '--workspace', target]);
  assert.equal(build.status, 0, build.stderr + build.stdout);
  assert.equal(await exists(resolve(target, '01-product-design/HTML-Mock/dist/index.html')), true);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('package allowlist includes runtime and template but excludes root workspace state', async () => {
  const packageJson = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.name, 'pre-sdd');
  assert.equal(packageJson.scripts.build, undefined);
  assert.equal(packageJson.bin['pre-sdd'], './bin/pre-sdd.mjs');

  const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const files = new Set(JSON.parse(packed.stdout)[0].files.map((item) => item.path));
  assert.ok(files.has('bin/pre-sdd.mjs'));
  assert.ok(files.has('runtime/dispatch.mjs'));
  assert.ok(files.has('templates/workspace/package-lock.json'));
  assert.ok(files.has('templates/workspace/.psp/harness/harness.manifest.json'));
  assert.equal([...files].some((path) => path.startsWith('.psp/')), false);
  assert.equal([...files].some((path) => path.startsWith('01-product-design/')), false);
});

test('packed software installs globally in an isolated npm prefix', async () => {
  const root = await temporaryDirectory('pre-sdd-global-');
  const packDirectory = resolve(root, 'pack');
  const prefix = resolve(root, 'prefix');
  const target = resolve(root, 'workspace');
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(prefix, { recursive: true }),
    mkdir(target, { recursive: true }),
  ]);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = resolve(packDirectory, JSON.parse(packed.stdout)[0].filename);
  const installed = spawnSync(npm, ['install', '--global', '--prefix', prefix, '--ignore-scripts', tarball], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const executable = process.platform === 'win32' ? resolve(prefix, 'pre-sdd.cmd') : resolve(prefix, 'bin/pre-sdd');
  const initialized = spawnSync(executable, ['init', target], {
    cwd: target,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  assert.equal(await exists(resolve(target, 'psp.project.yaml')), true);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});

test('git package installs globally without a repository build lifecycle', async () => {
  const root = await temporaryDirectory('pre-sdd-git-');
  const packDirectory = resolve(root, 'pack');
  const sourceParent = resolve(root, 'source');
  const prefix = resolve(root, 'prefix');
  const target = resolve(root, 'workspace');
  await Promise.all([packDirectory, sourceParent, prefix, target].map((path) => mkdir(path, { recursive: true })));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = resolve(packDirectory, JSON.parse(packed.stdout)[0].filename);
  const extracted = spawnSync('tar', ['-xf', tarball, '-C', sourceParent], { encoding: 'utf8', windowsHide: true });
  assert.equal(extracted.status, 0, extracted.stderr);
  const source = resolve(sourceParent, 'package');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'pre-sdd@example.invalid'],
    ['config', 'user.name', 'pre-sdd tests'],
    ['add', '.'],
    ['commit', '-m', 'package fixture'],
  ]) {
    const git = spawnSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr + git.stdout);
  }
  const gitSpec = pathToFileURL(source).href.replace(/^file:/, 'git+file:');
  const installed = spawnSync(npm, ['install', '--global', '--prefix', prefix, gitSpec], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(installed.status, 0, installed.stderr + installed.stdout);
  const executable = process.platform === 'win32' ? resolve(prefix, 'pre-sdd.cmd') : resolve(prefix, 'bin/pre-sdd');
  const initialized = spawnSync(executable, ['init', target], {
    cwd: target,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  assert.equal(await exists(resolve(target, 'psp.project.yaml')), true);
});

test('npm exec can initialize without creating a local dependency tree', async () => {
  const root = await temporaryDirectory('pre-sdd-exec-');
  const packDirectory = resolve(root, 'pack');
  const target = resolve(root, 'workspace');
  await Promise.all([packDirectory, target].map((path) => mkdir(path, { recursive: true })));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = spawnSync(npm, ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = resolve(packDirectory, JSON.parse(packed.stdout)[0].filename);
  const executed = spawnSync(npm, ['exec', '--yes', '--package=' + tarball, '--', 'pre-sdd', 'init', target], {
    cwd: target,
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  assert.equal(executed.status, 0, executed.stderr + executed.stdout);
  assert.equal(await exists(resolve(target, 'psp.project.yaml')), true);
  assert.equal(await findDirectory(target, 'node_modules'), null);
});
