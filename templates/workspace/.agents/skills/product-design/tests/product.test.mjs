import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { stringify as stringifyYaml } from 'yaml';
import { cleanupTemporaryRepositories, codes, runScript, temporaryRepository } from './helpers/fixture.mjs';
import { completeProductFixture, fixtureProject, readArtifact } from './helpers/product-fixture.mjs';

test.after(cleanupTemporaryRepositories);

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
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

function repositoryPath(root, path) {
  return relative(root, path).split(sep).join('/');
}

async function writeRepairAction(requested, modifiedPaths, repairLayer = 'paint') {
  const packet = JSON.parse(await readFile(requested.output.repairPacket, 'utf8'));
  const groups = new Map();
  for (const failure of packet.failures) {
    if (!groups.has(failure.sourceId)) {
      groups.set(failure.sourceId, {
        failureAssertionIds: new Set(),
        sourceEvidenceItemIds: new Set(),
      });
    }
    const group = groups.get(failure.sourceId);
    group.failureAssertionIds.add(failure.assertionId);
    for (const evidenceItemId of failure.sourceEvidenceItemIds) group.sourceEvidenceItemIds.add(evidenceItemId);
  }
  const report = {
    version: '1.0.0',
    attempt: packet.attempt,
    sourceResolution: {
      decision: 'no-applicable-source-asset',
      sourceEvidenceItemIds: [...new Set(packet.failures.flatMap((failure) => failure.sourceEvidenceItemIds))],
      rationale: '当前差异来自样式值，已核对来源资源，不存在可直接替代本次修改的静态资源。',
    },
    actions: [...groups.entries()].map(([sourceId, group]) => ({
      failureAssertionIds: [...group.failureAssertionIds],
      sourceId,
      sourceEvidenceItemIds: [...group.sourceEvidenceItemIds],
      repairLayer,
      modifiedPaths: modifiedPaths.map((path) => repositoryPath(packet.workspaceRoot, path)),
      expectedImpact: '使实现重新满足来源一致性断言',
    })),
  };
  await writeFile(packet.actionReportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  return report;
}

async function prepareExactFixture(root) {
  const { areaPath, path, model } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  const guidedRuntime = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(guidedRuntime.exitCode, 0, JSON.stringify(guidedRuntime.output, null, 2));
  const routeBaseline = guidedRuntime.output.evidence.find((item) => item.kind === 'route' && item.viewportId === 'VIEWPORT-DESKTOP').screenshot;
  const baselineContent = await readFile(routeBaseline);
  const baselineRelativePath = 'design-sources/DESIGN-SOURCE-001/exact-desktop.png';
  const baselinePath = resolve(areaPath, baselineRelativePath);
  await writeFile(baselinePath, baselineContent);
  const evidencePath = resolve(areaPath, model.designSources[0].evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.items.push({ id: 'EVIDENCE-EXACT-DESKTOP', role: 'screenshot', path: baselineRelativePath, sha256: sha256(baselineContent) });
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);

  const exact = structuredClone(model);
  exact.visualPolicy = {
    mode: 'exact',
    selectedBy: 'user-explicit',
    aspects: ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'],
    coverage: [{ sourceId: 'DESIGN-SOURCE-001', screenId: 'SCREEN-001', stateIds: exact.states.map((item) => item.id), viewportIds: ['VIEWPORT-DESKTOP'], evidenceItemIds: ['EVIDENCE-EXACT-DESKTOP'] }],
  };
  exact.repairPolicy.enabled = true;
  exact.designSources[0].evidence.sha256 = sha256(evidenceText);
  exact.designSources[0].coverage[0].viewportIds = ['VIEWPORT-DESKTOP'];
  exact.designSources[0].coverage[0].evidenceItemIds.push('EVIDENCE-EXACT-DESKTOP');
  exact.viewports = exact.viewports.filter((item) => item.id === 'VIEWPORT-DESKTOP');
  exact.scenarios = [];
  exact.renderAssertions = exact.renderAssertions.filter((item) => !item.scenarioId).map((item) => ({ ...item, viewportIds: ['VIEWPORT-DESKTOP'] }));
  exact.sourceParityAssertions = [{
    id: 'PARITY-EXACT-DESKTOP',
    sourceId: 'DESIGN-SOURCE-001',
    routeId: 'ROUTE-001',
    viewportId: 'VIEWPORT-DESKTOP',
    baselineEvidenceItemId: 'EVIDENCE-EXACT-DESKTOP',
    aspects: exact.visualPolicy.aspects,
    checks: [
      { kind: 'screenshot-match' },
      { kind: 'computed-style', targetId: 'CONTROL-001', property: 'background-color', expected: 'rgb(200, 243, 106)' },
    ],
  }];
  await writeCanonical(path, exact);
  const exactInput = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(exactInput.exitCode, 0, JSON.stringify(exactInput.output, null, 2));
  const exactRuntime = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(exactRuntime.exitCode, 0, JSON.stringify(exactRuntime.output, null, 2));
  return { areaPath, path, model: exact, appPath, app, baselinePath };
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
  assert.deepEqual(Object.keys(stage.artifacts), ['capabilities', 'interactions', 'canonical-ui-prototype']);
  assert.equal(stage.areas['canonical-ui-prototype'].root, 'Canonical-UI-Prototype');
  assert.equal(stage.artifacts['html-mock'], undefined);
  const prototypeRoot = resolve(root, stage.root, stage.areas['canonical-ui-prototype'].root);
  const source = resolve(prototypeRoot, 'src/spec/canonical-ui.ts');
  const canonicalSource = await readFile(source, 'utf8');
  assert.match(canonicalSource, /export const canonicalUi/);
  assert.match(canonicalSource, /viewports: \[\]/);
  assert.doesNotMatch(canonicalSource, /accessibility\s*:/);
  assert.match(await readFile(resolve(prototypeRoot, 'src/main.ts'), 'utf8'), /import '\.\/inconsistency-annotator';/);
  const annotator = await readFile(resolve(prototypeRoot, 'src/inconsistency-annotator.ts'), 'utf8');
  assert.match(annotator, /URLSearchParams\(window\.location\.search\)\.get\('annotate'\) === '1'/);
  assert.match(annotator, /pageKey: string/);
  assert.match(annotator, /new MutationObserver\(this\.schedulePageRefresh\)/);
  assert.match(annotator, /querySelectorAll<HTMLElement>\('\[data-screen-id\]'\)/);
  assert.match(annotator, /marker\.pageKey === this\.currentPageKey/);
  const runtime = await readFile(resolve(root, '.agents/skills/product-design/canonical-ui-prototype/scripts/runtime.mjs'), 'utf8');
  assert.match(runtime, /server\.resolvedUrls\?\.local\?\.\[0\]/);
  assert.match(runtime, /searchParams\.set\('annotate', '1'\)/);
  assert.match(runtime, /\[READY\] Canonical UI Prototype 评审地址/);
  const skill = await readFile(resolve(root, '.agents/skills/product-design/SKILL.md'), 'utf8');
  assert.match(skill, /AIH_CANONICAL_UI_SERVER_FAILED/);
  assert.match(skill, /不得根据默认端口猜测或伪造地址/);
  assert.ok((await stat(resolve(prototypeRoot, 'public/vendor/html2canvas-1.4.1.min.js'))).isFile());
});

