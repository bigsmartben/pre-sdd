import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { normalizeRepositoryPath } from '../../scripts/lib/repository.mjs';
import { resolveHarness } from '../../scripts/lib/routing.mjs';
import {
  cleanupTemporaryRepositories,
  codes,
  manifest,
  project,
  repositoryRoot,
  runScript,
  temporaryRepository,
} from '../helpers/fixture.mjs';

test.after(cleanupTemporaryRepositories);

test('concrete paths reject traversal, absolute paths, backslashes and glob magic', () => {
  for (const path of ['../outside.md', '..\\outside.md', 'C:/outside.md', '/outside.md', '.psp/harness/*.mjs']) {
    assert.ok(normalizeRepositoryPath(path, repositoryRoot).error, path);
  }
  assert.equal(normalizeRepositoryPath('.psp/harness/HARNESS.md', repositoryRoot).path, '.psp/harness/HARNESS.md');
});

test('resolver derives stage and area paths from project binding', () => {
  const stage = project.stages['product-design'];
  const source = stage.root + '/' + stage.artifacts.capabilities.internalModel;
  const stageResult = resolveHarness(manifest, project, [source], 'change', repositoryRoot);
  assert.equal(stageResult.status, 'READY');
  assert.deepEqual(stageResult.scopes, ['product-design']);

  const areaPath = stage.root + '/' + stage.areas['html-mock'].root + '/src/main.ts';
  const areaResult = resolveHarness(manifest, project, [areaPath], 'change', repositoryRoot);
  assert.equal(areaResult.status, 'READY');
  assert.deepEqual(areaResult.scopes, ['html-mock']);
  assert.deepEqual(areaResult.profiles, ['product-uninitialized']);
});

test('resolver routes workspace markers independently from stage lifecycle', () => {
  const workspaceScope = manifest.scopes.find((scope) => scope.selector.type === 'workspace');
  const stage = project.stages['architecture-design'];
  const marker = stage.root + '/' + workspaceScope.selector.marker;
  const result = resolveHarness(manifest, project, [marker], 'change', repositoryRoot);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.scopes, ['workspace-scaffold']);
  assert.deepEqual(result.profiles, ['workspace-scaffold']);
  assert.ok(result.commands.includes('npm run validate:workspace'));
});

test('resolver unions per-path specific Scopes instead of shadowing other inputs', () => {
  const stage = project.stages['product-design'];
  const source = stage.root + '/' + stage.artifacts.capabilities.internalModel;
  const areaPath = stage.root + '/' + stage.areas['html-mock'].root + '/src/main.ts';
  const result = resolveHarness(manifest, project, [source, areaPath], 'change', repositoryRoot);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.scopes, ['html-mock', 'product-design']);
  assert.deepEqual(result.profiles, ['product-uninitialized']);
});

test('resolver blocks unknown paths, unready upstream stages and output-only edits', () => {
  const unknown = resolveHarness(manifest, project, ['unowned.txt'], 'change', repositoryRoot);
  assert.equal(unknown.status, 'BLOCKED');
  assert.equal(unknown.blockers[0].code, 'AIH_SCOPE_UNRESOLVED');

  const architectureStage = project.stages['architecture-design'];
  const architectureSource = architectureStage.root + '/' + architectureStage.artifacts['system-boundary'].internalModel;
  const architecture = resolveHarness(manifest, project, [architectureSource], 'change', repositoryRoot);
  assert.equal(architecture.status, 'BLOCKED');
  assert.ok(architecture.blockers.some((item) => item.code === 'AIH_UPSTREAM_NOT_READY'));

  const productActive = structuredClone(project);
  productActive.stages['product-design'].status = 'active';
  const routedArchitecture = resolveHarness(manifest, productActive, [architectureSource], 'change', repositoryRoot);
  assert.equal(routedArchitecture.status, 'READY');
  assert.deepEqual(routedArchitecture.scopes, ['architecture-design']);
  assert.deepEqual(routedArchitecture.profiles, ['product-delivery', 'architecture-uninitialized']);

  const stage = project.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  const source = stage.root + '/' + binding.internalModel;
  const output = stage.root + '/' + binding.outputs[0].path;
  const outputOnly = resolveHarness(manifest, project, [output], 'change', repositoryRoot);
  assert.equal(outputOnly.status, 'BLOCKED');
  assert.ok(outputOnly.blockers.some((item) => item.code === 'AIH_GENERATED_DRIFT'));
  assert.equal(resolveHarness(manifest, project, [source, output], 'change', repositoryRoot).status, 'READY');

  const readiness = resolveHarness(manifest, project, [source], 'readiness', repositoryRoot);
  assert.equal(readiness.status, 'BLOCKED');
  assert.ok(readiness.blockers.some((item) => item.code === 'AIH_STAGE_UNINITIALIZED'));
});

