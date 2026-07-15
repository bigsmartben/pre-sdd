import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { cleanupTemporaryRepositories, codes, runScript, temporaryRepository } from './helpers/fixture.mjs';
import { completeProductFixture, fixtureProject } from './helpers/product-fixture.mjs';

test.after(cleanupTemporaryRepositories);

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

async function canonicalFixture(root) {
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const areaPath = resolve(root, stage.root, stage.areas['canonical-ui-prototype'].root);
  const path = resolve(areaPath, 'src/spec/canonical-ui.ts');
  const text = await readFile(path, 'utf8');
  const match = text.match(/^export const canonicalUi = ([\s\S]+) as const;\s*$/);
  assert.ok(match, 'canonical-ui.ts must remain a static object literal');
  return { areaPath, path, model: JSON.parse(match[1]) };
}

async function writeCanonical(path, model) {
  await writeFile(path, 'export const canonicalUi = ' + JSON.stringify(model, null, 2) + ' as const;\n');
}

test('uninitialized product stage is a valid empty scaffold but cannot pass readiness', async () => {
  const root = await temporaryRepository();
  const structure = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--json']);
  assert.equal(structure.exitCode, 0, JSON.stringify(structure.output, null, 2));
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(strict).has('AIH_STAGE_UNINITIALIZED'));
});

test('generic initialization creates Canonical UI Prototype and removes old artifact interfaces', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  assert.equal(stage.status, 'active');
  assert.deepEqual(Object.keys(stage.artifacts), ['product-package', 'capabilities', 'interactions', 'canonical-ui-prototype']);
  assert.equal(stage.areas['canonical-ui-prototype'].root, 'Canonical-UI-Prototype');
  assert.equal(stage.artifacts['html-mock'], undefined);
  const prototypeRoot = resolve(root, stage.root, stage.areas['canonical-ui-prototype'].root);
  const source = resolve(prototypeRoot, 'src/spec/canonical-ui.ts');
  assert.match(await readFile(source, 'utf8'), /export const canonicalUi/);
  assert.match(await readFile(resolve(prototypeRoot, 'src/main.ts'), 'utf8'), /import '\.\/inconsistency-annotator';/);
  assert.match(
    await readFile(resolve(prototypeRoot, 'src/inconsistency-annotator.ts'), 'utf8'),
    /URLSearchParams\(window\.location\.search\)\.get\('annotate'\) === '1'/,
  );
  assert.ok((await stat(resolve(prototypeRoot, 'public/vendor/html2canvas-1.4.1.min.js'))).isFile());
});

test('static semantic entry generates deterministic hidden JSON and README projections', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts['canonical-ui-prototype'];
  const hidden = await readFile(resolve(root, stage.root, binding.projections[0].path), 'utf8');
  const readme = await readFile(resolve(root, stage.root, binding.projections[1].path), 'utf8');
  assert.match(hidden, /"screens":/);
  assert.match(readme, /# Canonical UI Prototype/);
  assert.equal(runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--check', '--json']).exitCode, 0);
});

test('strict validation separates workflow state from component state and checks traceability', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));

  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const source = resolve(root, stage.root, stage.areas['canonical-ui-prototype'].root, 'src/spec/canonical-ui.ts');
  const content = await readFile(source, 'utf8');
  await writeFile(source, content.replace('"scope": "workflow"', '"scope": "component"'));
  const invalid = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(invalid).has('AIH_REFERENCE_UNRESOLVED') || codes(invalid).has('AIH_GENERATED_DRIFT'));
});

test('strict validation requires every scenario event to resolve to exactly one action', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  model.actions = model.actions.filter((action) => action.eventId !== 'EVENT-002');
  await writeCanonical(path, model);
  const invalid = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(invalid).has('AIH_REFERENCE_UNRESOLVED'), JSON.stringify(invalid.output, null, 2));
  assert.ok(invalid.output.blockers.some((item) => item.message.includes('SCENARIO-002 / EVENT-002')));
});

