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
    '01-product-design/.psp/models/functional-delivery-baseline.json',
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

test('L05 Visual Spec scaffold is complete and contains no product instance or build output', async () => {
  for (const relative of [
    '.agents/skills/visual-spec/SKILL.md',
    '.agents/skills/visual-spec/schemas/visual-spec.schema.json',
    '.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json',
    '.agents/skills/visual-spec/scripts/generate.mjs',
    '.agents/skills/user-path-cases/schemas/test-case-catalog.schema.json',
    '.agents/skills/figma-evidence/schemas/figma-coverage.schema.json',
    '.agents/skills/figma-evidence/schemas/figma-evidence.schema.json',
    '.agents/skills/flutter-ui/SKILL.md',
    '.agents/skills/flutter-ui/schemas/flutter-visual-coverage.schema.json',
    '.agents/skills/flutter-ui/schemas/flutter-user-path-coverage.schema.json',
    '.agents/skills/flutter-ui/schemas/preview-manifest.schema.json',
    '.agents/skills/flutter-ui/schemas/review-findings.schema.json',
    '.agents/skills/flutter-ui/schemas/ui-spec-manifest.schema.json',
    '.agents/skills/implement-flutter-ui/SKILL.md',
    '.agents/skills/implement-flutter-ui/templates/flutter-workspace/lib/ui/app/app.dart',
    '.agents/skills/implement-flutter-ui/templates/flutter-workspace/lib/review/review_main.dart',
    '.agents/skills/repair-visual-delivery/SKILL.md',
    '.agents/skills/mockcase/schemas/mock-scenario-suite.schema.json',
  ]) {
    assert.equal(
      (await readFile(resolve(templateRoot, relative), 'utf8')).length > 0,
      true,
      `FLUTTER_UI_SCAFFOLD_INCOMPLETE: ${relative}`,
    );
  }
  for (const relative of ['.psp/visual-spec', '.psp/ui-spec', 'lib/ui', 'node_modules', 'dist', 'build', '.dart_tool']) {
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

test('L06 project and scripts expose only the Visual Spec to Flutter Preview to Manifest chain', async () => {
  const project = await readFile(resolve(templateRoot, 'psp.project.yaml'), 'utf8');
  const workspacePackage = JSON.parse(await readFile(resolve(templateRoot, 'package.json'), 'utf8'));
  assert.match(project, /internalModel: \.psp\/models\/use-cases\.yaml/);
  assert.match(project, /internalModel: \.psp\/models\/functional-delivery-baseline\.json/);
  assert.match(project, /internalModel: Cases\/test-cases\.json/);
  assert.match(project, /internalModel: \.psp\/visual-spec\/checklist\.json/);
  assert.match(project, /figma-coverage\.json/);
  assert.match(project, /flutter-visual-coverage\.json/);
  assert.match(project, /preview-manifest\.json/);
  assert.match(project, /internalModel: \.psp\/ui-spec\/manifest\.json/);
  assert.match(project, /authorityRoot: lib\/ui/);
  assert.doesNotMatch(project, /Mapping\.html|LitSpec|Preview\.html|ui-cases\.json|consumerTargets|UIHTML|lit-ui/);
  for (const command of Object.values(workspacePackage.scripts)) {
    assert.doesNotMatch(command, /mapping|litspec|uihtml|ui-cases|use-case-generation|repair-lit-ui|lit-ui/i);
  }
  assert.match(workspacePackage.scripts['validate:visual-spec'], /visual-spec\/scripts\/validate/);
  assert.match(workspacePackage.scripts['validate:flutter-preview'], /--phase preview/);
  assert.match(workspacePackage.scripts['build:flutter-preview'], /flutter-ui\/scripts\/build-preview/);
  assert.match(workspacePackage.scripts['open:flutter-preview'], /flutter-ui\/scripts\/open-preview/);
  assert.match(workspacePackage.scripts['generate:ui-spec-manifest'], /generate-manifest/);
  assert.match(workspacePackage.scripts['check:strict'], /validate:ui-spec-manifest/);

  for (const forbidden of [
    '.agents/skills/lit-ui',
    '.agents/skills/implement-lit-ui',
    '.agents/skills/use-case-generation',
    '.agents/skills/repair-lit-ui',
    '.agents/skills/product-design/visual-spec',
    '.agents/skills/figma-evidence/acquisition-packet.schema.json',
  ]) {
    assert.equal((await regularFiles(templateRoot)).some((path) => path.startsWith(resolve(templateRoot, forbidden))), false, forbidden);
  }

  const workspace = await workspaceFixture();
  await symlink(resolve(repositoryRoot, 'node_modules'), resolve(workspace, 'node_modules'), 'junction');
  const validator = resolve(workspace, '.agents/skills/flutter-ui/scripts/validate.mjs');
  const result = spawnSync(process.execPath, [validator, '--root', workspace, '--scaffold', '--json'], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true,
    env: process.env,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'PASS');
});