test('the same Harness routes an alternate user directory binding', () => {
  const alternate = structuredClone(project);
  const alternateProductRoot = ['workspace', 'product'].join('/');
  const alternateArchitectureRoot = ['workspace', 'architecture'].join('/');
  alternate.stages['product-design'].root = alternateProductRoot;
  alternate.stages['architecture-design'].root = alternateArchitectureRoot;
  const source = alternateProductRoot + '/' + alternate.stages['product-design'].artifacts.capabilities.internalModel;
  const result = resolveHarness(manifest, alternate, [source], 'change', repositoryRoot);
  assert.equal(result.status, 'READY');
  assert.deepEqual(result.scopes, ['product-design']);
  assert.ok(!JSON.stringify(manifest).includes(alternateProductRoot));

  alternate.stages['product-design'].status = 'active';
  const architectureSource = alternateArchitectureRoot + '/' + alternate.stages['architecture-design'].artifacts['system-boundary'].internalModel;
  const architectureResult = resolveHarness(manifest, alternate, [architectureSource], 'change', repositoryRoot);
  assert.equal(architectureResult.status, 'READY');
  assert.deepEqual(architectureResult.scopes, ['architecture-design']);
  assert.ok(!JSON.stringify(manifest).includes(alternateArchitectureRoot));

  const workspaceScope = manifest.scopes.find((scope) => scope.selector.type === 'workspace');
  const markerResult = resolveHarness(
    manifest,
    alternate,
    [alternateArchitectureRoot + '/' + workspaceScope.selector.marker],
    'change',
    repositoryRoot,
  );
  assert.equal(markerResult.status, 'READY');
  assert.deepEqual(markerResult.scopes, ['workspace-scaffold']);
  assert.deepEqual(markerResult.profiles, ['workspace-scaffold']);
});

test('Harness validator accepts a complete copied repository', async () => {
  const root = await temporaryRepository();
  const result = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  assert.equal(result.output.status, 'PASS');
});

test('Harness validator requires every bound stage root before instance initialization', async () => {
  const root = await temporaryRepository();
  const stage = project.stages['architecture-design'];
  await rm(resolve(root, stage.root), { recursive: true });
  const result = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(result).has('AIH_ENTRYPOINT_MISSING'), JSON.stringify(result.output, null, 2));
});