test('Canonical UI input gate requires reproducible design source evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));
  const { areaPath } = await canonicalFixture(root);
  await appendFile(resolve(areaPath, 'design-sources/DESIGN-SOURCE-001/design-context.json'), '\nchanged');
  const invalid = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_SOURCE_INTEGRITY_FAILED'));
});

test('Canonical UI 2.0 rejects every removed legacy structure', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const legacyEvidence = structuredClone(model);
  legacyEvidence.designSources[0].evidence = 'public/source.svg';
  await writeCanonical(path, legacyEvidence);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const freeTextAssertion = structuredClone(model);
  freeTextAssertion.visualAssertions[0].description = '旧自由文本视觉说明';
  await writeCanonical(path, freeTextAssertion);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const missingViewport = structuredClone(model);
  delete missingViewport.scenarios[0].viewportIds;
  await writeCanonical(path, missingViewport);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const pageLevelFigmaLink = structuredClone(model);
  pageLevelFigmaLink.designSources[0].location = 'https://www.figma.com/design/example/psp-harness';
  await writeCanonical(path, pageLevelFigmaLink);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));
});

test('source status, gaps and typed coverage produce stable blockers', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const partial = structuredClone(model);
  partial.designSources[0].status = 'partial';
  partial.gaps = [{ id: 'GAP-SOURCE-001', description: '桌面来源仍待补充', owner: 'product-design', sourceIds: ['DESIGN-SOURCE-001'] }];
  await writeCanonical(path, partial);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_SOURCE_COVERAGE_FAILED'));

  const blocked = structuredClone(model);
  Object.assign(blocked.designSources[0], { status: 'blocked', capturedAt: null, evidence: null, coverage: [] });
  blocked.gaps = [{ id: 'GAP-SOURCE-001', description: 'Figma 节点无访问权限', owner: 'product-design', sourceIds: ['DESIGN-SOURCE-001'] }];
  await writeCanonical(path, blocked);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_SOURCE_CAPTURE_BLOCKED'));

  const missingCoverage = structuredClone(model);
  missingCoverage.designSources[0].coverage[0].stateIds = ['WF-STATE-001'];
  await writeCanonical(path, missingCoverage);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_SOURCE_COVERAGE_FAILED'));

  const unknownCoverage = structuredClone(model);
  unknownCoverage.designSources[0].coverage[0].viewportIds.push('VIEWPORT-UNKNOWN');
  await writeCanonical(path, unknownCoverage);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_REFERENCE_UNRESOLVED'));
});

test('evidence manifest rejects traversal and source identity mismatch', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  const manifestPath = resolve(areaPath, model.designSources[0].evidence.path);
  const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const traversal = structuredClone(originalManifest);
  traversal.items[0].path = '../outside.json';
  const traversalText = JSON.stringify(traversal, null, 2) + '\n';
  await writeFile(manifestPath, traversalText);
  const traversalModel = structuredClone(model);
  traversalModel.designSources[0].evidence.sha256 = sha256(traversalText);
  await writeCanonical(path, traversalModel);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));

  const mismatched = structuredClone(originalManifest);
  mismatched.sourceId = 'DESIGN-SOURCE-999';
  const mismatchedText = JSON.stringify(mismatched, null, 2) + '\n';
  await writeFile(manifestPath, mismatchedText);
  const mismatchedModel = structuredClone(model);
  mismatchedModel.designSources[0].evidence.sha256 = sha256(mismatchedText);
  await writeCanonical(path, mismatchedModel);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));

  const wrongNode = structuredClone(originalManifest);
  wrongNode.nodeId = '9:9';
  const wrongNodeText = JSON.stringify(wrongNode, null, 2) + '\n';
  await writeFile(manifestPath, wrongNodeText);
  const wrongNodeModel = structuredClone(model);
  wrongNodeModel.designSources[0].evidence.sha256 = sha256(wrongNodeText);
  await writeCanonical(path, wrongNodeModel);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));
});

