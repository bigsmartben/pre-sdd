import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { templateRoot } from './helpers/workspace.mjs';

async function files(root) {
  const output = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) output.push(...await files(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

test('end-to-end matrix covers L1, optional L2, repair, stale, legacy rejection, and production isolation', async () => {
  const matrix = JSON.parse(await readFile(resolve(import.meta.dirname, '..', 'conformance', 'matrix.json'), 'utf8'));
  assert.deepEqual(matrix.positive.map((item) => item.id), ['L1-VISUAL', 'L2-USER-PATH', 'MIXED-L1-L2', 'FINDING-REPAIR']);
  const codes = new Set(matrix.negative.map((item) => item.code));
  for (const code of [
    'LEGACY_VISUAL_WORKFLOW_FORBIDDEN',
    'VISUAL_SPEC_SOURCE_REVISION_REUSED',
    'FGC_PROPERTY_MISSING',
    'UPC_L1_REQUIRED',
    'RVW_CLOSE_FORBIDDEN',
    'VSD_PRODUCTION_DEPENDENCY_FORBIDDEN',
  ]) assert.equal(codes.has(code), true, code);
  assert.equal(codes.size, matrix.negative.length);
});

test('atomic cutover physically removes old positive routes', async () => {
  const all = await files(templateRoot);
  for (const relative of [
    '.agents/skills/lit-ui-workflow/',
    '.agents/skills/use-case-generation/',
    '.agents/skills/repair-lit-ui/',
    '.agents/skills/product-design/visual-spec/',
    '.agents/skills/lit-ui/templates/Mapping.html',
    '.agents/skills/figma-workflow/acquisition-packet.schema.json',
  ]) {
    const absolute = resolve(templateRoot, relative);
    assert.equal(all.some((path) => path === absolute || path.startsWith(absolute)), false, relative);
  }
});
