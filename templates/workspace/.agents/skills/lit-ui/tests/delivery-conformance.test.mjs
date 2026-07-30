import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  digest,
  fixtureWorkspace,
  jsonResult,
  run,
  writeJson,
} from '../../visual-spec/tests/helpers/workspace.mjs';
import { hashDirectory } from '../scripts/hash-uihtml.mjs';
import { stableJson } from '../../visual-spec/scripts/lib/visual-spec.mjs';

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function bundleText(root) {
  const chunks = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) chunks.push(await bundleText(path));
    else if (entry.isFile()) chunks.push(await readFile(path, 'utf8'));
  }
  return chunks.join('\n');
}

async function lock(workspace, artifactId, path) {
  const bytes = await readFile(resolve(workspace, path));
  const data = JSON.parse(bytes);
  return {
    artifactId,
    path,
    revision: data.metadata?.revision ?? data.revision,
    digest: digest(bytes),
  };
}

test('mixed L1 and L2 reaches the same reviewed Lit source, isolated Mock, and production UIHTML', async () => {
  const fixture = await fixtureWorkspace({ deliveryLevel: 'USER_PATH' });
  roots.push(fixture.parent);
  const baselinePath = resolve(fixture.workspace, '01-product-design/.psp/models/functional-delivery-baseline.json');
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  baseline.items.push({
    baselineItemId: 'FDBI-002',
    classification: 'visual',
    targetRefs: ['UC-001'],
    deliveryLevel: 'VISUAL',
    testCaseRefs: [],
    reason: '混合交付中的 L1-only 组件',
    visualRequirements: [{
      kind: 'COMPONENT',
      sourceRef: 'UC-001',
      requirementRefs: ['UC-001'],
      name: '订单摘要',
      viewports: ['mobile'],
      states: ['default'],
      variants: [],
      contentCases: ['normal'],
      tokens: [],
      assets: [],
      motions: [],
    }],
  });
  baseline.metadata.revision += 1;
  await writeFile(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  for (const script of [
    '.agents/skills/visual-spec/scripts/generate.mjs',
    '.agents/skills/user-path-cases/scripts/generate.mjs',
  ]) {
    const result = run(fixture.workspace, script, ['--json']);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  const checklist = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/checklist.json'), 'utf8'));
  assert.deepEqual(checklist.items.map((item) => item.requiredDeliveryLevel), ['USER_PATH', 'VISUAL']);

  const capturePath = resolve(fixture.parent, 'capture.json');
  await writeJson(capturePath, {
    source: {
      provider: 'figma',
      fileId: 'mixed-file',
      locator: 'figma://mixed-file',
      scope: { kind: 'file', refs: ['mixed-file'] },
      revision: '7',
      digest: `sha256:${'a'.repeat(64)}`,
      capturedAt: '2026-07-30T00:00:00.000Z',
    },
    items: checklist.items.map((item, index) => ({
      itemId: item.itemId,
      status: 'covered',
      anchors: [{
        nodeId: `12:${index + 1}`,
        nodeDigest: `sha256:${String(index + 1).repeat(64)}`,
        role: item.target.kind.toLowerCase(),
        viewport: 'mobile',
        state: 'default',
        variant: null,
        contentCase: 'normal',
        properties: ['geometry', 'layout', 'appearance', 'typography', 'viewport', 'state'],
      }],
    })),
    assets: [],
    tokens: [],
    motions: [],
  });
  let result = run(fixture.workspace, '.agents/skills/figma-workflow/scripts/bind.mjs', ['--capture', capturePath]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/authorize.mjs');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/mockcase/scripts/workflow.mjs', ['--operation', 'prepare']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const suitePath = resolve(fixture.workspace, 'MockCase/suite.json');
  const suite = JSON.parse(await readFile(suitePath, 'utf8'));
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

  await mkdir(resolve(fixture.workspace, 'src/ui'), { recursive: true });
  await mkdir(resolve(fixture.workspace, 'src/adapters/real'), { recursive: true });
  await mkdir(resolve(fixture.workspace, 'src/testing'), { recursive: true });
  await writeFile(resolve(fixture.workspace, 'src/ui/main.ts'), [
    "import { html, type TemplateResult } from 'lit';",
    'export interface CheckoutPort { submit(): Promise<string>; }',
    'export async function checkoutPage(port: CheckoutPort): Promise<TemplateResult> {',
    "  return html`<checkout-page>${await port.submit()}</checkout-page>`;",
    '}',
    'export async function renderRoute(path: string, port: CheckoutPort): Promise<TemplateResult> {',
    "  if (path !== '/checkout') return html`<p>route-not-found</p>`;",
    '  return checkoutPage(port);',
    '}',
    '',
  ].join('\n'));
  await writeFile(resolve(fixture.workspace, 'src/adapters/real/index.ts'), [
    "export const realAdapter = { submit: async () => 'real-success' };",
    '',
  ].join('\n'));
  await writeFile(resolve(fixture.workspace, 'src/testing/mock-adapter.ts'), [
    "export const mockAdapter = { submit: async () => 'mock-success' };",
    '',
  ].join('\n'));
  await writeFile(resolve(fixture.workspace, 'src/product-main.ts'), [
    "import { render } from 'lit';",
    "import { renderRoute } from './ui/main.js';",
    "import { realAdapter } from './adapters/real/index.js';",
    "render(await renderRoute('/checkout', realAdapter), document.querySelector('#app') ?? document.body);",
    '',
  ].join('\n'));
  const litTemplate = resolve(fixture.workspace, '.agents/skills/lit-ui/template');
  for (const file of ['index.html', 'review.html', 'vite.product.config.ts', 'vite.review.config.ts']) {
    await cp(resolve(litTemplate, file), resolve(fixture.workspace, file));
  }
  const srcUiDigest = await hashDirectory(resolve(fixture.workspace, 'src/ui'));
  for (const args of [
    ['init'],
    ['config', 'user.name', 'Visual Spec Fixture'],
    ['config', 'user.email', 'visual-spec@example.invalid'],
    ['add', 'src/ui', 'src/product-main.ts', 'src/adapters/real'],
    ['commit', '-m', 'fixture: real Lit production source'],
  ]) {
    const git = spawnSync('git', args, { cwd: fixture.workspace, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr || git.stdout);
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: fixture.workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(head.status, 0, head.stderr || head.stdout);
  const commit = head.stdout.trim();
  const l1Path = '.psp/visual-spec/lit-visual-coverage.json';
  await writeJson(resolve(fixture.workspace, l1Path), {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'LIT-VISUAL-COVERAGE', revision: 1, status: 'ready' },
    sourceLocks: [
      await lock(fixture.workspace, 'VISUAL-SPEC-READY-AUTHORIZATION', '.psp/visual-spec/ready-authorization.json'),
      await lock(fixture.workspace, 'FIGMA-COVERAGE', '.psp/visual-spec/figma-coverage.json'),
      await lock(fixture.workspace, 'FIGMA-EVIDENCE', '.psp/visual-spec/figma-evidence.json'),
    ],
    litSource: { commit, srcUiDigest },
    items: checklist.items.map((item) => ({
      itemId: item.itemId,
      status: 'accepted',
      route: '/checkout',
      component: item.target.kind === 'PAGE' ? 'checkout-page' : 'order-summary',
      viewports: item.dimensions.viewports,
      states: item.dimensions.states,
      variants: item.dimensions.variants,
      contentCases: item.dimensions.contentCases,
      tokenRefs: item.dimensions.tokens,
      assetRefs: item.dimensions.assets,
      motionRefs: item.dimensions.motions,
      scenarioIds: [`scenario-${item.itemId.toLowerCase()}`],
    })),
    gaps: [],
  });
  const plan = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/user-path-plan.json'), 'utf8'));
  const l2Path = '.psp/visual-spec/user-path-coverage.json';
  await writeJson(resolve(fixture.workspace, l2Path), {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'USER-PATH-COVERAGE', revision: 1, status: 'ready' },
    sourceLocks: [
      await lock(fixture.workspace, 'USER-PATH-PLAN', '.psp/visual-spec/user-path-plan.json'),
      await lock(fixture.workspace, 'LIT-VISUAL-COVERAGE', l1Path),
      await lock(fixture.workspace, 'MOCK-SCENARIO-SUITE', 'MockCase/suite.json'),
    ],
    litSource: { commit, srcUiDigest },
    paths: plan.paths.map((path) => {
      const coverage = {
        pathId: path.pathId,
        testCaseRef: path.testCaseRef,
        checklistItemRefs: path.checklistItemRefs,
        status: 'accepted',
        steps: path.steps.map((step) => ({
        pathStepId: step.pathStepId,
        route: '/checkout',
        component: 'checkout-page',
        scenarioSlot: path.scenarioSlots[0],
        checkpoint: step.checkpoint,
        assertion: step.assertion,
        passed: true,
        })),
      };
      return {
        ...coverage,
        traceDigest: digest(Buffer.from(stableJson({
          pathId: coverage.pathId,
          testCaseRef: coverage.testCaseRef,
          checklistItemRefs: [...coverage.checklistItemRefs].sort(),
          steps: coverage.steps,
        }))),
      };
    }),
    gaps: [],
  });
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate.mjs', ['--phase', 'review']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const l2CoveragePath = resolve(fixture.workspace, l2Path);
  const validL2Coverage = JSON.parse(await readFile(l2CoveragePath, 'utf8'));
  await writeJson(l2CoveragePath, { ...validL2Coverage, paths: [] });
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate.mjs', ['--phase', 'review']);
  assert.notEqual(result.status, 0);
  assert.ok(jsonResult(result).blockers.some((item) => item.code === 'UPC_PATH_NOT_ACCEPTED'));
  await writeJson(l2CoveragePath, validL2Coverage);

  await mkdir(resolve(fixture.workspace, 'src/review'), { recursive: true });
  const reviewSourcePath = resolve(fixture.workspace, 'src/review/review-main.ts');
  await writeFile(reviewSourcePath, [
    "import { html, render } from 'lit';",
    "import { renderRoute } from '../ui/main.js';",
    "import { mockAdapter } from '../testing/mock-adapter.js';",
    "render(html`<section data-marker=\"v1\">${await renderRoute('/checkout', mockAdapter)}</section>`, document.querySelector('#app') ?? document.body);",
    '',
  ].join('\n'));
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/build.mjs', ['--mode', 'review']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const reviewBundle = await bundleText(resolve(fixture.workspace, '.psp/review-dist'));
  assert.match(reviewBundle, /mock-success/);
  assert.match(reviewBundle, /checkout-page/);
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/prepare-delivery.mjs', ['--commit', commit]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await mkdir(resolve(fixture.workspace, '.psp/review'), { recursive: true });
  await writeFile(resolve(fixture.workspace, '.psp/review/finding.png'), 'fixture-screenshot');
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/mark-finding.mjs', [
    '--item', checklist.items[0].itemId,
    '--level', 'L1',
    '--screenshot', '.psp/review/finding.png',
    '--figma-evidence', '12:1',
    '--viewport', 'mobile',
    '--state', 'default',
    '--description', 'Review tool marker needs repair',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/repair-visual-delivery/scripts/route.mjs', [
    '--finding', 'RVW-0001',
    '--category', 'REVIEW_TOOL',
    '--authority', 'src/review/review-main.ts',
    '--confirmed-by', 'user:fixture',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/repair-visual-delivery/scripts/transition.mjs', [
    '--finding', 'RVW-0001',
    '--operation', 'start-repair',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  await writeFile(reviewSourcePath, [
    "import { html, render } from 'lit';",
    "import { renderRoute } from '../ui/main.js';",
    "import { mockAdapter } from '../testing/mock-adapter.js';",
    "render(html`<section data-marker=\"v2\">${await renderRoute('/checkout', mockAdapter)}</section>`, document.querySelector('#app') ?? document.body);",
    '',
  ].join('\n'));
  result = run(fixture.workspace, '.agents/skills/repair-visual-delivery/scripts/transition.mjs', [
    '--finding', 'RVW-0001',
    '--operation', 'resolve',
    '--authority', 'src/review/review-main.ts',
    '--revision', '1',
    '--digest', digest(await readFile(reviewSourcePath)),
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/build.mjs', ['--mode', 'review']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/prepare-delivery.mjs', ['--commit', commit]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/repair-visual-delivery/scripts/transition.mjs', [
    '--finding', 'RVW-0001',
    '--operation', 'verify',
    '--human-verified-by', 'user:fixture',
    '--verified-at', '2026-07-30T00:30:00.000Z',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/repair-visual-delivery/scripts/transition.mjs', [
    '--finding', 'RVW-0001',
    '--operation', 'close',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/accept-delivery.mjs', [
    '--accepted-by', 'user:fixture',
    '--accepted-at', '2026-07-30T01:00:00.000Z',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/build.mjs', ['--mode', 'product']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const productionBundle = await bundleText(resolve(fixture.workspace, 'UIHTML'));
  assert.match(productionBundle, /real-success/);
  assert.doesNotMatch(productionBundle, /mock-success|data-marker/);
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate.mjs', ['--phase', 'product']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  result = run(fixture.workspace, '.agents/skills/lit-ui/scripts/validate-delivery.mjs');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(jsonResult(result).status, 'PASS');
});