test('Use Cases transaction commits authority, full document, and Product Package summary from one candidate', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  const artifact = await readArtifact(root, stage, binding);
  const ucPath = resolve(root, stage.root, binding.outputs.find((output) => output.projection === 'use-cases-document').path);
  const summaryPath = resolve(root, stage.root, binding.outputs.find((output) => output.projection === 'product-package-summary').path);
  artifact.data.intent.productName = '原子事务产品';
  const candidate = resolve(root, '.psp/candidate-use-cases.yaml');
  await writeFile(candidate, stringifyYaml(artifact.data));
  const before = await readFile(artifact.path, 'utf8');
  const applied = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact',
    '--artifact', 'capabilities',
    '--input', candidate,
    '--expected-sha256', digest(before),
    '--json',
  ]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));
  const authority = await readFile(artifact.path, 'utf8');
  const ucMarkdown = await readFile(ucPath, 'utf8');
  const summaryMarkdown = await readFile(summaryPath, 'utf8');
  assert.match(authority, /原子事务产品/);
  assert.match(ucMarkdown, /原子事务产品/);
  assert.match(summaryMarkdown, /原子事务产品/);
  assert.match(summaryMarkdown, /intent\.productName/);
  assert.match(ucMarkdown, new RegExp('sourceSha256: ' + digest(authority)));
  assert.match(summaryMarkdown, new RegExp('sourceSha256: ' + digest(authority)));

  artifact.data.intent.productName = '过期写入';
  await writeFile(candidate, stringifyYaml(artifact.data));
  const stale = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact',
    '--artifact', 'capabilities',
    '--input', candidate,
    '--expected-sha256', digest(before),
    '--json',
  ]);
  assert.ok(codes(stale).has('AIH_USER_CHANGE_COLLISION'));
  assert.equal(await readFile(artifact.path, 'utf8'), authority);
  assert.equal(await readFile(ucPath, 'utf8'), ucMarkdown);
  assert.equal(await readFile(summaryPath, 'utf8'), summaryMarkdown);
});

