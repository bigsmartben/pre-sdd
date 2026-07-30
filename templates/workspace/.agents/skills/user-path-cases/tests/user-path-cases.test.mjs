import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  fixtureWorkspace,
  jsonResult,
  run,
  writeJson,
} from '../../visual-spec/tests/helpers/workspace.mjs';

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test('USER_PATH compiles only from a ready Test Case Catalog and locks both sources', async () => {
  const fixture = await fixtureWorkspace({ deliveryLevel: 'USER_PATH' });
  roots.push(fixture.parent);
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/user-path-cases/scripts/generate.mjs');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(jsonResult(result).status, 'PASS');

  const plan = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/user-path-plan.json'), 'utf8'));
  assert.deepEqual(plan.sourceLocks.map((item) => item.artifactId), [
    'TEST-CASE-CATALOG',
    'VISUAL-SPEC-CHECKLIST',
  ]);
  assert.equal(plan.paths[0].pathId, 'UP-TC-001');
  assert.deepEqual(plan.paths[0].checklistItemRefs, ['VSI-FDBI-001-PAGE-01']);
  assert.equal(plan.paths[0].steps[0].testCaseStepRef, 'TC-001-STEP-01');
  assert.equal(plan.paths[0].scenarioSlots[0], 'case-tc-001');

  const valid = run(fixture.workspace, '.agents/skills/user-path-cases/scripts/validate.mjs');
  assert.equal(valid.status, 0, valid.stderr || valid.stdout);

  plan.paths = [];
  await writeJson(resolve(fixture.workspace, '.psp/visual-spec/user-path-plan.json'), plan);
  const missing = run(fixture.workspace, '.agents/skills/user-path-cases/scripts/validate.mjs');
  assert.notEqual(missing.status, 0);
  assert.ok(jsonResult(missing).blockers.some((item) => item.code === 'UPC_PATH_REF_INVALID'));
});

test('USER_PATH without a Test Case is blocked and VISUAL does not require L2', async () => {
  const fixture = await fixtureWorkspace({ deliveryLevel: 'USER_PATH' });
  roots.push(fixture.parent);
  const catalogPath = resolve(fixture.workspace, 'Cases/test-cases.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.testCases = [];
  await import('node:fs/promises').then(({ writeFile }) => writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n'));
  const blocked = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.notEqual(blocked.status, 0);
  assert.ok(jsonResult(blocked).blockers.some((item) => item.code === 'VISUAL_SPEC_TEST_CASE_REF_INVALID'));

  const visual = await fixtureWorkspace({ deliveryLevel: 'VISUAL' });
  roots.push(visual.parent);
  const pass = run(visual.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(pass.status, 0, pass.stderr || pass.stdout);
  const checklist = JSON.parse(await readFile(resolve(visual.workspace, '.psp/visual-spec/checklist.json'), 'utf8'));
  assert.equal(checklist.sourceLocks.some((item) => item.artifactId === 'TEST-CASE-CATALOG'), false);
});

test('Test Case UC, Scenario and Step identities must form one closed chain', async () => {
  const fixture = await fixtureWorkspace({ deliveryLevel: 'USER_PATH' });
  roots.push(fixture.parent);
  const catalogPath = resolve(fixture.workspace, 'Cases/test-cases.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.testCases[0].scenarioRef = 'UC-002-ALT-01';
  await writeJson(catalogPath, catalog);
  const result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.notEqual(result.status, 0);
  assert.ok(jsonResult(result).blockers.some((item) => item.code === 'VISUAL_SPEC_TEST_CASE_REF_INVALID'));

  catalog.testCases[0].scenarioRef = 'main';
  catalog.testCases.push(structuredClone(catalog.testCases[0]));
  await writeJson(catalogPath, catalog);
  const duplicated = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.notEqual(duplicated.status, 0);
  assert.ok(jsonResult(duplicated).blockers.some((item) => item.code === 'VSC_SCHEMA_INVALID'));
});