test('browser validator executes declared routes, interactions and viewports with temporary evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  assert.equal(result.output.evidence.length, 6);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'route').length, 2);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'scenario').length, 4);
  assert.deepEqual(new Set(result.output.evidence.filter((item) => item.kind === 'scenario').map((item) => item.viewportId)), new Set(['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP']));
  for (const item of result.output.evidence.filter((entry) => entry.kind === 'scenario')) {
    assert.equal(item.actionStateTraces.length, 1);
    const expected = item.scenarioId === 'SCENARIO-001'
      ? ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS']
      : ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'];
    assert.deepEqual(item.actionStateTraces[0].stateIds, expected);
  }
  assert.ok(result.output.evidence.every((item) => !item.screenshot.startsWith(root)));
});

test('browser validator uses the browser accessible-name algorithm for aria-labelledby', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app
    .replace('<div class="actions">', '<span id="fixture-success-label">模拟成功</span>\n            <div class="actions">')
    .replace('                class="primary"\n                data-control-id="CONTROL-001"', '                class="primary"\n                aria-labelledby="fixture-success-label"\n                data-control-id="CONTROL-001"')
    .replace('              >\n                模拟成功\n              </button>', '              >\n              </button>'));
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
});

test('browser validator requires a font asset to be used by the declared target computed style', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  Object.assign(model.assets[0], { kind: 'font', fontFamily: 'FixtureUnusedFont' });
  await writeCanonical(path, model);
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(result).has('AIH_CANONICAL_UI_ASSET_FAILED'), JSON.stringify(result.output, null, 2));
  assert.ok(result.output.blockers.some((item) => item.message.includes('未在声明目标中实际使用')));
  assert.equal(result.output.blockers.some((item) => item.message.includes('资源未成功加载')), false);
});

test('browser validator separates console, network, visual, accessibility and asset blockers', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app
    .replace("this.feedback = '选择一种 Mock 行为，验证 Loading、Success 与 Error 状态。';", "this.feedback = '选择一种 Mock 行为，验证 Loading、Success 与 Error 状态。';\n    console.error('fixture console failure');\n    setTimeout(() => { throw new Error('fixture page failure'); }, 0);\n    void fetch('https://example.com/blocked').catch(() => undefined);")
    .replace('            <img src="/assets/DESIGN-SOURCE-001/source.svg" alt="Fixture source" width="40" height="40" />\n', '')
    .replace('                data-control-id="CONTROL-001"\n', '                data-control-id="CONTROL-001"\n                tabindex="-1"\n')
    .replace('                data-action-id="ACTION-001"', '                data-action-id="ACTION-UNKNOWN"')
    .replace('              >\n                模拟错误\n              </button>', '              >\n              </button>')
    .replace('    button {\n      min-height: 44px;', '    button {\n      box-sizing: border-box;\n      width: 30px;\n      overflow: hidden;\n      min-height: 10px;')
    .replace('button.primary { background: var(--accent); }', 'button.primary { background: var(--accent); }\n    button + button { margin-left: -10px; }')
    .replace('button:focus-visible { outline: 3px solid #678e25; outline-offset: 3px; }', 'button:focus-visible { outline: none; box-shadow: none; }'));

  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  const actual = codes(result);
  for (const expected of [
    'AIH_CANONICAL_UI_CONSOLE_FAILED',
    'AIH_CANONICAL_UI_NETWORK_FAILED',
    'AIH_CANONICAL_UI_VISUAL_FAILED',
    'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED',
    'AIH_CANONICAL_UI_ASSET_FAILED',
  ]) assert.ok(actual.has(expected), JSON.stringify(result.output, null, 2));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_CONSOLE_FAILED' && item.message.includes('页面异常')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_RUNTIME_FAILED' && item.message.includes('事件控件未绑定声明动作')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('键盘 Tab 到达')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('缺少可访问名称')));
  assert.equal(result.output.evidence.length, 6);
});