test('Use Cases transaction rolls all three targets back after a partial replacement failure', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  const artifact = await readArtifact(root, stage, binding);
  const outputPaths = binding.outputs.map((output) => resolve(root, stage.root, output.path));
  const beforeAuthority = await readFile(artifact.path, 'utf8');
  const beforeMarkdown = await Promise.all(outputPaths.map((path) => readFile(path, 'utf8')));
  artifact.data.intent.productName = '不得留下的部分提交';
  const candidate = resolve(root, '.psp/candidate-use-cases.yaml');
  await writeFile(candidate, stringifyYaml(artifact.data));
  const failed = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact',
    '--artifact', 'capabilities',
    '--input', candidate,
    '--expected-sha256', digest(beforeAuthority),
    '--json',
  ], { environment: { AI_HARNESS_TRANSACTION_FAIL_AFTER_RENAMES: '1' } });
  assert.ok(codes(failed).has('AIH_ARTIFACT_TRANSACTION_FAILED'));
  assert.equal(await readFile(artifact.path, 'utf8'), beforeAuthority);
  assert.deepEqual(await Promise.all(outputPaths.map((path) => readFile(path, 'utf8'))), beforeMarkdown);
});

test('artifact operation completes a journaled commit after a process crash', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  const artifact = await readArtifact(root, stage, binding);
  const outputPaths = binding.outputs.map((output) => resolve(root, stage.root, output.path));
  const before = await readFile(artifact.path, 'utf8');
  artifact.data.intent.productName = '崩溃恢复产品';
  const candidate = resolve(root, '.psp/candidate-use-cases.yaml');
  await writeFile(candidate, stringifyYaml(artifact.data));
  const crashed = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact',
    '--artifact', 'capabilities',
    '--input', candidate,
    '--expected-sha256', digest(before),
    '--json',
  ], { environment: { AI_HARNESS_TRANSACTION_CRASH_AFTER_RENAMES: '1' } });
  assert.equal(crashed.exitCode, 86);
  const partiallyCommittedAuthority = await readFile(artifact.path, 'utf8');
  const recovered = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact',
    '--artifact', 'capabilities',
    '--input', candidate,
    '--expected-sha256', digest(partiallyCommittedAuthority),
    '--json',
  ]);
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.output, null, 2));
  assert.match(await readFile(artifact.path, 'utf8'), /崩溃恢复产品/);
  for (const outputPath of outputPaths) assert.match(await readFile(outputPath, 'utf8'), /崩溃恢复产品/);
  await assert.rejects(stat(resolve(root, '.psp/transactions/capabilities.json')), { code: 'ENOENT' });
  await assert.rejects(stat(resolve(root, '.psp/transactions/capabilities.lock')), { code: 'ENOENT' });
});

test('Use Cases readiness detects drift in the Product Package summary projection', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const summary = stage.artifacts.capabilities.outputs.find((output) => output.projection === 'product-package-summary');
  await appendFile(resolve(root, stage.root, summary.path), '\nmanual summary edit\n');
  const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.ok(codes(result).has('AIH_GENERATED_DRIFT'));
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

test('strict validation accepts only the user-confirmed viewport instead of requiring mobile and desktop', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  const selectedViewportId = 'VIEWPORT-DESKTOP';
  model.viewports = model.viewports.filter((viewport) => viewport.id === selectedViewportId);
  for (const source of model.designSources) {
    for (const coverage of source.coverage) coverage.viewportIds = [selectedViewportId];
  }
  for (const coverage of model.visualPolicy.coverage) coverage.viewportIds = [selectedViewportId];
  for (const scenario of model.scenarios) scenario.viewportIds = [selectedViewportId];
  for (const assertion of model.renderAssertions) assertion.viewportIds = [selectedViewportId];
  model.sourceParityAssertions = model.sourceParityAssertions.filter((assertion) => assertion.viewportId === selectedViewportId);
  await writeCanonical(path, model);
  const rendered = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.output, null, 2));
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
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

