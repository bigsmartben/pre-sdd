import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(import.meta.dirname, '..');

test('implementation request schema rejects inferred authority or unknown fields', async () => {
  const schema = JSON.parse(await readFile(resolve(root, 'schemas', 'implementation-request.schema.json'), 'utf8'));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const lock = (artifactId, path) => ({ artifactId, path, revision: 1, digest: `sha256:${'0'.repeat(64)}` });
  const request = { schemaVersion: 'psp.dev/flutter-ui/v1', operation: 'IMPLEMENT-FLUTTER-UI', authorityRoot: 'lib/ui', readyAuthorization: lock('VISUAL-SPEC-READY-AUTHORIZATION', '.psp/visual-spec/ready-authorization.json'), figmaCoverage: lock('FIGMA-COVERAGE', '.psp/visual-spec/figma-coverage.json'), figmaEvidence: lock('FIGMA-EVIDENCE', '.psp/visual-spec/figma-evidence.json'), userPathMode: 'not-required' };
  assert.equal(validate(request), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...request, authorityRoot: 'src/ui' }), false);
  assert.equal(validate({ ...request, inferredTarget: 'android' }), false);
});

test('Flutter skeleton shares lib/ui and isolates review/testing adapters', async () => {
  const template = resolve(root, 'templates', 'flutter-workspace');
  const main = await readFile(resolve(template, 'lib/main.dart'), 'utf8');
  const review = await readFile(resolve(template, 'lib/review/review_main.dart'), 'utf8');
  const app = await readFile(resolve(template, 'lib/ui/app/app.dart'), 'utf8');
  assert.match(main, /ui\/app\/app\.dart/);
  assert.match(review, /ui\/app\/app\.dart/);
  assert.doesNotMatch(main + app, /lib\/(review|testing)|MockCase|\.psp|figma/i);
});

test('implementation contract contains every required positive and negative case', async () => {
  const contract = await readFile(resolve(root, 'contracts', 'implementation.md'), 'utf8');
  for (const term of ['L1-only', 'USER_PATH', 'Missing/stale', 'Existing Flutter', 'Review/Test/Mock', 'Lit/UIHTML']) assert.match(contract, new RegExp(term.replaceAll('/', '\\/'), 'i'));
});
