import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  confirmationFor,
  extractMapping,
  renderMapping,
  validateMapping,
} from '../scripts/lib/mapping.mjs';
import { hashUihtml } from '../scripts/hash-uihtml.mjs';

const skillRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(skillRoot, '..', '..', '..', '..', '..');
const workspaceTemplate = resolve(repositoryRoot, 'templates', 'workspace');
const nodeModules = resolve(repositoryRoot, 'node_modules');
const temporaryRoots = [];
const sha = (value) => `sha256:${value.repeat(64).slice(0, 64)}`;

test.after(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix = 'lit-ui-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function run(script, cwd, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', windowsHide: true });
  const line = result.stdout.trim().split(/\r?\n/).at(-1);
  return { ...result, output: line ? JSON.parse(line) : null };
}

function modelFixture() {
  const model = {
    schemaVersion: 'psp.dev/mapping/v1',
    mappingVersion: '1.0.0',
    sources: {
      figma: { version: 'figma-v1', contentHash: sha('a') },
      uc: { version: 'uc-v1', contentHash: sha('b') },
    },
    concepts: [
      {
        conceptId: 'PAGE-CHECKOUT',
        kind: 'page',
        name: '结算页面',
        sourceRefs: ['figma:10:20', 'uc:UC-1'],
        relations: [],
        observableContract: { visual: '结算布局', business: '允许提交订单' },
        useCaseRefs: ['UC-1'],
        status: 'confirmed',
      },
      {
        conceptId: 'STATE-BUSINESS-READY',
        kind: 'state',
        stateLayer: 'business',
        name: '就绪',
        sourceRefs: ['uc:UC-1'],
        relations: [],
        observableContract: { business: '订单可提交' },
        useCaseRefs: ['UC-1'],
        status: 'confirmed',
      },
      {
        conceptId: 'STATE-COMPONENT-READY',
        kind: 'state',
        stateLayer: 'component',
        name: '就绪',
        sourceRefs: ['figma:10:21'],
        relations: [],
        observableContract: { visual: '按钮静止' },
        useCaseRefs: ['UC-1'],
        status: 'confirmed',
      },
    ],
    questions: [],
    confirmation: null,
  };
  model.confirmation = confirmationFor(model, 'user:fixture', '2026-07-30T00:00:00.000Z');
  return model;
}

test('Mapping.html is the single readable and machine-valid confirmation artifact', async () => {
  const template = await readFile(resolve(skillRoot, 'templates', 'Mapping.html'), 'utf8');
  const model = modelFixture();
  const html = renderMapping(template, model);
  assert.deepEqual(extractMapping(html), model);
  assert.deepEqual(validateMapping(model), []);
  assert.match(html, /Mapping\.html（契约映射表）/);
  assert.doesNotMatch(html, /(?:sourcePath|className|litTag|domSelector)/);

  const forged = modelFixture();
  forged.confirmation = confirmationFor(forged, 'agent:forged');
  assert.ok(validateMapping(forged).some((item) => item.code === 'MAPPING_USER_CONFIRMATION_REQUIRED'));
});

test('Mapping validator reports paired gap, stale, detail, source and state-layer failures', () => {
  const gap = modelFixture();
  gap.concepts[0].status = 'gap';
  assert.ok(validateMapping(gap).some((item) => item.code === 'MAPPING_GAPS_OPEN'));

  const stale = modelFixture();
  stale.concepts[0].name = '已变化';
  assert.ok(validateMapping(stale).some((item) => item.code === 'MAPPING_CONFIRMATION_STALE'));

  const detail = modelFixture();
  detail.concepts[0].litTag = 'checkout-page';
  assert.ok(validateMapping(detail).some((item) => item.code === 'MAPPING_LEAKS_IMPLEMENTATION_DETAIL'));

  const source = modelFixture();
  source.concepts[0].sourceRefs = ['figma:10:20'];
  assert.ok(validateMapping(source).some((item) => item.code === 'MAPPING_SOURCE_AUTHORITY_VIOLATION'));

  const collision = modelFixture();
  collision.concepts[1].relations.push({ kind: 'same-as', targetConceptId: 'STATE-COMPONENT-READY' });
  assert.ok(validateMapping(collision).some((item) => item.code === 'MAPPING_STATE_LAYER_COLLISION'));
});