test('Figma source registration packet validates adapter output without owning Canonical UI identifiers', async () => {
  const root = await temporaryRepository();
  const schema = JSON.parse(await readFile(
    resolve(root, '.agents/skills/capture-figma-design-source/source-registration.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const packet = {
    version: '1.0.0',
    sourceId: 'DESIGN-SOURCE-001',
    sourceVersion: { kind: 'figma-file-version', value: 'fixture-version-20260715' },
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: 'sha256:' + 'a'.repeat(64),
    assets: [{
      path: 'public/assets/DESIGN-SOURCE-001/source.svg',
      sourceNodeId: '1:3',
      assetKind: 'icon',
      usageTargetIds: ['COMPONENT-001'],
    }],
    gaps: [],
  };
  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(Object.hasOwn(packet.assets[0], 'id'), false);
  delete packet.assets[0].usageTargetIds;
  assert.equal(validate(packet), false);
});

test('Canonical UI 4.0 rejects every removed legacy structure', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const legacyEvidence = structuredClone(model);
  legacyEvidence.designSources[0].evidence = 'public/source.svg';
  await writeCanonical(path, legacyEvidence);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const freeTextAssertion = structuredClone(model);
  freeTextAssertion.renderAssertions[0].description = '旧自由文本视觉说明';
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

test('component abstraction gates require unique inventory, resolvable mappings, and complete Variant coverage', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const missingInventory = structuredClone(model);
  missingInventory.componentInventory = [];
  await writeCanonical(path, missingInventory);
  const unresolved = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(unresolved).has('AIH_COMPONENT_ABSTRACTION_UNRESOLVED'), JSON.stringify(unresolved.output, null, 2));

  const invalidMapping = structuredClone(model);
  invalidMapping.componentMappings[0].figmaComponentNodeId = '1:2';
  await writeCanonical(path, invalidMapping);
  const invalid = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_COMPONENT_MAPPING_INVALID'), JSON.stringify(invalid.output, null, 2));

  const unsupportedStructure = structuredClone(model);
  unsupportedStructure.componentInventory[0].structureSignatures = ['sha256:' + '3'.repeat(64)];
  await writeCanonical(path, unsupportedStructure);
  const unsupported = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(unsupported).has('AIH_COMPONENT_ABSTRACTION_UNRESOLVED'), JSON.stringify(unsupported.output, null, 2));

  const missingVariant = structuredClone(model);
  missingVariant.componentVariantCoverage[0].figmaVariantProperties.Mode = 'Busy';
  missingVariant.componentVariantCoverage[0].litVariantAttributes.mode = 'busy';
  await writeCanonical(path, missingVariant);
  const incomplete = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(incomplete).has('AIH_COMPONENT_VARIANT_COVERAGE_FAILED'), JSON.stringify(incomplete.output, null, 2));
});

test('guided partial sources are valid while blocked and incomplete exact sources stay blocked', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const partial = structuredClone(model);
  partial.designSources[0].status = 'partial';
  await writeCanonical(path, partial);
  const partialRendered = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(partialRendered.exitCode, 0, JSON.stringify(partialRendered.output, null, 2));
  const partialResult = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(partialResult.exitCode, 0, JSON.stringify(partialResult.output, null, 2));

  const blocked = structuredClone(model);
  Object.assign(blocked.designSources[0], { status: 'blocked', capturedAt: null, evidence: null, coverage: [] });
  blocked.gaps = [{ id: 'GAP-SOURCE-001', description: 'Figma 节点无访问权限', owner: 'product-design', sourceIds: ['DESIGN-SOURCE-001'] }];
  await writeCanonical(path, blocked);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_SOURCE_CAPTURE_BLOCKED'));

  const missingCoverage = structuredClone(model);
  missingCoverage.visualPolicy.mode = 'exact';
  missingCoverage.visualPolicy.aspects = ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'];
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

  const restoredText = JSON.stringify(originalManifest, null, 2) + '\n';
  await writeFile(manifestPath, restoredText);
  const screenshotAsAsset = structuredClone(model);
  screenshotAsAsset.designSources[0].evidence.sha256 = sha256(restoredText);
  screenshotAsAsset.assets[0].path = originalManifest.items.find((item) => item.role === 'screenshot').path;
  await writeCanonical(path, screenshotAsAsset);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));
});

