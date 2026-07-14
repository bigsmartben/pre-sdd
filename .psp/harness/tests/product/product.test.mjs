import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  cleanupTemporaryRepositories,
  codes,
  repositoryRoot,
  runScript,
  temporaryRepository,
} from '../helpers/fixture.mjs';
import {
  completeProductFixture,
  fixtureProject,
  readArtifact,
  writeArtifact,
} from '../helpers/product-fixture.mjs';

test.after(cleanupTemporaryRepositories);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function runAreaCommand(root, script) {
  return spawnSync(process.execPath, [
    resolve(repositoryRoot, '.psp/harness/scripts/run-project-command.mjs'),
    '--area',
    'html-mock',
    '--script',
    script,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PSP_REPOSITORY_ROOT: root,
      AI_HARNESS_ROOT: root,
    },
  });
}

test('empty workspace passes structure and is blocked by strict readiness', async () => {
  const root = await temporaryRepository();
  const structure = runScript('.psp/harness/scripts/validate-product.mjs', root, ['--json']);
  assert.equal(structure.exitCode, 0, JSON.stringify(structure.output, null, 2));
  assert.equal(structure.output.status, 'PASS');
  assert.equal(structure.output.state, 'uninitialized');
  assert.ok(structure.output.warnings.some((item) => item.code === 'AIH_STAGE_UNINITIALIZED'));
  const outputCheck = runScript('.psp/harness/scripts/render-artifacts.mjs', root, ['--check', '--json']);
  assert.equal(outputCheck.exitCode, 0);
  assert.equal(outputCheck.output.state, 'uninitialized');
  assert.deepEqual(outputCheck.output.outputs, []);
  const render = runScript('.psp/harness/scripts/render-artifacts.mjs', root, ['--json']);
  assert.ok(codes(render).has('AIH_STAGE_UNINITIALIZED'));
  const area = runAreaCommand(root, 'typecheck');
  assert.notEqual(area.status, 0);
  assert.match(area.stderr, /AIH_STAGE_UNINITIALIZED/);
  const strict = runScript('.psp/harness/scripts/validate-product.mjs', root, ['--strict', '--json']);
  assert.notEqual(strict.exitCode, 0);
  assert.ok(codes(strict).has('AIH_STAGE_UNINITIALIZED'));
});

test('dry-run is non-mutating and initialization materializes the complete bound Package', async () => {
  const root = await temporaryRepository();
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const stagePath = resolve(root, stage.root);
  assert.equal(await pathExists(stagePath), false);

  const dryRun = runScript('.psp/harness/scripts/init-product.mjs', root, ['--dry-run', '--json']);
  assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun.output, null, 2));
  assert.equal(dryRun.output.mode, 'dry-run');
  assert.ok(dryRun.output.targets.includes(stage.root + '/' + stage.artifacts['product-package'].internalModel));
  assert.equal(await pathExists(stagePath), false);

  const initialized = runScript('.psp/harness/scripts/init-product.mjs', root, ['--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const activeProject = await fixtureProject(root);
  assert.equal(activeProject.stages['product-design'].status, 'active');
  for (const binding of Object.values(activeProject.stages['product-design'].artifacts)) {
    assert.match(binding.internalModel, /^\.psp\/models\/.+\.(yaml|json)$/);
    assert.equal(await pathExists(resolve(root, stage.root, binding.internalModel)), true, binding.internalModel);
    for (const output of binding.outputs) {
      assert.equal(await pathExists(resolve(root, stage.root, output.path)), true, output.path);
      if (output.role === 'user-artifact') {
        assert.match(output.path, /\.md$/);
        const content = await readFile(resolve(root, stage.root, output.path), 'utf8');
        assert.match(content, /artifactRole: user-artifact/);
        assert.match(content, /internalModel: /);
      }
    }
  }
  assert.equal(runScript('.psp/harness/scripts/validate-product.mjs', root, ['--json']).exitCode, 0);
  await symlink(resolve(repositoryRoot, 'node_modules'), resolve(root, 'node_modules'), 'junction');
  assert.equal(runAreaCommand(root, 'typecheck').status, 0);
  assert.equal(runAreaCommand(root, 'build').status, 0);

  const repeated = runScript('.psp/harness/scripts/init-product.mjs', root, ['--json']);
  assert.ok(codes(repeated).has('AIH_STAGE_ALREADY_INITIALIZED'));
});