test('Route owns URL parameter matching without rendering a Page', async () => {
  const root = await temporary('lit-route-');
  const source = (await readFile(resolve(skillRoot, 'template/src/ui/routes/index.ts'), 'utf8'))
    .replace(/import type \{ ProductPage \} from '[^']+';\r?\n/, '')
    .replaceAll('ProductPage', 'unknown');
  const sourcePath = resolve(root, 'routes.mts');
  await writeFile(sourcePath, source);
  const tsc = resolve(nodeModules, 'typescript', 'bin', 'tsc');
  const compiled = spawnSync(process.execPath, [
    tsc, sourcePath, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--outDir', root, '--skipLibCheck',
  ], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.stdout);
  const modulePath = resolve(root, 'routes.mjs');
  const { matchRoute } = await import(pathToFileURL(modulePath).href);
  const route = { path: '/orders/:id', createPage: () => ({}) };
  const match = matchRoute([route], '/orders/42');
  assert.equal(match.route, route);
  assert.deepEqual(match.parameters, { id: '42' });
  assert.equal(matchRoute([route], '/orders'), undefined);
});

test('workflow requires clarification and exact user confirmation before implementation', async () => {
  const root = await temporary('mapping-workflow-');
  await mkdir(resolve(root, '01-product-design/Lit-UI'), { recursive: true });
  const script = resolve(skillRoot, 'scripts', 'mapping-workflow.mjs');
  const mapping = '01-product-design/Lit-UI/Mapping.html';
  const initialized = run(script, root, [
    '--operation', 'initialize', '--mapping', mapping,
    '--figma-version', 'figma-v1', '--figma-hash', sha('a'),
    '--uc-version', 'uc-v1', '--uc-hash', sha('b'), '--json',
  ]);
  assert.equal(initialized.status, 0, initialized.stderr);

  const unauthorized = run(script, root, ['--operation', 'authorize-implementation', '--mapping', mapping, '--json']);
  assert.equal(unauthorized.output.status, 'BLOCKED');
  assert.ok(unauthorized.output.blockers.some((item) => item.code === 'LIT_IMPLEMENTATION_NOT_AUTHORIZED'));

  const packet = modelFixture();
  await writeFile(resolve(root, 'packet.json'), JSON.stringify({
    concepts: packet.concepts,
    questions: [],
  }));
  const updated = run(script, root, ['--operation', 'update', '--mapping', mapping, '--packet', 'packet.json', '--json']);
  assert.equal(updated.status, 0, updated.stderr);

  const agentConfirmation = run(script, root, [
    '--operation', 'confirm', '--mapping', mapping, '--confirmed-by', 'agent:fixture', '--json',
  ]);
  assert.equal(agentConfirmation.output.status, 'BLOCKED');
  assert.ok(agentConfirmation.output.blockers.some((item) => item.code === 'MAPPING_USER_CONFIRMATION_REQUIRED'));

  const emptyUserConfirmation = run(script, root, [
    '--operation', 'confirm', '--mapping', mapping, '--confirmed-by', 'user:', '--json',
  ]);
  assert.equal(emptyUserConfirmation.output.status, 'BLOCKED');
  assert.ok(emptyUserConfirmation.output.blockers.some((item) => item.code === 'MAPPING_USER_CONFIRMATION_REQUIRED'));

  const confirmed = run(script, root, [
    '--operation', 'confirm', '--mapping', mapping, '--confirmed-by', 'user:fixture', '--json',
  ]);
  assert.equal(confirmed.status, 0, confirmed.stderr);
  const authorized = run(script, root, ['--operation', 'authorize-implementation', '--mapping', mapping, '--json']);
  assert.equal(authorized.output.status, 'PASS');
  assert.equal(authorized.output.implementationAuthorized, true);
});

