import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fixtureWorkspace, jsonResult, run, writeJson } from '../../visual-spec/tests/helpers/workspace.mjs';

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

test('private Intake is not a Registry artifact or public package command', async () => {
  const workspace = resolve(import.meta.dirname, '..', '..', '..', '..');
  const project = await readFile(resolve(workspace, 'psp.project.yaml'), 'utf8');
  const packageJson = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8'));
  assert.doesNotMatch(project, /figma-intake|capture/i);
  assert.equal(Object.hasOwn(packageJson.scripts, 'bind:figma-evidence'), false);
  assert.equal(Object.values(packageJson.scripts).some((command) => /finalize\.mjs|--intake|--capture/.test(command)), false);
});

function intake(itemId = 'VSI-FDBI-001-PAGE-01') {
  return {
    schemaVersion: 'psp.dev/figma-intake/v1',
    source: {
      provider: 'figma',
      fileId: 'fixture-file',
      locator: 'figma://fixture-file',
      scope: { kind: 'file', refs: ['fixture-file'] },
      revision: '42',
      capturedAt: '2026-07-30T00:00:00.000Z',
      payload: { document: { id: 'fixture-file', revision: '42', children: ['12:34'] } },
      nodes: [{ nodeId: '12:34', pageId: '1:1', payload: { id: '12:34', type: 'FRAME', name: 'Checkout' } }],
    },
    items: [{
      itemId,
      status: 'covered',
      anchors: [{
        nodeId: '12:34', role: 'page', viewport: 'mobile', state: 'default', variant: null,
        contentCase: 'normal', properties: ['geometry', 'layout', 'appearance', 'typography', 'viewport', 'state'],
      }],
    }],
    assets: [], tokens: [], motions: [],
  };
}

async function readyFixture() {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  const result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return fixture;
}

test('private Intake derives source/node digests and freshness is mandatory', async () => {
  const fixture = await readyFixture();
  const intakePath = resolve(fixture.parent, 'intake.json');
  await writeJson(intakePath, intake());
  let result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--intake', intakePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const coverage = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/figma-coverage.json'), 'utf8'));
  assert.match(coverage.source.digest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(coverage.source.digest, `sha256:${'a'.repeat(64)}`);
  assert.match(coverage.items[0].anchors[0].nodeDigest, /^sha256:[a-f0-9]{64}$/);

  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/validate.mjs');
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'FGC_FRESHNESS_REQUIRED');
  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/validate.mjs', ['--figma-freshness', intakePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const drift = structuredClone(intake());
  drift.source.revision = '43';
  drift.source.payload.document.revision = '43';
  const driftPath = resolve(fixture.parent, 'freshness-drift.json');
  await writeJson(driftPath, drift);
  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/validate.mjs', ['--figma-freshness', driftPath]);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).status, 'STALE');
});

test('legacy capture, self-declared digest, extra scope, and role mismatch are rejected', async () => {
  const fixture = await readyFixture();
  let result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--capture', resolve(fixture.parent, 'capture.json')]);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN');

  const declared = intake();
  declared.source.digest = `sha256:${'a'.repeat(64)}`;
  const declaredPath = resolve(fixture.parent, 'declared.json');
  await writeJson(declaredPath, declared);
  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--intake', declaredPath]);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'FGC_INTAKE_INVALID');

  const extra = intake('VSI-FDBI-999-PAGE-01');
  const extraPath = resolve(fixture.parent, 'extra.json');
  await writeJson(extraPath, extra);
  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--intake', extraPath]);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'FGC_SCOPE_EXPANSION_FORBIDDEN');

  const wrongRole = intake();
  wrongRole.items[0].anchors[0].role = 'component';
  const wrongRolePath = resolve(fixture.parent, 'wrong-role.json');
  await writeJson(wrongRolePath, wrongRole);
  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--intake', wrongRolePath]);
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'FGC_ROLE_MISMATCH');
});

test('Asset is exported from temp bytes and committed with Coverage/Evidence', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  const baselinePath = resolve(fixture.workspace, '01-product-design/.psp/models/functional-delivery-baseline.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  baseline.items[0].visualRequirements[0].assets = ['ASSET-BADGE'];
  baseline.metadata.revision += 1;
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const svgPath = resolve(fixture.parent, 'badge.svg');
  await writeFile(svgPath, '<svg width="10" height="20" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v20H0z"/></svg>');
  const value = intake();
  value.items[0].anchors[0].properties.push('asset');
  value.assets.push({ assetId: 'ASSET-BADGE', nodeId: '12:34', sourcePath: svgPath, path: 'assets/badge.svg', format: 'svg', itemRefs: ['VSI-FDBI-001-PAGE-01'] });
  const intakePath = resolve(fixture.parent, 'asset-intake.json');
  await writeJson(intakePath, value);
  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--intake', intakePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await readFile(resolve(fixture.workspace, 'assets/badge.svg'), 'utf8'), await readFile(svgPath, 'utf8'));
  const evidence = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/figma-evidence.json'), 'utf8'));
  assert.equal(evidence.assets[0].width, 10);
  assert.equal(evidence.assets[0].height, 20);
  assert.match(evidence.assets[0].digest, /^sha256:[a-f0-9]{64}$/);
});

test('Ready Authorization fails closed without current Figma Intake', async () => {
  const fixture = await readyFixture();
  const intakePath = resolve(fixture.parent, 'intake.json');
  await writeJson(intakePath, intake());
  let result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--intake', intakePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/authorize.mjs');
  assert.notEqual(result.status, 0);
  result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/authorize.mjs', ['--figma-freshness', intakePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
