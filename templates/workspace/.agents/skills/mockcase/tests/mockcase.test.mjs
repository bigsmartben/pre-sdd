import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  fixtureWorkspace,
  jsonResult,
  run,
} from '../../visual-spec/tests/helpers/workspace.mjs';

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test('MockCase fills only Path Plan scenario slots and has no human-review lifecycle', async () => {
  const fixture = await fixtureWorkspace({ deliveryLevel: 'USER_PATH' });
  roots.push(fixture.parent);
  for (const script of [
    '.agents/skills/visual-spec/scripts/generate.mjs',
    '.agents/skills/user-path-cases/scripts/generate.mjs',
  ]) {
    const result = run(fixture.workspace, script, ['--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  let result = run(fixture.workspace, '.agents/skills/mockcase/scripts/workflow.mjs', ['--operation', 'prepare']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const suitePath = resolve(fixture.workspace, 'MockCase/suite.json');
  const suite = JSON.parse(await readFile(suitePath, 'utf8'));
  assert.equal(suite.scenarios[0].scenarioId, 'case-tc-001');
  assert.equal(suite.metadata.status, 'draft');
  suite.scenarios[0].status = 'ready';
  suite.scenarios[0].fixtures = [{
    fixtureId: 'FIXTURE-TC-001-SUCCESS',
    port: 'checkout',
    request: { submit: true },
    response: { ok: true },
  }];
  suite.gaps = [];
  suite.metadata.status = 'ready';
  suite.metadata.revision += 1;
  await writeFile(suitePath, JSON.stringify(suite, null, 2) + '\n');
  result = run(fixture.workspace, '.agents/skills/mockcase/scripts/workflow.mjs', ['--operation', 'validate']);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  result = run(fixture.workspace, '.agents/skills/mockcase/scripts/workflow.mjs', ['--operation', 'review']);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'MOCK_OPERATION_FORBIDDEN');
});
