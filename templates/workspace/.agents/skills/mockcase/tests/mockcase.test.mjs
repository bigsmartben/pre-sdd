import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const skillRoot = resolve(import.meta.dirname, '..');
const workspaceTemplate = resolve(skillRoot, '..', '..', '..');
const repositoryRoot = resolve(skillRoot, '..', '..', '..', '..', '..');
const nodeModules = resolve(repositoryRoot, 'node_modules');
const roots = [];

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace() {
  const parent = await mkdtemp(join(tmpdir(), 'mockcase-v2-'));
  roots.push(parent);
  const root = resolve(parent, 'workspace');
  const { cp } = await import('node:fs/promises');
  await cp(workspaceTemplate, root, { recursive: true });
  await symlink(nodeModules, resolve(root, 'node_modules'), 'junction');
  await mkdir(resolve(root, 'Cases'), { recursive: true });
  await writeFile(resolve(root, 'Cases/ui-cases.json'), JSON.stringify({
    schemaVersion: 'psp.dev/ui-cases/v1',
    businessCases: [{
      caseId: 'BUSINESS-CASE-SUBMIT',
      name: '提交',
      sourceRefs: ['uc:UC-1', 'mapping:PAGE-1', 'framework:Route'],
      steps: [{ kind: 'port', conceptId: 'PORT-SUBMIT', sourceRef: 'uc:UC-1' }],
    }],
    componentCases: [{
      caseId: 'COMPONENT-CASE-BUTTON',
      name: '按钮',
      componentConceptId: 'COMPONENT-BUTTON',
      sourceRefs: ['uc:UC-1', 'mapping:COMPONENT-BUTTON', 'framework:Component'],
      checks: [{ kind: 'event', sourceRef: 'uc:UC-1' }],
    }],
    gaps: [],
  }));
  return root;
}

function run(root, args) {
  const script = resolve(root, '.agents/skills/mockcase/scripts/workflow.mjs');
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', windowsHide: true });
  return { ...result, output: JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)) };
}

test('MockCase locks neutral UI Cases and requires exact apply/review authorization', async () => {
  const root = await workspace();
  const initialized = run(root, ['--operation', 'initialize']);
  assert.equal(initialized.output.status, 'PASS', initialized.stderr);
  const suite = JSON.parse(await readFile(resolve(root, 'MockCase/suite.json'), 'utf8'));
  suite.fixtures.push({ fixtureId: 'FIXTURE-FAIL', portId: 'PORT-SUBMIT', input: {}, result: { ok: false } });
  suite.scenarios.push({ mockCaseId: 'MOCK-FAIL', businessCaseId: 'BUSINESS-CASE-SUBMIT', fixtureIds: ['FIXTURE-FAIL'] });
  await writeFile(resolve(root, 'candidate.json'), JSON.stringify(suite));

  const denied = run(root, ['--operation', 'apply', '--candidate', 'candidate.json']);
  assert.ok(denied.output.blockers.some((item) => item.code === 'MOCKCASE_APPLY_NOT_AUTHORIZED'));
  const applied = run(root, [
    '--operation', 'apply', '--candidate', 'candidate.json', '--confirm', 'APPLY_MOCKCASE_CANDIDATE',
  ]);
  assert.equal(applied.output.status, 'PASS', applied.stderr);

  const reviewDenied = run(root, ['--operation', 'review', '--reviewed-by', 'agent:test']);
  assert.ok(reviewDenied.output.blockers.some((item) => item.code === 'MOCKCASE_REVIEW_NOT_AUTHORIZED'));
  const reviewed = run(root, ['--operation', 'review', '--reviewed-by', 'user:test']);
  assert.equal(reviewed.output.status, 'PASS', reviewed.stderr);
});

test('MockCase refuses DOM/state runtime instructions and stale case locks', async () => {
  const root = await workspace();
  run(root, ['--operation', 'initialize']);
  const suite = JSON.parse(await readFile(resolve(root, 'MockCase/suite.json'), 'utf8'));
  suite.domSelector = '#product';
  await writeFile(resolve(root, 'candidate.json'), JSON.stringify(suite));
  const coupled = run(root, ['--operation', 'verify', '--candidate', 'candidate.json']);
  assert.ok(coupled.output.blockers.some((item) => item.code === 'MOCKCASE_PRODUCT_COUPLED'));

  delete suite.domSelector;
  suite.inputLock.uiCasesDigest = `sha256:${'0'.repeat(64)}`;
  await writeFile(resolve(root, 'candidate.json'), JSON.stringify(suite));
  const stale = run(root, ['--operation', 'verify', '--candidate', 'candidate.json']);
  assert.ok(stale.output.blockers.some((item) => item.code === 'MOCKCASE_INPUT_STALE'));
});
