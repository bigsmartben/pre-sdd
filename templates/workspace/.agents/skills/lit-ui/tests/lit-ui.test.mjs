import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  digest,
  fixtureWorkspace,
  jsonResult,
  run,
  writeJson,
} from '../../visual-spec/tests/helpers/workspace.mjs';
import { hashDirectory } from '../scripts/hash-uihtml.mjs';

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

function capture() {
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
      itemId: 'VSI-FDBI-001-PAGE-01',
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

test('UIHTML manifest cannot be recorded outside a successful product build', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  const result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/record-uihtml.mjs');
  assert.notEqual(result.status, 0);
  assert.equal(jsonResult(result).blockers[0].code, 'VSD_UIHTML_BUILD_ORIGIN_INVALID');
});

test('L1 accepts every Checklist item only from current Ready and Figma locks', async () => {
  const fixture = await fixtureWorkspace();
  roots.push(fixture.parent);
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const capturePath = resolve(fixture.parent, 'capture.json');
  await writeJson(capturePath, capture());
  result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/bind.mjs', ['--capture', capturePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/authorize.mjs');
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const srcUi = resolve(fixture.workspace, 'src/ui');
  await mkdir(srcUi, { recursive: true });
  await writeFile(resolve(srcUi, 'main.ts'), 'export const source = \"fixture\";\n');
  await mkdir(resolve(fixture.workspace, 'src/adapters/real'), { recursive: true });
  await writeFile(resolve(fixture.workspace, 'src/adapters/real/index.ts'), 'export const real = true;\n');
  await writeFile(resolve(fixture.workspace, 'src/product-main.ts'), "import './ui/main.js';\nimport './adapters/real/index.js';\n");
  const sourceDigest = await hashDirectory(srcUi);
  const sources = [
    ['VISUAL-SPEC-READY-AUTHORIZATION', '.psp/visual-spec/ready-authorization.json'],
    ['FIGMA-COVERAGE', '.psp/visual-spec/figma-coverage.json'],
    ['FIGMA-EVIDENCE', '.psp/visual-spec/figma-evidence.json'],
  ];
  const sourceLocks = [];
  for (const [artifactId, path] of sources) {
    const bytes = await readFile(resolve(fixture.workspace, path));
    const data = JSON.parse(bytes);
    sourceLocks.push({
      artifactId,
      path,
      revision: data.metadata?.revision ?? data.revision,
      digest: digest(bytes),
    });
  }
  await writeJson(resolve(fixture.workspace, '.psp/visual-spec/lit-visual-coverage.json'), {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'LIT-VISUAL-COVERAGE', revision: 1, status: 'ready' },
    sourceLocks,
    litSource: { commit: 'abcdef1', srcUiDigest: sourceDigest },
    items: [{
      itemId: 'VSI-FDBI-001-PAGE-01',
      status: 'accepted',
      route: '/checkout',
      component: 'checkout-page',
      viewports: ['mobile'],
      states: ['default'],
      variants: [],
      contentCases: ['normal'],
      tokenRefs: [],
      assetRefs: [],
      motionRefs: [],
      scenarioIds: ['checkout-default-mobile'],
    }],
    gaps: [],
  });
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate.mjs', ['--phase', 'review']);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const productEntry = resolve(fixture.workspace, 'src/product-main.ts');
  await writeFile(productEntry, "import './ui/main.js';\nimport './adapters/real/index.js';\nimport 'msw';\n");
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate.mjs', ['--phase', 'review']);
  assert.notEqual(result.status, 0);
  assert.ok(jsonResult(result).blockers.some((item) => item.code === 'VSD_PRODUCTION_DEPENDENCY_FORBIDDEN'));
  await writeFile(productEntry, "import './ui/main.js';\nimport './adapters/real/index.js';\n");

  const l1Path = resolve(fixture.workspace, '.psp/visual-spec/lit-visual-coverage.json');
  const l1 = JSON.parse(await readFile(l1Path, 'utf8'));
  l1.items.push({ ...l1.items[0], itemId: 'VSI-FDBI-999-PAGE-01' });
  await writeFile(l1Path, JSON.stringify(l1, null, 2) + '\n');
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate.mjs', ['--phase', 'review']);
  assert.notEqual(result.status, 0);
  assert.ok(jsonResult(result).blockers.some((item) => item.code === 'LVC_ITEM_SCOPE_INVALID'));
  l1.items.pop();
  await writeFile(l1Path, JSON.stringify(l1, null, 2) + '\n');

  const evidencePath = resolve(fixture.workspace, '.psp/visual-spec/figma-evidence.json');
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.metadata.revision += 1;
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate.mjs', ['--phase', 'review']);
  assert.notEqual(result.status, 0);
  assert.ok(jsonResult(result).blockers.some((item) => item.code === 'LVC_READY_AUTHORIZATION_STALE'));
});

test('Finding closure and production dependency isolation are strict schema rules', async () => {
  const findingsSchema = JSON.parse(await readFile(resolve(import.meta.dirname, '..', 'schemas', 'review-findings.schema.json'), 'utf8'));
  const productionSchema = JSON.parse(await readFile(resolve(import.meta.dirname, '..', 'schemas', 'uihtml-production.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validateFindings = ajv.compile(findingsSchema);
  const invalidClosed = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'REVIEW-FINDINGS', revision: 1, status: 'clear' },
    deliveryLock: {
      artifactId: 'VISUAL-SPEC-DELIVERY',
      path: '.psp/visual-spec/delivery-manifest.json',
      revision: 1,
      digest: `sha256:${'a'.repeat(64)}`,
    },
    findings: [{
      findingId: 'RVW-0001',
      status: 'closed',
      level: 'L1',
      itemId: 'VSI-FDBI-001-PAGE-01',
      route: '/checkout',
      component: 'checkout-page',
      viewport: 'mobile',
      state: 'default',
      testCaseId: null,
      pathStepId: null,
      figmaEvidenceRefs: ['12:34'],
      litSource: { commit: 'abcdef1', srcUiDigest: `sha256:${'b'.repeat(64)}`, reviewBuildDigest: `sha256:${'c'.repeat(64)}` },
      screenshot: { path: '.psp/review/rvw-0001.png', digest: `sha256:${'d'.repeat(64)}` },
      description: '颜色不一致',
      rootCause: null,
      repair: null,
      verification: null,
    }],
  };
  assert.equal(validateFindings(invalidClosed), false);

  const validateProduction = ajv.compile(productionSchema);
  const production = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'UIHTML-PRODUCTION', revision: 1, status: 'accepted' },
    deliveryLock: { artifactId: 'VISUAL-SPEC-DELIVERY', path: '.psp/visual-spec/delivery-manifest.json', revision: 1, digest: `sha256:${'a'.repeat(64)}` },
    litSource: { commit: 'abcdef1', srcUiDigest: `sha256:${'b'.repeat(64)}` },
    adapter: 'real',
    bundle: { path: 'UIHTML', digest: `sha256:${'c'.repeat(64)}` },
    dependencies: ['src/ui/main.ts', 'src/review/review-main.ts'],
  };
  assert.equal(validateProduction(production), false);
});
