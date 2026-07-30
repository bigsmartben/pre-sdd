import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateCases } from '../scripts/validate.mjs';

const roots = [];
const skillRoot = resolve(import.meta.dirname, '..');

test.after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

function fixture() {
  return {
    schemaVersion: 'psp.dev/ui-cases/v1',
    businessCases: [{
      caseId: 'BUSINESS-CASE-SUBMIT',
      name: '提交订单',
      sourceRefs: ['uc:UC-1', 'mapping:PAGE-CHECKOUT', 'framework:Route'],
      steps: [
        { kind: 'route', conceptId: 'ROUTE-CHECKOUT', sourceRef: 'mapping:PAGE-CHECKOUT' },
        { kind: 'event', conceptId: 'EVENT-SUBMIT', sourceRef: 'uc:UC-1' },
        { kind: 'port', conceptId: 'PORT-SUBMIT', sourceRef: 'uc:UC-1' },
      ],
    }],
    componentCases: [{
      caseId: 'COMPONENT-CASE-SUBMIT-BUSY',
      name: '提交按钮忙碌态',
      componentConceptId: 'COMPONENT-SUBMIT',
      sourceRefs: ['uc:UC-1', 'mapping:COMPONENT-SUBMIT', 'framework:Component'],
      checks: [
        { kind: 'component-state', value: 'busy', sourceRef: 'mapping:COMPONENT-SUBMIT' },
        { kind: 'event', value: 'submit-requested', sourceRef: 'uc:UC-1' },
      ],
    }],
    gaps: [],
  };
}

test('Business and Component Cases are layered, traceable neutral validation data', () => {
  assert.deepEqual(validateCases(fixture()), []);

  const collision = fixture();
  collision.businessCases[0].steps.push({ kind: 'property', conceptId: 'X', sourceRef: 'uc:UC-1' });
  assert.ok(validateCases(collision).some((item) => item.code === 'UI_CASE_LAYER_COLLISION'));

  const missing = fixture();
  missing.componentCases[0].sourceRefs = ['mapping:COMPONENT-SUBMIT'];
  assert.ok(validateCases(missing).some((item) => item.code === 'UI_CASE_TRACEABILITY_MISSING'));

  const invented = fixture();
  invented.businessCases[0].steps[0].sourceRef = 'uc:UNKNOWN';
  assert.ok(validateCases(invented).some((item) => item.code === 'UI_CASE_INVENTS_BUSINESS_FACT'));

  const runtime = fixture();
  runtime.componentCases[0].checks[0].domSelector = '#submit';
  assert.ok(validateCases(runtime).some((item) => item.code === 'UI_CASE_RUNTIME_DEP'));
});

test('generator writes only validated case data in an OS temporary workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ui-cases-'));
  roots.push(root);
  await writeFile(resolve(root, 'input.json'), JSON.stringify(fixture()));
  const script = resolve(skillRoot, 'scripts', 'generate.mjs');
  const result = spawnSync(process.execPath, [script, '--input', 'input.json', '--output', 'Cases/ui-cases.json'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, 'Cases/ui-cases.json'), 'utf8')), fixture());
});
