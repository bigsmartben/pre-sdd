import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..', '..');
const templateRoot = resolve(repositoryRoot, 'templates', 'workspace');
const temporaryRoots = [];

test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function workspaceFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'sdd-pre-workspace-'));
  temporaryRoots.push(parent);
  const workspace = resolve(parent, 'workspace');
  await cp(templateRoot, workspace, { recursive: true });
  return workspace;
}

async function regularFiles(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

test('M01 root and workspace governance directories contain only HARNESS.md', async () => {
  for (const root of [
    resolve(repositoryRoot, '.psp', 'harness'),
    resolve(templateRoot, '.psp', 'harness'),
  ]) {
    const files = await regularFiles(root);
    assert.deepEqual(files.map((path) => path.slice(root.length + 1).replaceAll('\\', '/')), ['HARNESS.md']);
  }
});

test('M02 removed control-plane concepts have no executable registration', async () => {
  const forbiddenNames = [
    'harness.manifest.json',
    'resolve-validation.mjs',
    'run-handoff.mjs',
    'validate-harness.mjs',
    'hooks.json',
  ];
  const files = await regularFiles(repositoryRoot);
  for (const name of forbiddenNames) {
    assert.equal(files.some((path) => path.endsWith(name)), false, name);
  }

  const rootPackage = JSON.parse(await readFile(resolve(repositoryRoot, 'package.json'), 'utf8'));
  const workspacePackage = JSON.parse(await readFile(resolve(templateRoot, 'package.json'), 'utf8'));
  for (const scripts of [rootPackage.scripts, workspacePackage.scripts]) {
    for (const [name, command] of Object.entries(scripts)) {
      assert.doesNotMatch(name, /harness|handoff|consistency/i);
      assert.doesNotMatch(command, /\.psp[\\/]harness|run-handoff|resolve-validation/i);
    }
  }
});

test('M03 domain initializers operate in a generated workspace without a control plane', async () => {
  const workspace = await workspaceFixture();
  const scripts = [
    resolve(templateRoot, '.agents', 'skills', 'product-design', 'scripts', 'initialize.mjs'),
    resolve(templateRoot, '.agents', 'skills', 'architecture-design', 'scripts', 'initialize.mjs'),
  ];
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [script, '--json'], {
      cwd: workspace,
      env: { ...process.env, PSP_REPOSITORY_ROOT: workspace },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'PASS');
  }

  const project = await readFile(resolve(workspace, 'psp.project.yaml'), 'utf8');
  assert.match(project, /product-design:[\s\S]*status: active/);
  assert.match(project, /architecture-design:[\s\S]*status: active/);
  for (const path of [
    '01-product-design/.psp/models/use-cases.yaml',
    '01-product-design/UC.md',
    '01-product-design/.psp/models/visual-spec.yaml',
    '01-product-design/Visual-Spec.md',
    '02-architecture-design/.psp/models/architecture-package.yaml',
    '02-architecture-design/README.md',
  ]) {
    assert.equal((await readFile(resolve(workspace, path), 'utf8')).length > 0, true, path);
  }
});

test('U04 legacy governance requests are explicitly side-effect-free', async () => {
  const instructions = await readFile(resolve(templateRoot, 'AGENTS.md'), 'utf8');
  const principle = await readFile(resolve(templateRoot, '.psp', 'harness', 'HARNESS.md'), 'utf8');
  for (const concept of ['Manifest', 'Resolver', 'Profile', 'Scope', 'Gate', 'Consistency Report', 'Handoff Receipt']) {
    assert.match(instructions + principle, new RegExp(concept.replace(' ', '\\s+'), 'i'));
  }
  assert.match(instructions + principle, /停止写入|不产生副作用/);
});

test('L05 Lit UI scaffold is complete and contains no product instance or build output', async () => {
  for (const relative of [
    '.agents/skills/lit-ui/SKILL.md',
    '.agents/skills/lit-ui/contracts/framework.yaml',
    '.agents/skills/lit-ui/contracts/mapping.yaml',
    '.agents/skills/lit-ui/contracts/blocker-codes.yaml',
    '.agents/skills/lit-ui/templates/Mapping.html',
    '.agents/skills/lit-ui/template/src/ui/main.ts',
    '.agents/skills/lit-ui/template/src/review/review-main.ts',
    '.agents/skills/lit-ui-workflow/SKILL.md',
    '.agents/skills/implement-lit-ui/SKILL.md',
    '.agents/skills/repair-lit-ui/SKILL.md',
    '.agents/skills/use-case-generation/contract.yaml',
  ]) {
    assert.equal(
      (await readFile(resolve(templateRoot, relative), 'utf8')).length > 0,
      true,
      `LIT_UI_SCAFFOLD_INCOMPLETE: ${relative}`,
    );
  }
  for (const relative of ['Mapping.html', 'src/ui', 'UIHTML', 'node_modules', 'dist', '.vite']) {
    assert.equal(
      (await regularFiles(templateRoot)).some((path) => (
        path === resolve(templateRoot, relative)
        || path.startsWith(resolve(templateRoot, relative) + '\\')
        || path.startsWith(resolve(templateRoot, relative) + '/')
      )),
      false,
      `PRODUCT_INSTANCE_IN_SCAFFOLD or SCAFFOLD_BUILD_OUTPUT_LEAK: ${relative}`,
    );
  }
});

test('L06 project and scripts expose the Mapping to Lit to UIHTML chain without old projection refresh', async () => {
  const project = await readFile(resolve(templateRoot, 'psp.project.yaml'), 'utf8');
  const workspacePackage = JSON.parse(await readFile(resolve(templateRoot, 'package.json'), 'utf8'));
  assert.match(project, /frameworkContract:[\s\S]*Mapping\.html[\s\S]*authorityRoot: src\/ui[\s\S]*outputRoot: UIHTML/);
  assert.doesNotMatch(project, /semanticEntry:\s*src\/spec|memberProjections:[\s\S]*canonical/i);
  for (const command of Object.values(workspacePackage.scripts)) {
    assert.doesNotMatch(command, /refresh-projections|canonical-ui-prototype|ui-case-mock/);
  }
  assert.match(workspacePackage.scripts['validate:lit-ui'], /--strict/);
  assert.match(workspacePackage.scripts['check:strict'], /validate:uihtml/);

  const workspace = await workspaceFixture();
  await symlink(resolve(repositoryRoot, 'node_modules'), resolve(workspace, 'node_modules'), 'junction');
  const validator = resolve(workspace, '.agents/skills/lit-ui/scripts/validate.mjs');
  const result = spawnSync(process.execPath, [validator, '--root', workspace, '--scaffold', '--json'], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'PASS');
});