test('Figma evidence requires normalized parameters and layer-scoped static assets', async () => {
  const versionRoot = await temporaryRepository();
  await completeProductFixture(versionRoot);
  const versionFixture = await canonicalFixture(versionRoot);
  const versionEvidencePath = resolve(versionFixture.areaPath, versionFixture.model.designSources[0].evidence.path);
  const versionEvidence = JSON.parse(await readFile(versionEvidencePath, 'utf8'));
  const versionContextItem = versionEvidence.items.find((item) => item.role === 'design-context');
  const versionContextPath = resolve(versionFixture.areaPath, versionContextItem.path);
  const versionContext = JSON.parse(await readFile(versionContextPath, 'utf8'));
  versionContext.sourceVersion = { kind: 'figma-file-version', value: 'different-remote-version' };
  const versionContextText = JSON.stringify(versionContext, null, 2) + '\n';
  await writeFile(versionContextPath, versionContextText);
  versionContextItem.sha256 = sha256(versionContextText);
  const versionEvidenceText = JSON.stringify(versionEvidence, null, 2) + '\n';
  await writeFile(versionEvidencePath, versionEvidenceText);
  const versionModel = structuredClone(versionFixture.model);
  versionModel.designSources[0].evidence.sha256 = sha256(versionEvidenceText);
  await writeCanonical(versionFixture.path, versionModel);
  const mismatchedVersion = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', versionRoot, ['--json']);
  assert.ok(codes(mismatchedVersion).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(mismatchedVersion.output, null, 2));

  const contextRoot = await temporaryRepository();
  await completeProductFixture(contextRoot);
  const contextFixture = await canonicalFixture(contextRoot);
  const contextEvidencePath = resolve(contextFixture.areaPath, contextFixture.model.designSources[0].evidence.path);
  const contextEvidence = JSON.parse(await readFile(contextEvidencePath, 'utf8'));
  const contextItem = contextEvidence.items.find((item) => item.role === 'design-context');
  const contextPath = resolve(contextFixture.areaPath, contextItem.path);
  const incompleteContext = '{}\n';
  await writeFile(contextPath, incompleteContext);
  contextItem.sha256 = sha256(incompleteContext);
  const contextEvidenceText = JSON.stringify(contextEvidence, null, 2) + '\n';
  await writeFile(contextEvidencePath, contextEvidenceText);
  const contextModel = structuredClone(contextFixture.model);
  contextModel.designSources[0].evidence.sha256 = sha256(contextEvidenceText);
  await writeCanonical(contextFixture.path, contextModel);
  const incomplete = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', contextRoot, ['--json']);
  assert.ok(codes(incomplete).has('AIH_VISUAL_SOURCE_INCOMPLETE'), JSON.stringify(incomplete.output, null, 2));

  const assetRoot = await temporaryRepository();
  await completeProductFixture(assetRoot);
  const assetFixture = await canonicalFixture(assetRoot);
  const assetEvidencePath = resolve(assetFixture.areaPath, assetFixture.model.designSources[0].evidence.path);
  const assetEvidence = JSON.parse(await readFile(assetEvidencePath, 'utf8'));
  assetEvidence.items.find((item) => item.role === 'asset').captureScope = 'artwork-subtree';
  const assetEvidenceText = JSON.stringify(assetEvidence, null, 2) + '\n';
  await writeFile(assetEvidencePath, assetEvidenceText);
  const assetModel = structuredClone(assetFixture.model);
  assetModel.designSources[0].evidence.sha256 = sha256(assetEvidenceText);
  await writeCanonical(assetFixture.path, assetModel);
  const invalidAsset = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', assetRoot, ['--json']);
  assert.ok(codes(invalidAsset).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(invalidAsset.output, null, 2));
});

test('exported Figma assets pass only after asset evidence and manifest hashes are closed', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  const assetRelativePath = 'public/assets/DESIGN-SOURCE-001/exported-badge.svg';
  const assetPath = resolve(areaPath, assetRelativePath);
  const assetContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#c8f36a"/></svg>\n';
  await writeFile(assetPath, assetContent);

  const exported = structuredClone(model);
  exported.assets.push({
    id: 'ASSET-EXPORTED-001',
    path: assetRelativePath,
    kind: 'image',
    sourceIds: ['DESIGN-SOURCE-001'],
    usageTargetIds: ['COMPONENT-001'],
    alt: 'Exported badge',
  });
  await writeCanonical(path, exported);
  const missingEvidence = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(missingEvidence).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(missingEvidence.output, null, 2));

  const evidencePath = resolve(areaPath, exported.designSources[0].evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.items.push({
    id: 'EVIDENCE-ASSET-EXPORTED-001',
    role: 'asset',
    path: assetRelativePath,
    sha256: sha256(assetContent),
    sourceNodeId: '1:3',
    assetKind: 'icon',
    captureScope: 'layer',
    containsDynamicContent: false,
  });
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);
  const staleManifestHash = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(staleManifestHash).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(staleManifestHash.output, null, 2));

  exported.designSources[0].evidence.sha256 = sha256(evidenceText);
  await writeCanonical(path, exported);
  const closed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(closed.exitCode, 0, JSON.stringify(closed.output, null, 2));
});

