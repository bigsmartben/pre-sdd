import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  fixtureWorkspace,
  jsonResult,
  run,
} from './helpers/workspace.mjs';

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test('Visual Spec schema is provider-neutral and rejects implementation fields', async () => {
  const schema = JSON.parse(await readFile(resolve(import.meta.dirname, '..', 'schemas', 'visual-spec.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(schema);
  const requirement = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    requirementId: 'VSR-CHECKOUT-PAGE',
    requirementRefs: ['UC-001'],
    target: { kind: 'PAGE', ref: 'UC-001', name: '结算页' },
    requiredDeliveryLevel: 'VISUAL',
    dimensions: {
      viewports: ['mobile'],
      states: ['default'],
      variants: [],
      contentCases: ['normal'],
      tokens: [],
      assets: [],
      motions: [],
    },
  };
  assert.equal(validate(requirement), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...requirement, nodeId: '12:34' }), false);
  assert.equal(validate({ ...requirement, litComponent: 'checkout-page' }), false);
  assert.equal(validate({ ...requirement, mockFixture: 'success' }), false);
});

test('Checklist compiler is deterministic, locks exact bytes, and rejects revision reuse and legacy input', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  const script = '.agents/skills/visual-spec/scripts/generate.mjs';
  const first = run(fixture.workspace, script, ['--json']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(jsonResult(first).status, 'PASS');
  const checklistPath = resolve(fixture.workspace, '.psp/visual-spec/checklist.json');
  const firstBytes = await readFile(checklistPath);
  const checklist = JSON.parse(firstBytes);
  assert.equal(checklist.metadata.artifactId, 'VISUAL-SPEC-CHECKLIST');
  assert.equal(checklist.items[0].itemId, 'VSI-FDBI-001-PAGE-01');
  assert.equal(checklist.items[0].requiredDeliveryLevel, 'VISUAL');
  assert.deepEqual(checklist.sourceLocks.map((item) => item.artifactId), [
    'PRODUCT-USE-CASES',
    'FUNCTIONAL-DELIVERY-BASELINE',
  ]);

  const second = run(fixture.workspace, script, ['--json']);
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.deepEqual(await readFile(checklistPath), firstBytes);

  const validate = run(fixture.workspace, '.agents/skills/visual-spec/scripts/validate.mjs', ['--json']);
  assert.equal(validate.status, 0, validate.stderr || validate.stdout);
  assert.equal(jsonResult(validate).checklistReady, true);

  const useCasesPath = resolve(fixture.workspace, '01-product-design/.psp/models/use-cases.yaml');
  const useCases = parseYaml(await readFile(useCasesPath, 'utf8'));
  await writeFile(useCasesPath, '\n' + stringifyYaml(useCases), 'utf8');
  const reused = run(fixture.workspace, script, ['--json']);
  assert.notEqual(reused.status, 0);
  assert.ok(jsonResult(reused).blockers.some((item) => item.code === 'VISUAL_SPEC_SOURCE_REVISION_REUSED'));

  const oldInput = resolve(fixture.parent, 'Mapping.html');
  await writeFile(oldInput, '<html></html>', 'utf8');
  const legacy = run(fixture.workspace, script, ['--input', oldInput, '--json']);
  assert.notEqual(legacy.status, 0);
  assert.equal(jsonResult(legacy).blockers[0].code, 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN');
});