async function buildFixture() {
  const root = await temporary('lit-direct-build-');
  await cp(resolve(skillRoot, 'template'), root, { recursive: true });
  await symlink(nodeModules, resolve(root, 'node_modules'), 'junction');
  await writeFile(resolve(root, 'src/ui/components/submit-button.ts'), `
    import { LitElement, html } from 'lit';
    export class SubmitButton extends LitElement {
      static properties = { busy: { type: Boolean, reflect: true } };
      busy = false;
      render() {
        return html\`<button ?disabled=\${this.busy} @click=\${() => this.dispatchEvent(
          new CustomEvent('submit-requested', { bubbles: true, composed: true }),
        )}>\${this.busy ? '提交中' : '提交'}</button>\`;
      }
    }
    customElements.define('submit-button', SubmitButton);
  `);
  await writeFile(resolve(root, 'src/ui/pages/checkout-page.ts'), `
    import { html, type TemplateResult } from 'lit';
    import '../components/submit-button.js';
    import type { ProductPage } from './index.js';
    export class CheckoutPage implements ProductPage {
      readonly conceptId = 'PAGE-CHECKOUT';
      render(): TemplateResult {
        return html\`<section data-concept-id="PAGE-CHECKOUT"><h1>结算</h1><submit-button></submit-button></section>\`;
      }
    }
  `);
  await writeFile(resolve(root, 'src/ui/routes/product-routes.ts'), `
    import type { ProductRoute } from './index.js';
    import { CheckoutPage } from '../pages/checkout-page.js';
    export const productRoutes: readonly ProductRoute[] = [
      { path: '/', createPage: () => new CheckoutPage() },
    ];
  `);
  await writeFile(resolve(root, 'src/ui/main.ts'), `
    import { startProductUi } from './bootstrap.js';
    import { productRoutes } from './routes/product-routes.js';
    import { BrowserHostAdapter } from '../adapters/real/browser-host-adapter.js';
    void startProductUi({ routes: productRoutes, ports: { host: new BrowserHostAdapter() } });
  `);
  await writeFile(resolve(root, 'src/ui/bootstrap.ts'), await readFile(resolve(skillRoot, 'template/src/ui/main.ts'), 'utf8'));
  return root;
}