test('browser validator executes declared routes, interactions and viewports with temporary evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
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

  const indexPath = resolve(areaPath, 'index.html');
  const index = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, index.replace('mode="default"', 'mode="special"'));
  const mismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(mismatch).has('AIH_COMPONENT_IMPLEMENTATION_MISMATCH'), JSON.stringify(mismatch.output, null, 2));
});

test('visual policy supports autonomous, guided and exact enforcement without a change-profile bypass', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);

  const unresolved = structuredClone(model);
  unresolved.visualPolicy = { mode: 'unresolved', selectedBy: 'default-policy', aspects: [], coverage: [] };
  unresolved.sourceParityAssertions = [];
  await writeCanonical(path, unresolved);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_VISUAL_POLICY_UNRESOLVED'));

  const autonomous = structuredClone(model);
  autonomous.visualPolicy = { mode: 'autonomous', selectedBy: 'default-policy', aspects: [], coverage: [] };
  autonomous.designSources = [];
  autonomous.assets = [];
  autonomous.tokens = [];
  autonomous.componentInventory = [];
  autonomous.componentMappings = [];
  autonomous.componentVariantCoverage = [];
  autonomous.sourceParityAssertions = [];
  await writeCanonical(path, autonomous);
  const autonomousResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(autonomousResult.exitCode, 0, JSON.stringify(autonomousResult.output, null, 2));

  await writeCanonical(path, model);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const guidedMismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(guidedMismatch).has('AIH_VISUAL_STYLE_BINDING_FAILED'), JSON.stringify(guidedMismatch.output, null, 2));
  const guidedRepair = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(guidedRepair.output.status, 'BLOCKED');
  assert.equal(guidedRepair.output.repairPacket, undefined);
  assert.ok(codes(guidedRepair).has('AIH_VISUAL_STYLE_BINDING_FAILED'));
  await writeFile(appPath, app);

  const guidedRuntime = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(guidedRuntime.exitCode, 0, JSON.stringify(guidedRuntime.output, null, 2));
  const routeBaseline = guidedRuntime.output.evidence.find((item) => item.kind === 'route' && item.viewportId === 'VIEWPORT-DESKTOP').screenshot;
  const baselineContent = await readFile(routeBaseline);
  const baselineRelativePath = 'design-sources/DESIGN-SOURCE-001/exact-desktop.png';
  await writeFile(resolve(areaPath, baselineRelativePath), baselineContent);
  const evidencePath = resolve(areaPath, model.designSources[0].evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.items.push({ id: 'EVIDENCE-EXACT-DESKTOP', role: 'screenshot', path: baselineRelativePath, sha256: sha256(baselineContent) });
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);

  const exact = structuredClone(model);
  exact.visualPolicy = {
    mode: 'exact',
    selectedBy: 'user-explicit',
    aspects: ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'],
    coverage: [{ sourceId: 'DESIGN-SOURCE-001', screenId: 'SCREEN-001', stateIds: exact.states.map((item) => item.id), viewportIds: ['VIEWPORT-DESKTOP'], evidenceItemIds: ['EVIDENCE-EXACT-DESKTOP'] }],
  };
  exact.repairPolicy.enabled = true;
  exact.designSources[0].evidence.sha256 = sha256(evidenceText);
  exact.designSources[0].coverage[0].viewportIds = ['VIEWPORT-DESKTOP'];
  exact.designSources[0].coverage[0].evidenceItemIds.push('EVIDENCE-EXACT-DESKTOP');
  exact.viewports = exact.viewports.filter((item) => item.id === 'VIEWPORT-DESKTOP');
  exact.scenarios = [];
  exact.renderAssertions = exact.renderAssertions.filter((item) => !item.scenarioId).map((item) => ({ ...item, viewportIds: ['VIEWPORT-DESKTOP'] }));
  exact.sourceParityAssertions = [{
    id: 'PARITY-EXACT-DESKTOP',
    sourceId: 'DESIGN-SOURCE-001',
    routeId: 'ROUTE-001',
    viewportId: 'VIEWPORT-DESKTOP',
    baselineEvidenceItemId: 'EVIDENCE-EXACT-DESKTOP',
    aspects: exact.visualPolicy.aspects,
    checks: [{ kind: 'screenshot-match' }],
  }];
  await writeCanonical(path, exact);
  const exactInput = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(exactInput.exitCode, 0, JSON.stringify(exactInput.output, null, 2));
  const exactMatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(exactMatch.exitCode, 0, JSON.stringify(exactMatch.output, null, 2));

  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const exactMismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(exactMismatch).has('AIH_VISUAL_SOURCE_PARITY_FAILED'), JSON.stringify(exactMismatch.output, null, 2));

  const localManifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  const defaultProfile = localManifest.validationProfiles.find((item) => item.id === 'canonical-ui-prototype');
  assert.ok(defaultProfile.commands.includes('product-strict'));
});