test('initialization works with alternate bindings and never hardcodes the user root', async () => {
  const root = await temporaryRepository();
  const projectPath = resolve(root, 'psp.project.yaml');
  const project = await fixtureProject(root);
  const alternateRoot = ['workspace', 'product'].join('/');
  project.stages['product-design'].root = alternateRoot;
  await writeFile(projectPath, stringifyYaml(project));
  const initialized = runScript('.psp/harness/scripts/init-product.mjs', root, ['--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  assert.equal(await pathExists(resolve(root, alternateRoot, project.stages['product-design'].artifacts['product-package'].internalModel)), true);
});

test('collision and failed validation preserve the uninitialized state', async () => {
  const collisionRoot = await temporaryRepository();
  const collisionProject = await fixtureProject(collisionRoot);
  const collisionStage = collisionProject.stages['product-design'];
  const collisionFile = resolve(collisionRoot, collisionStage.root, collisionStage.artifacts.capabilities.internalModel);
  await mkdir(resolve(collisionFile, '..'), { recursive: true });
  await writeFile(collisionFile, 'user-owned\n');
  const collision = runScript('.psp/harness/scripts/init-product.mjs', collisionRoot, ['--json']);
  assert.ok(codes(collision).has('AIH_USER_CHANGE_COLLISION'));
  assert.equal(await readFile(collisionFile, 'utf8'), 'user-owned\n');
  const partial = runScript('.psp/harness/scripts/validate-product.mjs', collisionRoot, ['--json']);
  assert.ok(codes(partial).has('AIH_PARTIAL_INITIALIZATION'));

  const rollbackRoot = await temporaryRepository();
  const invalidTemplate = resolve(rollbackRoot, '.psp/harness/templates/capabilities.template.yaml');
  const invalid = parseYaml(await readFile(invalidTemplate, 'utf8'));
  invalid.kind = 'InvalidKind';
  await writeFile(invalidTemplate, stringifyYaml(invalid));
  const rollback = runScript('.psp/harness/scripts/init-product.mjs', rollbackRoot, ['--json']);
  assert.ok(codes(rollback).has('AIH_VALIDATION_FAILED'));
  const rollbackProject = await fixtureProject(rollbackRoot);
  assert.equal(rollbackProject.stages['product-design'].status, 'uninitialized');
  assert.equal(await pathExists(resolve(rollbackRoot, rollbackProject.stages['product-design'].root)), false);
});

test('complete structured fixture passes strict validation and deterministic rendering', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const strict = runScript('.psp/harness/scripts/validate-product.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
  const first = runScript('.psp/harness/scripts/render-artifacts.mjs', root, ['--json']);
  const second = runScript('.psp/harness/scripts/render-artifacts.mjs', root, ['--check', '--json']);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0, JSON.stringify(second.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  assert.equal(stage.artifacts.interactions.outputs[0].path, 'wireflow-mid.md');
  const ucProjection = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  const wireflowProjection = await readFile(resolve(root, stage.root, stage.artifacts.interactions.outputs[0].path), 'utf8');
  const htmlMockProjection = await readFile(resolve(root, stage.root, stage.artifacts['ui-spec'].outputs[0].path), 'utf8');
  assert.match(ucProjection, /主成功场景/);
  assert.match(ucProjection, /验收条件/);
  assert.match(wireflowProjection, /Screen Registry 与中保真结构/);
  assert.match(wireflowProjection, /UC-001-EXC-01/);
  assert.match(htmlMockProjection, /HTML Mock Specification/);
  assert.match(htmlMockProjection, /设计来源/);
  assert.match(htmlMockProjection, /设计资源本地化映射/);
  assert.match(htmlMockProjection, /Screen → DOM 映射/);
});

test('validator enforces design provenance and localized asset bindings', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const ui = await readArtifact(root, stage, stage.artifacts['ui-spec']);
  ui.data.visualRules[0].sourceRefs = ['DESIGN-SOURCE-999'];
  ui.data.assetBindings[0].localPath = 'HTML-Mock/public/missing-asset.svg';
  ui.data.designSources[0].status = 'partial';
  await writeArtifact(ui);
  runScript('.psp/harness/scripts/render-artifacts.mjs', root, ['--json']);
  const result = runScript('.psp/harness/scripts/validate-product.mjs', root, ['--strict', '--json']);
  const resultCodes = codes(result);
  assert.ok(resultCodes.has('AIH_REFERENCE_UNRESOLVED'), JSON.stringify(result.output, null, 2));
  assert.ok(resultCodes.has('AIH_ARTIFACT_INCOMPLETE'), JSON.stringify(result.output, null, 2));
});

test('HTML Mock input gate requires ready upstream and reproducible source evidence', async () => {
  const readyRoot = await temporaryRepository();
  await completeProductFixture(readyRoot);
  const ready = runScript('.psp/harness/scripts/validate-html-mock-input.mjs', readyRoot, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));
  assert.equal(ready.output.status, 'PASS');

  const upstreamRoot = await temporaryRepository();
  await completeProductFixture(upstreamRoot);
  const upstreamProject = await fixtureProject(upstreamRoot);
  const upstreamStage = upstreamProject.stages['product-design'];
  const upstream = await readArtifact(upstreamRoot, upstreamStage, upstreamStage.artifacts.interactions);
  upstream.data.metadata.status = 'draft';
  await writeArtifact(upstream);
  const upstreamResult = runScript('.psp/harness/scripts/validate-html-mock-input.mjs', upstreamRoot, ['--json']);
  assert.ok(codes(upstreamResult).has('AIH_UPSTREAM_NOT_READY'), JSON.stringify(upstreamResult.output, null, 2));

  const evidenceRoot = await temporaryRepository();
  await completeProductFixture(evidenceRoot);
  const evidenceProject = await fixtureProject(evidenceRoot);
  const evidenceStage = evidenceProject.stages['product-design'];
  const ui = await readArtifact(evidenceRoot, evidenceStage, evidenceStage.artifacts['ui-spec']);
  await writeFile(resolve(evidenceRoot, evidenceStage.root, ui.data.designSources[0].evidence.path), 'tampered evidence\n');
  const evidenceResult = runScript('.psp/harness/scripts/validate-html-mock-input.mjs', evidenceRoot, ['--json']);
  assert.ok(codes(evidenceResult).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(evidenceResult.output, null, 2));
});

test('browser gate executes scenarios at required viewports and rejects missing runtime state markers', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  await symlink(resolve(repositoryRoot, 'node_modules'), resolve(root, 'node_modules'), 'junction');
  const build = runAreaCommand(root, 'build');
  assert.equal(build.status, 0, build.stderr);

  const runtime = runScript('.psp/harness/scripts/validate-html-mock-runtime.mjs', root, ['--json']);
  assert.equal(runtime.exitCode, 0, JSON.stringify(runtime.output, null, 2));
  assert.equal(runtime.output.scenarioRuns, 4);
  assert.equal(runtime.output.screenshotCount, 6);
  for (const item of runtime.output.evidence) assert.equal(await pathExists(item.path), true, item.path);
  if (runtime.output.evidenceRoot) await rm(runtime.output.evidenceRoot, { recursive: true, force: true });

  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const entry = resolve(root, stage.root, stage.areas['html-mock'].root, 'src/psp-app.ts');
  await writeFile(entry, (await readFile(entry, 'utf8')).replaceAll('data-state-id', 'data-broken-state-id'));
  const brokenBuild = runAreaCommand(root, 'build');
  assert.equal(brokenBuild.status, 0, brokenBuild.stderr);
  const broken = runScript('.psp/harness/scripts/validate-html-mock-runtime.mjs', root, ['--json']);
  assert.ok(codes(broken).has('AIH_HTML_MOCK_RUNTIME_FAILED'), JSON.stringify(broken.output, null, 2));
  if (broken.output.evidenceRoot) await rm(broken.output.evidenceRoot, { recursive: true, force: true });
});

