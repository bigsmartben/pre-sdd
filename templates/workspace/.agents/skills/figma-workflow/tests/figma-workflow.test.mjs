import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
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

function capture(itemId = 'VSI-FDBI-001-PAGE-01') {
  return {
    source: {
      provider: 'figma',
      fileId: 'fixture-file',
      locator: 'figma://fixture-file',
      scope: { kind: 'file', refs: ['fixture-file'] },
      revision: '42',
      digest: `sha256:${'a'.repeat(64)}`,
      capturedAt: '2026-07-30T00:00:00.000Z',
    },
    items: [{
      itemId,
      status: 'covered',
      anchors: [{
        nodeId: '12:34',
        nodeDigest: `sha256:${'b'.repeat(64)}`,
        role: 'page',
        viewport: 'mobile',
        state: 'default',
        variant: null,
        contentCase: 'normal',
        properties: ['geometry', 'layout', 'appearance', 'typography', 'viewport', 'state'],
      }],
    }],
    assets: [],
    tokens: [],
    motions: [],
  };
}

test('Figma binds every Checklist item without modifying scope and reports source drift', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const capturePath = resolve(fixture.parent, 'capture.json');
  await writeJson(capturePath, capture());
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/bind.mjs', ['--capture', capturePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const coverage = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/figma-coverage.json'), 'utf8'));
  const evidence = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/figma-evidence.json'), 'utf8'));
  assert.equal(coverage.items[0].status, 'covered');
  assert.equal(coverage.items[0].anchors[0].nodeId, '12:34');
  assert.equal(evidence.source.fileId, coverage.source.fileId);

  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/validate.mjs');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/validate.mjs', [
    '--source-revision', '43',
    '--source-digest', `sha256:${'a'.repeat(64)}`,
  ]);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).status, 'STALE');

  const checklistPath = resolve(fixture.workspace, '.psp/visual-spec/checklist.json');
  const checklist = JSON.parse(await readFile(checklistPath, 'utf8'));
  checklist.metadata.revision += 1;
  await writeFile(checklistPath, JSON.stringify(checklist, null, 2) + '\n');
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/validate.mjs');
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).status, 'STALE');
  assert.deepEqual(jsonResult(result).staleItems, ['VSI-FDBI-001-PAGE-01']);
});

test('Figma extra items and old packet fields are rejected', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const extraPath = resolve(fixture.parent, 'extra.json');
  await writeJson(extraPath, capture('VSI-FDBI-999-PAGE-01'));
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/bind.mjs', ['--capture', extraPath]);
  assert.notEqual(result.status, 0);
  assert.ok(jsonResult(result).blockers.some((item) => item.code === 'FGC_SCOPE_EXPANSION_FORBIDDEN'));

  const oldPath = resolve(fixture.parent, 'old-packet.json');
  await writeJson(oldPath, { packet: { consumerTargets: ['PAGE-001'] } });
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/bind.mjs', ['--capture', oldPath]);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN');
});

test('Plant Badge variant property that cannot be read becomes a structured Gap', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  const baselinePath = resolve(fixture.workspace, '01-product-design/.psp/models/functional-delivery-baseline.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  baseline.items[0].visualRequirements[0].kind = 'VARIANT';
  baseline.items[0].visualRequirements[0].name = 'Plant Badge';
  baseline.items[0].visualRequirements[0].variants = ['Status=Success'];
  baseline.metadata.revision += 1;
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const value = capture('VSI-FDBI-001-VARIANT-01');
  value.items[0].anchors[0].role = 'variant';
  value.items[0].anchors[0].variant = null;
  value.items[0].anchors[0].properties = value.items[0].anchors[0].properties.filter((item) => item !== 'variant');
  const capturePath = resolve(fixture.parent, 'plant-badge.json');
  await writeJson(capturePath, value);
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/bind.mjs', ['--capture', capturePath]);
  assert.notEqual(result.status, 0);
  const coverage = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/figma-coverage.json'), 'utf8'));
  assert.equal(coverage.items[0].status, 'missing');
  assert.equal(coverage.gaps[0].code, 'FGC_PROPERTY_MISSING');
  assert.match(coverage.gaps[0].reason, /variant:Status=Success/);
});

test('Figma validator rejects unresolved evidence item refs and duplicate evidence IDs', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const capturePath = resolve(fixture.parent, 'capture.json');
  await writeJson(capturePath, capture());
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/bind.mjs', ['--capture', capturePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const evidencePath = resolve(fixture.workspace, '.psp/visual-spec/figma-evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  const token = {
    tokenId: 'TOKEN-BRAND',
    kind: 'paint',
    value: '#00aa00',
    sourceNodeId: '12:99',
    digest: `sha256:${'c'.repeat(64)}`,
    itemRefs: ['VSI-FDBI-999-PAGE-01'],
  };
  evidence.tokens = [token, { ...token }];
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/validate.mjs');
  assert.notEqual(result.status, 0);
  const codes = jsonResult(result).blockers.map((item) => item.code);
  assert.ok(codes.includes('FGC_SCOPE_EXPANSION_FORBIDDEN'));
  assert.ok(codes.includes('FGC_EVIDENCE_DUPLICATED'));
  assert.ok(codes.includes('FGC_TOKEN_DIGEST_INVALID'));
});