test('exact visual repair emits a complete packet and passes after an allowed implementation fix', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { appPath, app } = await prepareExactFixture(root);
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));

  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));
  assert.equal(requested.output.attempt, 1);
  const packet = JSON.parse(await readFile(requested.output.repairPacket, 'utf8'));
  assert.equal(packet.version, '4.0.0');
  assert.equal(packet.status, 'REPAIR_REQUIRED');
  assert.equal(packet.maxAttempts, 3);
  assert.deepEqual(packet.implementationPolicy, {
    evidenceBeforeEdit: true,
    requireSourceResolution: true,
    preserveInteractiveDom: true,
    preferSourceAssets: true,
    allowSubjectiveApproximation: false,
    minimalImplementationScope: true,
    stableComparisonEnvironment: true,
    fixOrder: ['source-resolution', 'structure', 'geometry', 'typography', 'paint', 'effects', 'assets'],
  });
  assert.equal(packet.failures[0].blockerCode, 'AIH_VISUAL_SOURCE_PARITY_FAILED');
  assert.equal(packet.failures[0].sourceId, 'DESIGN-SOURCE-001');
  assert.equal(packet.failures[0].sourceKind, 'figma');
  assert.equal(packet.failures[0].checkKind, 'screenshot-match');
  assert.equal(packet.failures[0].designContextEvidenceItemId, 'EVIDENCE-CONTEXT-001');
  assert.ok((await stat(packet.failures[0].designContext)).isFile());
  assert.ok((await stat(packet.failures[0].sourceBaseline)).isFile());
  assert.ok((await stat(packet.failures[0].actualScreenshot)).isFile());
  assert.ok((await stat(packet.failures[0].differenceScreenshot)).isFile());
  assert.ok(packet.failures[0].differenceRegions.length > 0);
  assert.ok(packet.failures[0].differenceRegions.every((region) => (
    Number.isInteger(region.x)
    && Number.isInteger(region.y)
    && Number.isInteger(region.width)
    && Number.isInteger(region.height)
    && region.width > 0
    && region.height > 0
  )));
  const styleFailure = packet.failures.find((failure) => failure.checkKind === 'computed-style');
  assert.equal(styleFailure.targetId, 'CONTROL-001');
  assert.equal(styleFailure.styleProperty, 'background-color');
  assert.equal(styleFailure.expectedStyle, 'rgb(200, 243, 106)');

  await writeFile(appPath, app);
  await writeRepairAction(requested, [appPath]);
  const repaired = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(repaired.exitCode, 0, JSON.stringify(repaired.output, null, 2));
  assert.equal(repaired.output.status, 'PASS');
  assert.equal(repaired.output.attempts, 1);
  assert.equal(repaired.output.attemptHistory[0].actions[0].repairLayer, 'paint');
});