test('validator rejects schema errors, duplicate IDs and orphan references', async () => {
  const schemaRoot = await temporaryRepository();
  const schemaInitialization = runScript('.psp/harness/scripts/init-product.mjs', schemaRoot, ['--json']);
  assert.equal(schemaInitialization.exitCode, 0, JSON.stringify(schemaInitialization.output, null, 2));
  const schemaProject = await fixtureProject(schemaRoot);
  const schemaStage = schemaProject.stages['product-design'];
  const schemaArtifact = await readArtifact(schemaRoot, schemaStage, schemaStage.artifacts.capabilities);
  schemaArtifact.data.kind = 'WrongKind';
  await writeArtifact(schemaArtifact);
  assert.ok(codes(runScript('.psp/harness/scripts/validate-product.mjs', schemaRoot, ['--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const duplicateRoot = await temporaryRepository();
  await completeProductFixture(duplicateRoot);
  const duplicateProject = await fixtureProject(duplicateRoot);
  const duplicateStage = duplicateProject.stages['product-design'];
  const duplicateArtifact = await readArtifact(duplicateRoot, duplicateStage, duplicateStage.artifacts.capabilities);
  duplicateArtifact.data.actors.push({ ...duplicateArtifact.data.actors[0], name: '重复 Actor' });
  await writeArtifact(duplicateArtifact);
  runScript('.psp/harness/scripts/render-artifacts.mjs', duplicateRoot, ['--json']);
  assert.ok(codes(runScript('.psp/harness/scripts/validate-product.mjs', duplicateRoot, ['--strict', '--json'])).has('AIH_REFERENCE_UNRESOLVED'));

  const orphanRoot = await temporaryRepository();
  await completeProductFixture(orphanRoot);
  const orphanProject = await fixtureProject(orphanRoot);
  const orphanStage = orphanProject.stages['product-design'];
  const orphanArtifact = await readArtifact(orphanRoot, orphanStage, orphanStage.artifacts['ui-spec']);
  orphanArtifact.data.interactionScenarios[0].wireflow = 'WF-999';
  await writeArtifact(orphanArtifact);
  runScript('.psp/harness/scripts/render-artifacts.mjs', orphanRoot, ['--json']);
  assert.ok(codes(runScript('.psp/harness/scripts/validate-product.mjs', orphanRoot, ['--strict', '--json'])).has('AIH_REFERENCE_UNRESOLVED'));
});

test('strict validator requires UC branch coverage and HTML Mock code trace markers', async () => {
  const coverageRoot = await temporaryRepository();
  await completeProductFixture(coverageRoot);
  const coverageProject = await fixtureProject(coverageRoot);
  const coverageStage = coverageProject.stages['product-design'];
  const interactions = await readArtifact(coverageRoot, coverageStage, coverageStage.artifacts.interactions);
  const ui = await readArtifact(coverageRoot, coverageStage, coverageStage.artifacts['ui-spec']);
  interactions.data.wireflows[0].coveredScenarios = ['main'];
  interactions.data.wireflows[0].steps = interactions.data.wireflows[0].steps.filter((step) => step.scenario === 'main');
  interactions.data.wireflows[0].completionStates = ['WF-STATE-002'];
  ui.data.interactionScenarios = ui.data.interactionScenarios.filter((scenario) => scenario.ucScenario === 'main');
  ui.data.mockBehaviors = [];
  await Promise.all([writeArtifact(interactions), writeArtifact(ui)]);
  runScript('.psp/harness/scripts/render-artifacts.mjs', coverageRoot, ['--json']);
  const coverage = runScript('.psp/harness/scripts/validate-product.mjs', coverageRoot, ['--strict', '--json']);
  assert.ok(codes(coverage).has('AIH_REFERENCE_UNRESOLVED'), JSON.stringify(coverage.output, null, 2));

  const markerRoot = await temporaryRepository();
  await completeProductFixture(markerRoot);
  const markerProject = await fixtureProject(markerRoot);
  const markerStage = markerProject.stages['product-design'];
  const markerEntry = resolve(markerRoot, markerStage.root, markerStage.areas['html-mock'].root, 'src/psp-app.ts');
  const markerSource = await readFile(markerEntry, 'utf8');
  await writeFile(markerEntry, markerSource.replaceAll('HTML-MOCK-001', 'REMOVED-MOCK').replaceAll('SCREEN-001', 'REMOVED-SCREEN'));
  const marker = runScript('.psp/harness/scripts/validate-product.mjs', markerRoot, ['--strict', '--json']);
  assert.ok(codes(marker).has('AIH_ARTIFACT_INCOMPLETE'), JSON.stringify(marker.output, null, 2));
});

test('validator reports generated output drift', async () => {
  const root = await temporaryRepository();
  const initialization = runScript('.psp/harness/scripts/init-product.mjs', root, ['--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const userArtifact = resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path);
  await writeFile(userArtifact, (await readFile(userArtifact, 'utf8')) + '\nmanual edit\n');
  const result = runScript('.psp/harness/scripts/validate-product.mjs', root, ['--json']);
  assert.ok(codes(result).has('AIH_GENERATED_DRIFT'));
});
