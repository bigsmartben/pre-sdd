import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  cleanupTemporaryRepositories,
  codes,
  manifest,
  runScript,
  temporaryRepository,
} from '../helpers/fixture.mjs';

test.after(cleanupTemporaryRepositories);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function workspaceMarker() {
  return manifest.scopes.find((scope) => scope.selector.type === 'workspace').selector.marker;
}

test('workspace initialization creates every bound stage root and is idempotent', async () => {
  const root = await temporaryRepository();
  const projectPath = resolve(root, 'psp.project.yaml');
  const project = parseYaml(await readFile(projectPath, 'utf8'));
  const stages = Object.values(project.stages).filter((stage) => stage.status !== 'unavailable');
  for (const stage of stages) await rm(resolve(root, stage.root), { recursive: true, force: true });

  const dryRun = runScript('.psp/harness/scripts/init-workspace.mjs', root, ['--dry-run', '--json']);
  assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun.output, null, 2));
  for (const stage of stages) {
    assert.ok(dryRun.output.targets.includes(stage.root + '/' + workspaceMarker()));
    assert.equal(await pathExists(resolve(root, stage.root)), false);
  }

  const initialized = runScript('.psp/harness/scripts/init-workspace.mjs', root, ['--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  for (const stage of stages) {
    assert.equal(await pathExists(resolve(root, stage.root, workspaceMarker())), true);
  }
  assert.equal(runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']).exitCode, 0);
  assert.equal(runScript('.psp/harness/scripts/init-workspace.mjs', root, ['--json']).exitCode, 0);
});

test('workspace initialization follows alternate stage roots', async () => {
  const root = await temporaryRepository();
  const projectPath = resolve(root, 'psp.project.yaml');
  const project = parseYaml(await readFile(projectPath, 'utf8'));
  const productRoot = ['workspace', 'product'].join('/');
  const architectureRoot = ['workspace', 'architecture'].join('/');
  project.stages['product-design'].root = productRoot;
  project.stages['architecture-design'].root = architectureRoot;
  await writeFile(projectPath, stringifyYaml(project), 'utf8');

  const initialized = runScript('.psp/harness/scripts/init-workspace.mjs', root, ['--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  assert.equal(await pathExists(resolve(root, productRoot, workspaceMarker())), true);
  assert.equal(await pathExists(resolve(root, architectureRoot, workspaceMarker())), true);
});

test('workspace initialization blocks user files and active stage instances', async () => {
  const collisionRoot = await temporaryRepository();
  const collisionProject = parseYaml(await readFile(resolve(collisionRoot, 'psp.project.yaml'), 'utf8'));
  await writeFile(resolve(collisionRoot, collisionProject.stages['product-design'].root, 'user-owned.md'), 'user-owned\n');
  const collision = runScript('.psp/harness/scripts/init-workspace.mjs', collisionRoot, ['--json']);
  assert.ok(codes(collision).has('AIH_PARTIAL_INITIALIZATION'));

  const activeRoot = await temporaryRepository();
  const activeProjectPath = resolve(activeRoot, 'psp.project.yaml');
  const activeProject = parseYaml(await readFile(activeProjectPath, 'utf8'));
  activeProject.stages['product-design'].status = 'active';
  await writeFile(activeProjectPath, stringifyYaml(activeProject), 'utf8');
  const active = runScript('.psp/harness/scripts/init-workspace.mjs', activeRoot, ['--json']);
  assert.ok(codes(active).has('AIH_WORKSPACE_NOT_EMPTY'));
});