test('Harness validator rejects path traversal, invalid artifact roles, duplicate binding and missing output', async () => {
  const traversalRoot = await temporaryRepository();
  const traversalProjectPath = resolve(traversalRoot, 'psp.project.yaml');
  const traversalProject = parseYaml(await readFile(traversalProjectPath, 'utf8'));
  traversalProject.stages['product-design'].root = '../outside';
  await writeFile(traversalProjectPath, stringifyYaml(traversalProject));
  assert.ok(codes(runScript('.psp/harness/scripts/validate-harness.mjs', traversalRoot, ['--json'])).has('AIH_PROJECT_BINDING_INVALID'));

  const visibleModelRoot = await temporaryRepository();
  const visibleModelPath = resolve(visibleModelRoot, 'psp.project.yaml');
  const visibleModelProject = parseYaml(await readFile(visibleModelPath, 'utf8'));
  visibleModelProject.stages['product-design'].artifacts.capabilities.internalModel = 'UC.yaml';
  await writeFile(visibleModelPath, stringifyYaml(visibleModelProject));
  assert.ok(codes(runScript('.psp/harness/scripts/validate-harness.mjs', visibleModelRoot, ['--json'])).has('AIH_PROJECT_BINDING_INVALID'));

  const nonMarkdownRoot = await temporaryRepository();
  const nonMarkdownPath = resolve(nonMarkdownRoot, 'psp.project.yaml');
  const nonMarkdownProject = parseYaml(await readFile(nonMarkdownPath, 'utf8'));
  nonMarkdownProject.stages['product-design'].artifacts.capabilities.outputs[0].path = 'UC.yaml';
  await writeFile(nonMarkdownPath, stringifyYaml(nonMarkdownProject));
  assert.ok(codes(runScript('.psp/harness/scripts/validate-harness.mjs', nonMarkdownRoot, ['--json'])).has('AIH_PROJECT_BINDING_INVALID'));

  const duplicateRoot = await temporaryRepository();
  const duplicateProjectPath = resolve(duplicateRoot, 'psp.project.yaml');
  const duplicateProject = parseYaml(await readFile(duplicateProjectPath, 'utf8'));
  duplicateProject.stages['product-design'].artifacts.capabilities.outputs[0].path =
    duplicateProject.stages['product-design'].artifacts.interactions.internalModel;
  await writeFile(duplicateProjectPath, stringifyYaml(duplicateProject));
  assert.ok(codes(runScript('.psp/harness/scripts/validate-harness.mjs', duplicateRoot, ['--json'])).has('AIH_PROJECT_BINDING_INVALID'));

  const missingRoot = await temporaryRepository();
  const initialization = runScript('.psp/harness/scripts/init-product.mjs', missingRoot, ['--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));
  const missingProject = parseYaml(await readFile(resolve(missingRoot, 'psp.project.yaml'), 'utf8'));
  const stage = missingProject.stages['product-design'];
  await rm(resolve(missingRoot, stage.root, stage.artifacts.capabilities.outputs[0].path));
  assert.ok(codes(runScript('.psp/harness/scripts/validate-harness.mjs', missingRoot, ['--json'])).has('AIH_ENTRYPOINT_MISSING'));
});

test('Harness validator rejects a missing Contract and user-directory coupling', async () => {
  const contractRoot = await temporaryRepository();
  const fixtureManifestPath = resolve(contractRoot, project.harness.manifest);
  const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
  fixtureManifest.artifactRegistry[0].contract = '.psp/harness/contracts/missing.contract.yaml';
  await writeFile(fixtureManifestPath, JSON.stringify(fixtureManifest, null, 2));
  const contractResult = runScript('.psp/harness/scripts/validate-harness.mjs', contractRoot, ['--json']);
  assert.ok(codes(contractResult).has('AIH_CONTRACT_INVALID') || codes(contractResult).has('AIH_ENTRYPOINT_MISSING'));

  const couplingRoot = await temporaryRepository();
  const couplingProject = parseYaml(await readFile(resolve(couplingRoot, 'psp.project.yaml'), 'utf8'));
  const coupledRoot = couplingProject.stages['product-design'].root;
  await writeFile(resolve(couplingRoot, '.psp', 'harness', 'coupled.txt'), 'hard coded: ' + coupledRoot);
  assert.ok(codes(runScript('.psp/harness/scripts/validate-harness.mjs', couplingRoot, ['--json'])).has('AIH_HARNESS_COUPLED'));
});

test('SessionStart Hook remains a thin adapter from root and bound subdirectory', () => {
  const hook = resolve(repositoryRoot, '.codex/hooks/validate-harness.mjs');
  for (const cwd of [repositoryRoot, resolve(repositoryRoot, '.psp/harness')]) {
    const result = spawnSync(process.execPath, [hook], {
      cwd,
      input: JSON.stringify({ cwd }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext, /PASS/);
  }
});