test('real Lit modules typecheck and build UIHTML without Review, Mock, Case, Mapping, or generic IR', async () => {
  const root = await buildFixture();
  const tsc = resolve(nodeModules, 'typescript', 'bin', 'tsc');
  const typed = spawnSync(process.execPath, [tsc, '--noEmit'], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(typed.status, 0, typed.stderr || typed.stdout);

  const vite = resolve(nodeModules, 'vite', 'bin', 'vite.js');
  const built = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.product.config.ts'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const files = await readdir(resolve(root, 'UIHTML'), { recursive: true });
  const text = (await Promise.all(
    files.filter((path) => /\.(?:html|js|css)$/.test(path)).map((path) => readFile(resolve(root, 'UIHTML', path), 'utf8')),
  )).join('\n');
  assert.doesNotMatch(text, /(?:Mapping\.html|review-main|Review Tools|MockHostAdapter|BUSINESS-CASE|canonicalUi)/i);

  const hashScript = resolve(skillRoot, 'scripts', 'hash-uihtml.mjs');
  const before = run(hashScript, root, ['--uihtml', 'UIHTML']).output.productHash;
  await writeFile(resolve(root, 'src/review/review-main.ts'), 'throw new Error("review failure fixture");');
  const rebuilt = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.product.config.ts'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);
  const after = run(hashScript, root, ['--uihtml', 'UIHTML']).output.productHash;
  assert.equal(after, before);
});

test('conformance validator detects generic IR, invalid dependency, product-owned Review and UIHTML leakage', async () => {
  const root = await buildFixture();
  await mkdir(resolve(root, '.agents/skills'), { recursive: true });
  await cp(skillRoot, resolve(root, '.agents/skills/lit-ui'), { recursive: true });
  const validator = resolve(root, '.agents/skills/lit-ui/scripts/validate.mjs');
  const positive = run(validator, root, ['--root', root, '--json']);
  assert.equal(positive.output.status, 'PASS', JSON.stringify(positive.output));

  const strict = run(validator, root, ['--root', root, '--strict', '--json']);
  assert.equal(strict.output.status, 'BLOCKED');
  assert.ok(strict.output.blockers.some((item) => item.code === 'MAPPING_ARTIFACT_MISSING'));

  await writeFile(resolve(root, 'src/adapters/real/browser-host-adapter.ts'), 'export class BrokenRealHostAdapter {}');
  await writeFile(resolve(root, 'src/testing/mock-host-adapter.ts'), 'export class BrokenMockHostAdapter {}');
  await writeFile(resolve(root, 'vite.product.config.ts'), `
    import './src/review/review-main.ts';
    export default { build: { outDir: '.psp/review-dist' } };
  `);
  await writeFile(resolve(root, 'src/ui/components/canonical-ui.ts'), 'export const table = {};');
  await writeFile(resolve(root, 'src/ui/components/bad.ts'), "import type { ProductRoute } from '../routes/index.js';");
  await writeFile(resolve(root, 'src/review/owns-route.ts'), 'export interface ProductRoute { path: string }');
  await mkdir(resolve(root, 'UIHTML'), { recursive: true });
  await writeFile(resolve(root, 'UIHTML/index.js'), 'fetch("Mapping.html"); import("./review-main.js");');
  const negative = run(validator, root, ['--root', root, '--uihtml', 'UIHTML', '--json']);
  const codes = new Set(negative.output.blockers.map((item) => item.code));
  for (const code of [
    'GENERIC_UI_IR_REINTRODUCED',
    'LITSPEC_DEPENDENCY_INVALID',
    'PORT_ADAPTER_CONTRACT_MISMATCH',
    'REVIEW_TOOL_PRODUCT_OWNERSHIP',
    'REVIEW_TOOL_FAILURE_PROPAGATED',
    'REVIEW_TOOL_HASH_LEAK',
    'NON_PRODUCT_DEPENDENCY_IN_UIHTML',
  ]) assert.ok(codes.has(code), JSON.stringify(negative.output));
});

test('UIHTML delivery acceptance has stable interaction, motion, visual, runtime, and hash blockers', async () => {
  const root = await temporary('uihtml-acceptance-');
  const script = resolve(skillRoot, 'scripts', 'validate-delivery.mjs');
  await mkdir(resolve(root, 'UIHTML'), { recursive: true });
  await writeFile(resolve(root, 'UIHTML/index.html'), '<!doctype html><html><body><main>ready</main></body></html>');
  const productHash = await hashUihtml(resolve(root, 'UIHTML'));
  const good = {
    schemaVersion: 'psp.dev/uihtml-acceptance/v1',
    standalone: { opened: true, assetsResolved: true },
    interactions: [{ route: '/', event: 'submit-requested', expectedState: 'success', passed: true }],
    motions: [{ conceptId: 'MOTION-SUBMIT', timingPassed: true, interruptionPassed: true, reducedMotionPassed: true }],
    visualComparisons: [{ figmaNodeId: '10:20', viewport: '1440x900', differenceRatio: 0.01, threshold: 0.02 }],
    productHash,
    productHashAfterReviewCaseChange: productHash,
  };
  await writeFile(resolve(root, 'report.json'), JSON.stringify(good));
  assert.equal(run(script, root, ['--report', 'report.json', '--uihtml', 'UIHTML']).output.status, 'PASS');

  const bad = structuredClone(good);
  bad.standalone.opened = false;
  bad.interactions[0].passed = false;
  bad.motions[0].reducedMotionPassed = false;
  bad.visualComparisons[0].differenceRatio = 1;
  bad.productHashAfterReviewCaseChange = sha('d');
  await writeFile(resolve(root, 'report.json'), JSON.stringify(bad));
  const result = run(script, root, ['--report', 'report.json', '--uihtml', 'UIHTML']);
  const codes = new Set(result.output.blockers.map((item) => item.code));
  for (const code of [
    'UIHTML_RUNTIME_DEP_MISSING',
    'UIHTML_INTERACTION_PARITY_FAILED',
    'UIHTML_MOTION_PARITY_FAILED',
    'UIHTML_VISUAL_PARITY_FAILED',
    'UIHTML_HASH_BOUNDARY_INVALID',
  ]) assert.ok(codes.has(code));

  const schemaInvalid = structuredClone(good);
  schemaInvalid.standalone.opened = 'yes';
  schemaInvalid.interactions[0].passed = 'yes';
  schemaInvalid.visualComparisons[0].differenceRatio = 999;
  delete schemaInvalid.visualComparisons[0].threshold;
  await writeFile(resolve(root, 'report.json'), JSON.stringify(schemaInvalid));
  const invalidResult = run(script, root, ['--report', 'report.json', '--uihtml', 'UIHTML']);
  assert.equal(invalidResult.output.status, 'BLOCKED');
  assert.ok(invalidResult.output.blockers.some((item) => item.code === 'UIHTML_RUNTIME_DEP_MISSING'));
  assert.ok(invalidResult.output.blockers.some((item) => item.code === 'UIHTML_VISUAL_PARITY_FAILED'));

  await writeFile(
    resolve(root, 'UIHTML/index.html'),
    '<!doctype html><html><body><main>ready</main><script src="/missing.js"></script></body></html>',
  );
  const runtimeBad = structuredClone(good);
  runtimeBad.productHash = await hashUihtml(resolve(root, 'UIHTML'));
  runtimeBad.productHashAfterReviewCaseChange = runtimeBad.productHash;
  await writeFile(resolve(root, 'report.json'), JSON.stringify(runtimeBad));
  const runtimeResult = run(script, root, ['--report', 'report.json', '--uihtml', 'UIHTML']);
  assert.equal(runtimeResult.output.status, 'BLOCKED');
  assert.ok(runtimeResult.output.blockers.some((item) => (
    item.code === 'UIHTML_RUNTIME_DEP_MISSING' && item.message.includes('404')
  )));
});