test('exact visual repair blocks baseline changes and missing source evidence', async () => {
  const changedRoot = await temporaryRepository();
  await completeProductFixture(changedRoot);
  const changed = await prepareExactFixture(changedRoot);
  await writeFile(changed.appPath, changed.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', changedRoot, ['--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));
  await appendFile(changed.baselinePath, 'baseline-mutated');
  const scopeViolation = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', changedRoot, ['--json']);
  assert.equal(scopeViolation.output.blocker.code, 'AIH_VISUAL_REPAIR_SCOPE_VIOLATION', JSON.stringify(scopeViolation.output, null, 2));

  const missingRoot = await temporaryRepository();
  await completeProductFixture(missingRoot);
  const missing = await prepareExactFixture(missingRoot);
  await rm(missing.baselinePath);
  const missingSource = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', missingRoot, ['--json']);
  assert.equal(missingSource.output.status, 'BLOCKED');
  assert.equal(missingSource.output.repairPacket, undefined);
  assert.ok(codes(missingSource).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(missingSource.output, null, 2));
});

test('exact visual repair protects the Contract-owned implementation policy', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { appPath, app } = await prepareExactFixture(root);
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));

  const contractPath = resolve(root, '.agents/skills/product-design/canonical-ui-prototype/contract.yaml');
  await appendFile(contractPath, '\n# repair-policy-mutated\n');
  const scopeViolation = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(scopeViolation.output.blocker.code, 'AIH_VISUAL_REPAIR_SCOPE_VIOLATION', JSON.stringify(scopeViolation.output, null, 2));
});

test('exact visual repair requires an action report for implementation changes', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { appPath, app } = await prepareExactFixture(root);
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));

  await appendFile(appPath, '\n// unreported repair\n');
  const missingReport = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(missingReport.output.status, 'BLOCKED');
  assert.ok(codes(missingReport).has('AIH_VISUAL_REPAIR_ACTION_INVALID'), JSON.stringify(missingReport.output, null, 2));

  const invalidReport = await writeRepairAction(requested, [appPath]);
  invalidReport.actions[0].sourceEvidenceItemIds = ['EVIDENCE-UNKNOWN'];
  const packet = JSON.parse(await readFile(requested.output.repairPacket, 'utf8'));
  await writeFile(packet.actionReportPath, JSON.stringify(invalidReport, null, 2) + '\n', 'utf8');
  const wrongEvidence = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(wrongEvidence.output.status, 'BLOCKED');
  assert.ok(codes(wrongEvidence).has('AIH_VISUAL_REPAIR_ACTION_INVALID'), JSON.stringify(wrongEvidence.output, null, 2));
});

test('exact visual repair blocks non-visual failures and exhausts after three implementation attempts', async () => {
  const nonVisualRoot = await temporaryRepository();
  await completeProductFixture(nonVisualRoot);
  const nonVisual = await prepareExactFixture(nonVisualRoot);
  await writeFile(
    nonVisual.appPath,
    nonVisual.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;') + "\nconsole.error('repair-nonvisual');\n",
  );
  const nonVisualResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', nonVisualRoot, ['--json']);
  assert.equal(nonVisualResult.output.status, 'BLOCKED');
  assert.equal(nonVisualResult.output.repairPacket, undefined);
  assert.ok(codes(nonVisualResult).has('AIH_CANONICAL_UI_CONSOLE_FAILED'), JSON.stringify(nonVisualResult.output, null, 2));

  const exhaustedRoot = await temporaryRepository();
  await completeProductFixture(exhaustedRoot);
  const exhausted = await prepareExactFixture(exhaustedRoot);
  await writeFile(exhausted.appPath, exhausted.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const first = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--json']);
  assert.equal(first.output.attempt, 1, JSON.stringify(first.output, null, 2));
  let result = first;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await appendFile(exhausted.appPath, '\n// repair attempt ' + attempt + '\n');
    await writeRepairAction(result, [exhausted.appPath], 'paint');
    result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--json']);
  }
  assert.equal(result.output.status, 'BLOCKED', JSON.stringify(result.output, null, 2));
  assert.match(result.stderr, /AIH_VISUAL_REPAIR_EXHAUSTED/);
  assert.equal(result.output.attempts.length, 3);
  assert.ok(result.output.attempts.every((item) => item.failures.every((failure) => (
    failure.actualScreenshot
    && failure.differenceScreenshot
  ))));
  assert.ok(result.output.attempts.every((item) => item.failures.some((failure) => (
    failure.checkKind === 'screenshot-match'
    && typeof failure.differenceRatio === 'number'
  ))));
  assert.ok(result.output.attempts.every((item) => item.actions.length > 0));
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

test('browser validator skips accessibility checks when the user did not select them', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  delete model.accessibility;
  await writeCanonical(path, model);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app.replace('              >\n                模拟错误\n              </button>', '              >\n              </button>'));
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED'), false, JSON.stringify(result.output, null, 2));
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
