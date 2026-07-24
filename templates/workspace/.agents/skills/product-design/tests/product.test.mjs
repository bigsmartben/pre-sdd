import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { stringify as stringifyYaml } from 'yaml';
import { cleanupTemporaryRepositories, codes, runScript, temporaryRepository } from './helpers/fixture.mjs';
import { completeProductFixture, fixtureProject, readArtifact, writeArtifact } from './helpers/product-fixture.mjs';
import { migrateLegacyWireflowDirectory } from '../scripts/lib/migrate-legacy-wireflow.mjs';
import { canonicalLocks, reviewEvidenceDirectory } from '../canonical-ui-prototype/scripts/integrity.mjs';
import { loadReviewFeedback, reviewIdentity } from '../canonical-ui-prototype/scripts/review.mjs';
import { verifyVisualAcceptance, visualAcceptanceRecordPath } from '../canonical-ui-prototype/scripts/visual-acceptance.mjs';

test.after(cleanupTemporaryRepositories);

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  return '{' + Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
    .join(',') + '}';
}

function confirmationSha256(confirmation) {
  const payload = { ...confirmation };
  delete payload.sha256;
  return sha256(Buffer.from(canonicalJson(payload), 'utf8'));
}

async function canonicalFixture(root) {
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const areaPath = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root, 'ACTOR-001');
  const path = resolve(areaPath, 'src/spec/canonical-ui.ts');
  const text = await readFile(path, 'utf8');
  const match = text.match(/^export const canonicalUi = ([\s\S]+) as const;\s*$/);
  assert.ok(match, 'canonical-ui.ts must remain a static object literal');
  return { areaPath, path, model: JSON.parse(match[1]) };
}

async function writeCanonical(path, model) {
  await writeFile(path, 'export const canonicalUi = ' + JSON.stringify(model, null, 2) + ' as const;\n');
}

function removeFigmaComponentBindings(model) {
  model.componentInventory = [];
  model.componentMappings = [];
  model.componentVariantDefinitions = [];
  model.componentVariantCoverage = [];
  model.componentSourceParityAssertions = [];
  const removedAxisIds = new Set(model.stateAxes.filter((axis) => axis.kind === 'variant').map((axis) => axis.id));
  model.stateAxes = model.stateAxes.filter((axis) => !removedAxisIds.has(axis.id));
  const remainingEntries = new Map();
  for (const entry of model.stateMatrix) {
    const migrated = structuredClone(entry);
    for (const axisId of removedAxisIds) delete migrated.values[axisId];
    const key = migrated.componentContractId + '/' + JSON.stringify(
      Object.entries(migrated.values).sort(([left], [right]) => left.localeCompare(right)),
    );
    const previous = remainingEntries.get(key);
    if (!previous || (previous.id.includes('-BUSY') && !migrated.id.includes('-BUSY'))) {
      remainingEntries.set(key, migrated);
    }
  }
  model.stateMatrix = [...remainingEntries.values()];
  for (const contract of model.componentContracts) {
    delete contract.mappingId;
    contract.figmaInstanceNodeIds = [];
    const variantCoverage = contract.stateAxisCoverage.find((item) => item.kind === 'variant');
    Object.assign(variantCoverage, {
      status: 'not-applicable',
      reason: 'Provider-neutral fixture has no Figma Variant axis.',
    });
    for (const instance of contract.pageInstances) {
      instance.origin = 'local';
      delete instance.figmaInstanceNodeId;
    }
  }
}

const exactVisualAspects = ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'];

function configureStaticExactParity(model) {
  model.visualPolicy = {
    mode: 'exact',
    selectedBy: 'user-explicit',
    aspects: exactVisualAspects,
    coverage: model.designSources.flatMap((source) => source.coverage.map((coverage) => ({
      sourceId: source.id,
      ...structuredClone(coverage),
    }))),
  };
  model.sourceParityAssertions = [
    ...model.routes.flatMap((route) => model.viewports.map((viewport) => ({
      id: 'PARITY-EXACT-' + route.id + '-' + viewport.id,
      sourceId: model.designSources[0].id,
      routeId: route.id,
      viewportId: viewport.id,
      baselineEvidenceItemId: 'EVIDENCE-SCREENSHOT-001',
      aspects: exactVisualAspects,
      checks: [{ kind: 'screenshot-match' }],
    }))),
    ...model.scenarios.flatMap((scenario) => scenario.viewportIds.map((viewportId) => ({
      id: 'PARITY-EXACT-' + scenario.id + '-' + viewportId,
      sourceId: model.designSources[0].id,
      routeId: scenario.routeId,
      scenarioId: scenario.id,
      viewportId,
      baselineEvidenceItemId: 'EVIDENCE-SCREENSHOT-001',
      aspects: exactVisualAspects,
      checks: [{ kind: 'screenshot-match' }],
    }))),
  ];
  model.componentSourceParityAssertions = model.componentContracts.flatMap((contract) => {
    const mapping = model.componentMappings.find((item) => item.id === contract.mappingId);
    const source = model.designSources.find((item) => item.id === mapping?.sourceId);
    const legalEntries = model.stateMatrix.filter((item) => (
      item.componentContractId === contract.id && item.classification === 'legal'
    ));
    return contract.pageInstances.filter((item) => item.origin === 'figma').flatMap((pageInstance) => {
      const viewportIds = [...new Set(
        (source?.coverage || [])
          .filter((item) => item.screenId === pageInstance.screenId)
          .flatMap((item) => item.viewportIds),
      )];
      return viewportIds.flatMap((viewportId) => legalEntries.map((entry) => ({
        id: 'COMPONENT-PARITY-' + pageInstance.id + '-' + entry.id + '-' + viewportId,
        sourceId: source.id,
        componentContractId: contract.id,
        pageInstanceId: pageInstance.id,
        stateMatrixEntryId: entry.id,
        viewportId,
        baselineEvidenceItemId: 'EVIDENCE-SCREENSHOT-001',
        aspects: exactVisualAspects,
        checks: [{ kind: 'screenshot-match' }],
      })));
    });
  });
  return model;
}

async function convertFixtureSourceToProviderNeutral(areaPath, model, kind) {
  const source = model.designSources[0];
  const evidencePath = resolve(areaPath, source.evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.kind = kind;
  evidence.location = `design-sources/${source.id}/${kind}-source`;
  delete evidence.nodeId;
  delete evidence.sourceVersion;
  evidence.items = evidence.items.filter((item) => ['screenshot', 'variable-definitions'].includes(item.role));
  const evidenceIds = new Set(evidence.items.map((item) => item.id));
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);

  source.kind = kind;
  source.location = evidence.location;
  source.evidence.sha256 = sha256(evidenceText);
  source.registration = null;
  for (const coverage of source.coverage) {
    coverage.evidenceItemIds = coverage.evidenceItemIds.filter((id) => evidenceIds.has(id));
  }
  model.assets = [];
  removeFigmaComponentBindings(model);
  return evidenceIds;
}

async function writeReviewEvidence(root, actors) {
  const evidence = {
    version: '2.0.0',
    status: 'PASS',
    reviewId: 'review-' + 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    stage: 'product-design',
    actors: actors.map((item) => ({
      actor: item.actor,
      draftVersion: item.draftVersion,
      implementationHash: item.implementationHash,
      buildInputHash: item.buildInputs.contentHash,
      reviewAddress: 'http://127.0.0.1:4173/?review=1',
      screenshots: ['fixture-review.png'],
    })),
    validation: [{ id: 'fixture-pass', status: 'PASS', blockers: [] }],
    feedbackPackets: [],
    markers: [],
  };
  const directory = reviewEvidenceDirectory(root);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'review-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}

function reviewFeedback(actor, draftVersion, issueType, markerId = 1) {
  const routing = {
    interaction: { category: 'behavior', routedTo: 'use-cases' },
    visual: { category: 'visual-input', routedTo: 'visual-spec' },
    'position-size': { category: 'implementation', routedTo: 'canonical-ui-prototype' },
    text: { category: 'implementation', routedTo: 'canonical-ui-prototype' },
  }[issueType];
  return {
    version: '1.0.0',
    kind: 'CanonicalUiReviewFeedbackPacket',
    createdAt: '2026-07-23T10:00:00.000Z',
    actor,
    draftVersion,
    pageUrl: 'http://127.0.0.1:4173/?review=1',
    pageKey: '/::SCREEN-001',
    viewport: { width: 1280, height: 720 },
    markers: [{
      id: markerId,
      issueType,
      category: routing.category,
      routedTo: routing.routedTo,
      description: 'fixture feedback ' + markerId,
      target: '[data-screen-id="SCREEN-001"]',
      rect: { x: 10, y: 20, width: 100, height: 40 },
    }],
  };
}

async function prepareExactFixture(root) {
  const { areaPath, path, model } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  const legalComponentMatrixEntries = model.stateMatrix.filter((item) => (
    item.componentContractId === 'COMPONENT-CONTRACT-001'
    && item.classification === 'legal'
  ));
  const guidedCaptureModel = structuredClone(model);
  guidedCaptureModel.componentSourceParityAssertions = legalComponentMatrixEntries.map((item) => ({
    id: 'COMPONENT-PARITY-CAPTURE-' + item.id + '-DESKTOP',
    sourceId: 'DESIGN-SOURCE-001',
    componentContractId: 'COMPONENT-CONTRACT-001',
    pageInstanceId: 'REVIEW-PRIMARY-INSTANCE',
    stateMatrixEntryId: item.id,
    viewportId: 'VIEWPORT-DESKTOP',
    baselineEvidenceItemId: 'EVIDENCE-SCREENSHOT-001',
    aspects: ['color'],
    checks: [{ kind: 'screenshot-match' }],
  }));
  await writeCanonical(path, guidedCaptureModel);
  const guidedRuntime = runScript(
    '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs',
    root,
    ['--viewport', 'VIEWPORT-DESKTOP', '--json'],
  );
  assert.equal(guidedRuntime.exitCode, 0, JSON.stringify(guidedRuntime.output, null, 2));
  const routeBaseline = guidedRuntime.output.evidence.find((item) => item.kind === 'route' && item.viewportId === 'VIEWPORT-DESKTOP').screenshot;
  const componentMatrixBaselines = guidedRuntime.output.evidence
    .filter((item) => (
      item.kind === 'repair-diagnostic'
      && item.blockerCode === 'AIH_VISUAL_PIXEL_DIAGNOSTIC'
      && item.scope?.componentContractId === 'COMPONENT-CONTRACT-001'
    ))
    .map((item) => ({
      componentContractId: item.scope.componentContractId,
      stateMatrixEntryId: item.scope.stateMatrixEntryId,
      screenshot: item.evidence.find((evidenceItem) => evidenceItem.kind === 'actual-screenshot')?.path,
    }));
  assert.equal(
    componentMatrixBaselines.length,
    legalComponentMatrixEntries.length,
  );
  assert.ok(componentMatrixBaselines.every((item) => item.screenshot));
  const scenarioBaselines = guidedRuntime.output.evidence.filter((item) => (
    item.kind === 'scenario' && item.viewportId === 'VIEWPORT-DESKTOP'
  ));
  const baselineContent = await readFile(routeBaseline);
  const baselineRelativePath = 'design-sources/DESIGN-SOURCE-001/exact-desktop.png';
  const baselinePath = resolve(areaPath, baselineRelativePath);
  await writeFile(baselinePath, baselineContent);
  const capturedComponentBaselines = await Promise.all(componentMatrixBaselines.map(async (item) => {
    const content = await readFile(item.screenshot);
    const relativePath = 'design-sources/DESIGN-SOURCE-001/exact-component-' + item.stateMatrixEntryId.toLowerCase() + '-desktop.png';
    const evidenceItemId = 'EVIDENCE-EXACT-COMPONENT-' + item.stateMatrixEntryId + '-DESKTOP';
    await writeFile(resolve(areaPath, relativePath), content);
    return { ...item, content, relativePath, evidenceItemId };
  }));
  const capturedScenarioBaselines = await Promise.all(scenarioBaselines.map(async (item) => {
    const content = await readFile(item.screenshot);
    const relativePath = 'design-sources/DESIGN-SOURCE-001/exact-' + item.scenarioId.toLowerCase() + '-desktop.png';
    const evidenceItemId = 'EVIDENCE-EXACT-' + item.scenarioId + '-DESKTOP';
    await writeFile(resolve(areaPath, relativePath), content);
    return { ...item, content, relativePath, evidenceItemId };
  }));
  const evidencePath = resolve(areaPath, model.designSources[0].evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.items.push({ id: 'EVIDENCE-EXACT-DESKTOP', role: 'screenshot', path: baselineRelativePath, sha256: sha256(baselineContent) });
  for (const item of capturedComponentBaselines) {
    evidence.items.push({
      id: item.evidenceItemId,
      role: 'screenshot',
      path: item.relativePath,
      sha256: sha256(item.content),
      sourceNodeId: '1:2',
    });
  }
  for (const item of capturedScenarioBaselines) {
    evidence.items.push({
      id: item.evidenceItemId,
      role: 'screenshot',
      path: item.relativePath,
      sha256: sha256(item.content),
      sourceNodeId: '1:2',
    });
  }
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);
  const registrationPath = resolve(areaPath, model.designSources[0].registration.path);
  const registration = JSON.parse(await readFile(registrationPath, 'utf8'));
  registration.evidenceSha256 = sha256(evidenceText);
  registration.componentHandshake[0].baselineEvidenceItemIds.push(
    ...capturedComponentBaselines.map((item) => item.evidenceItemId),
  );
  const registrationText = JSON.stringify(registration, null, 2) + '\n';
  await writeFile(registrationPath, registrationText);

  const exact = structuredClone(model);
  exact.visualPolicy = {
    mode: 'exact',
    selectedBy: 'user-explicit',
    aspects: ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'],
    coverage: [{
      sourceId: 'DESIGN-SOURCE-001',
      screenId: 'SCREEN-001',
      stateIds: exact.states.map((item) => item.id),
      viewportIds: ['VIEWPORT-DESKTOP'],
      evidenceItemIds: [
        'EVIDENCE-EXACT-DESKTOP',
        ...capturedComponentBaselines.map((item) => item.evidenceItemId),
        ...capturedScenarioBaselines.map((item) => item.evidenceItemId),
      ],
    }],
  };
  exact.designSources[0].evidence.sha256 = sha256(evidenceText);
  exact.designSources[0].registration.sha256 = sha256(registrationText);
  exact.designSources[0].coverage[0].viewportIds = ['VIEWPORT-DESKTOP'];
  exact.designSources[0].coverage[0].evidenceItemIds.push(
    'EVIDENCE-EXACT-DESKTOP',
    ...capturedComponentBaselines.map((item) => item.evidenceItemId),
    ...capturedScenarioBaselines.map((item) => item.evidenceItemId),
  );
  exact.viewports = exact.viewports.filter((item) => item.id === 'VIEWPORT-DESKTOP');
  exact.scenarios = exact.scenarios.map((item) => ({ ...item, viewportIds: ['VIEWPORT-DESKTOP'] }));
  exact.renderAssertions = exact.renderAssertions.map((item) => ({ ...item, viewportIds: ['VIEWPORT-DESKTOP'] }));
  exact.sourceParityAssertions = [
    {
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
    },
    ...capturedScenarioBaselines.map((item) => ({
      id: 'PARITY-EXACT-' + item.scenarioId + '-DESKTOP',
      sourceId: 'DESIGN-SOURCE-001',
      routeId: item.routeId,
      scenarioId: item.scenarioId,
      viewportId: 'VIEWPORT-DESKTOP',
      baselineEvidenceItemId: item.evidenceItemId,
      aspects: exact.visualPolicy.aspects,
      checks: [{ kind: 'screenshot-match' }],
    })),
  ];
  exact.componentSourceParityAssertions = capturedComponentBaselines.map((item) => ({
    id: 'COMPONENT-PARITY-' + item.stateMatrixEntryId + '-DESKTOP',
    sourceId: 'DESIGN-SOURCE-001',
    componentContractId: item.componentContractId,
    pageInstanceId: 'REVIEW-PRIMARY-INSTANCE',
    stateMatrixEntryId: item.stateMatrixEntryId,
    viewportId: 'VIEWPORT-DESKTOP',
    baselineEvidenceItemId: item.evidenceItemId,
    aspects: exact.visualPolicy.aspects,
    checks: [{ kind: 'screenshot-match' }],
  }));
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

test('generic initialization creates atomic UC and provider-neutral Visual Spec models without an independent interaction collection', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  assert.equal(stage.status, 'active');
  assert.deepEqual(Object.keys(stage.artifacts), ['capabilities', 'visual-spec', 'canonical-ui-prototype']);
  assert.equal(stage.areas['canonical-ui-prototypes'].root, 'Canonical-UI-Prototypes');
  assert.equal(stage.artifacts['html-mock'], undefined);
  const initialUseCases = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  assert.match(initialUseCases, /Product Behavior/);
  assert.match(initialUseCases, /Interaction Flow/);
  assert.match(initialUseCases, /Low-Fi UI Blueprint/);
  assert.match(initialUseCases, /尚未判断 UI 适用性/);
  assert.equal(await stat(resolve(root, stage.root, stage.artifacts.capabilities.internalModel)).then(() => true), true);
  const initialVisualSpec = await readFile(resolve(root, stage.root, stage.artifacts['visual-spec'].outputs[0].path), 'utf8');
  assert.match(initialVisualSpec, /Provider-neutral Visual Spec Intake/);
  assert.match(initialVisualSpec, /Runtime（运行环境）/);
  assert.equal(await stat(resolve(root, stage.root, stage.artifacts['visual-spec'].internalModel)).then(() => true), true);
  const prototypeRoot = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root);
  assert.deepEqual(await readdir(prototypeRoot), []);
  const templateRoot = resolve(root, '.agents/skills/product-design/canonical-ui-prototype/template');
  const source = resolve(templateRoot, 'src/spec/canonical-ui.ts');
  const canonicalSource = await readFile(source, 'utf8');
  assert.match(canonicalSource, /export const canonicalUi/);
  assert.match(canonicalSource, /viewports: \[\]/);
  assert.doesNotMatch(canonicalSource, /accessibility\s*:/);
  const main = await readFile(resolve(templateRoot, 'src/main.ts'), 'utf8');
  assert.doesNotMatch(main, /inconsistency-annotator|interaction-branch-driver/);
  const reviewShell = await readFile(resolve(templateRoot, 'src/review-shell.ts'), 'utf8');
  assert.match(reviewShell, /query\.get\(policy\.queryParameter\) === policy\.enabledValue/);
  assert.match(reviewShell, /import\('\.\/inconsistency-annotator'\)/);
  assert.match(reviewShell, /import\('\.\/interaction-branch-driver'\)/);
  const annotator = await readFile(resolve(templateRoot, 'src/inconsistency-annotator.ts'), 'utf8');
  assert.doesNotMatch(annotator, /annotate|psp-case|psp-cases|flow-review/);
  assert.match(annotator, /document\.body\.append\(document\.createElement\('inconsistency-annotator'\)\)/);
  assert.match(annotator, /position: fixed; z-index: 2147483600; top: 20px; right: 20px;/);
  assert.match(annotator, /const image = this\.captureViewport\(markers\);/);
  assert.equal((annotator.match(/navigator\.clipboard\.write/g) || []).length, 1);
  assert.match(annotator, /data-action="download"/);
  assert.match(annotator, /data-action="feedback"/);
  assert.match(annotator, /CanonicalUiReviewFeedbackPacket/);
  assert.match(annotator, /FEEDBACK_ROUTING/);
  assert.doesNotMatch(annotator, /canonical-ui-repair|repair:canonical-ui/);
  assert.match(annotator, /pageKey: string/);
  assert.match(annotator, /new MutationObserver\(this\.schedulePageRefresh\)/);
  assert.match(annotator, /querySelectorAll<HTMLElement>\('\[data-screen-id\]'\)/);
  assert.match(annotator, /marker\.pageKey === this\.currentPageKey/);
  const driver = await readFile(resolve(templateRoot, 'src/interaction-branch-driver.ts'), 'utf8');
  assert.match(driver, /data-review-tool/);
  assert.match(driver, /data-scenario-id/);
  assert.match(driver, /psp:interaction-branch-complete/);
  assert.match(canonicalSource, /classification: 'review-only'/);
  assert.match(canonicalSource, /excludedProductScopes: \['requirements', 'features', 'pages', 'controls', 'downstream-implementation'\]/);
  assert.match(canonicalSource, /protectedProductFacts: \['use-cases', 'interaction-flows', 'visual-spec'\]/);
  assert.doesNotMatch(canonicalSource, /annotate|flow-review/);
  const runtime = await readFile(resolve(root, '.agents/skills/product-design/canonical-ui-prototype/scripts/runtime.mjs'), 'utf8');
  assert.match(runtime, /server\.resolvedUrls\?\.local\?\.\[0\]/);
  assert.match(runtime, /searchParams\.set\('review', '0'\)/);
  assert.doesNotMatch(runtime, /annotate|flow-review/);
  assert.doesNotMatch(runtime, /runRepairGate|runReviewReadiness|executeRegisteredCommand/);
  assert.match(runtime, /独立应用正式预览地址/);
  const manifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  assert.equal(manifest.validationProfiles.some((item) => item.id === 'canonical-ui-review-readiness'), true);
  const skill = await readFile(resolve(root, '.agents/skills/product-design/SKILL.md'), 'utf8');
  assert.match(skill, /AIH_CANONICAL_UI_SERVER_FAILED/);
  assert.match(skill, /不得根据默认端口猜测或伪造地址/);
  assert.ok((await stat(resolve(templateRoot, 'public/vendor/html2canvas-1.4.1.min.js'))).isFile());
});

test('browser validator keeps 17 product pages clean in review=0 and loads all Review Tools in review=1', async () => {
  const dependencyRequire = createRequire(process.env.PRE_SDD_DEPENDENCY_ENTRY || import.meta.url);
  const [{ createServer }, { default: playwright }] = await Promise.all([
    import('vite'),
    import('@playwright/test'),
  ]);
  const temporary = await mkdtemp(resolve(tmpdir(), 'psp-review-boundary-'));
  const appRoot = resolve(temporary, 'app');
  const templateRoot = resolve(import.meta.dirname, '../canonical-ui-prototype/template');
  await cp(templateRoot, appRoot, { recursive: true });
  const canonicalPath = resolve(appRoot, 'src/spec/canonical-ui.ts');
  const original = await readFile(canonicalPath, 'utf8');
  const routes = Array.from({ length: 17 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    const path = index === 0 ? '/' : `/page-${number}`;
    return `    { id: 'ROUTE-${number}', path: '${path}', screenId: 'SCREEN-001' },`;
  }).join('\n');
  const scenarios = Array.from({ length: 17 }, (_, index) => {
    const number = String(index + 1).padStart(3, '0');
    return `    { id: 'SCENARIO-${number}', useCaseId: 'UC-NNN', interactionFlowIds: ['IF-NNN'], transitionIds: ['IF-NNN-TRANS-NN'], recoveryStateIds: [], routeId: 'ROUTE-${number}', initialStateIds: ['INT-STATE-NNN', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-001'], expectedStateIds: ['COMPONENT-STATE-SUCCESS'], viewportIds: [] },`;
  }).join('\n');
  const expanded = original
    .replace(
      /  routes: \[\n[\s\S]*?\n  \],\n  screens:/,
      `  routes: [\n${routes}\n  ],\n  screens:`,
    )
    .replace(
      /  scenarios: \[\n[\s\S]*?\n  \],\n  viewports:/,
      `  scenarios: [\n${scenarios}\n  ],\n  viewports:`,
    );
  assert.notEqual(expanded, original);
  await writeFile(canonicalPath, expanded);

  const server = await createServer({
    root: appRoot,
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: [
        { find: 'lit', replacement: dependencyRequire.resolve('lit') },
        { find: 'msw/browser', replacement: dependencyRequire.resolve('msw/browser') },
        { find: 'msw', replacement: dependencyRequire.resolve('msw') },
      ],
    },
    server: { host: '127.0.0.1', port: 0 },
  });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext();
    const extensionCode = "export default {async activate(){const node=document.createElement('div');node.dataset.reviewTool='mockcase';document.body.append(node);return {dispose(){node.remove()}}}}";
    const descriptor = {
      id: 'mockcase',
      apiVersion: 'psp.review-extension/v1',
      moduleUrl: `data:text/javascript;base64,${Buffer.from(extensionCode).toString('base64')}`,
      integrity: sha256(Buffer.from(extensionCode)),
    };
    await context.addInitScript((value) => {
      Object.defineProperty(globalThis, '__PSP_REVIEW_EXTENSIONS__', {
        value: Object.freeze([Object.freeze(value)]),
        configurable: false,
        writable: false,
      });
    }, descriptor);
    const page = await context.newPage();
    for (let index = 0; index < 17; index += 1) {
      const number = String(index + 1).padStart(3, '0');
      const path = index === 0 ? '/' : `/page-${number}`;
      await page.goto(`${base}${path}?review=0`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('psp-app').count(), 1, path);
      assert.equal(await page.locator('[data-review-tool]').count(), 0, path);
    }
    for (let index = 0; index < 17; index += 1) {
      const number = String(index + 1).padStart(3, '0');
      const path = index === 0 ? '/' : `/page-${number}`;
      await page.goto(`${base}${path}?review=1`, { waitUntil: 'networkidle' });
      assert.equal(await page.locator('[data-review-tool]').count(), 3, path);
      const driver = page.locator('[data-review-tool="interaction-branch-driver"]');
      await driver.locator(`[data-scenario-id="SCENARIO-${number}"]`).click();
      await driver.locator('[role="status"]').filter({ hasText: '已达到声明的最终状态' }).waitFor();
    }
    await context.close();
  } finally {
    if (browser) await browser.close();
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('Use Cases validator blocks invalid actors, startsAt references, and duplicate identifiers', async () => {
  const cases = [
    {
      mutate(data) { data.useCases[0].actor = 'ACTOR-999'; },
      message: /Actor 引用不存在：ACTOR-999/,
    },
    {
      mutate(data) { data.useCases[0].alternateScenarios[0].startsAt = 'UC-001-STEP-99'; },
      message: /startsAt 未引用当前 Use Case 主步骤：UC-001-STEP-99/,
    },
    {
      mutate(data) { data.actors.push({ ...data.actors[0], name: '重复参与者' }); },
      message: /标识重复：ACTOR-001/,
    },
  ];

  for (const invalidCase of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    invalidCase.mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
    assert.match(result.output.blockers.map((item) => item.message).join('\n'), invalidCase.message);
  }
});

test('Use Cases readiness detects drift in UC.md', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const uc = stage.artifacts.capabilities.outputs[0];
  await appendFile(resolve(root, stage.root, uc.path), '\nmanual use case edit\n');
  const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.ok(codes(result).has('AIH_GENERATED_DRIFT'));
});

test('Visual Spec has independent apply, readiness, UC references, Variant coverage, asset integrity, and deterministic projection', async () => {
  const blockedRoot = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', blockedRoot, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const blockedProject = await fixtureProject(blockedRoot);
  const blockedStage = blockedProject.stages['product-design'];
  const blockedVisual = await readArtifact(blockedRoot, blockedStage, blockedStage.artifacts['visual-spec']);
  const blockedApply = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', blockedRoot, [
    '--operation', 'apply-visual-spec', '--artifact', 'visual-spec', '--input', blockedVisual.path, '--json',
  ]);
  assert.ok(codes(blockedApply).has('AIH_UPSTREAM_NOT_READY'));

  const root = await temporaryRepository();
  await completeProductFixture(root);
  const ready = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts['visual-spec'];
  const visual = await readArtifact(root, stage, binding);
  const applied = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-visual-spec', '--artifact', 'visual-spec', '--input', visual.path, '--dry-run', '--json',
  ]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));
  assert.deepEqual(applied.output.targets.sort(), [
    stage.root + '/' + binding.internalModel,
    stage.root + '/' + binding.outputs[0].path,
  ].sort());
  const markdownPath = resolve(root, stage.root, binding.outputs[0].path);
  const markdown = await readFile(markdownPath, 'utf8');
  assert.match(markdown, /Pages 与 Renderings/);
  assert.match(markdown, /emphasis=primary\/secondary/);
  assert.match(markdown, /assets\/status\.svg/);

  visual.data.pages[0].useCaseRefs = ['UC-999'];
  await writeArtifact(visual);
  const unresolved = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(unresolved).has('AIH_REFERENCE_UNRESOLVED'));

  visual.data.pages[0].useCaseRefs = ['UC-001'];
  visual.data.components[0].visualCases.pop();
  await writeArtifact(visual);
  const incomplete = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(incomplete).has('AIH_ARTIFACT_INCOMPLETE'));

  visual.data.components[0].visualCases.push({
    id: 'VISUAL-CASE-006', name: 'INT-STATE-003 secondary', interactionStateRef: 'INT-STATE-003',
    variants: [{ name: 'emphasis', value: 'secondary' }], visual: structuredClone(visual.data.components[0].visualCases[0].visual),
  });
  await writeArtifact(visual);
  await appendFile(resolve(root, stage.root, 'assets/status.svg'), '<!-- drift -->\n');
  const integrity = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(integrity).has('AIH_SOURCE_INTEGRITY_FAILED'));

  await appendFile(markdownPath, 'manual drift\n');
  const drift = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(drift).has('AIH_GENERATED_DRIFT'));
});

test('atomic UC readiness covers behavior, flow, Low-Fi, failure recovery, and deterministic projection', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const markdown = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  assert.match(markdown, /Product Behavior（产品行为）/);
  assert.match(markdown, /Interaction Flow（正式交互流程）/);
  assert.match(markdown, /Low-Fi UI Blueprints/);
  assert.match(markdown, /失败、重试、恢复与返回/);
  assert.match(markdown, /UC-001-EXC-01-STEP-01/);
  assert.match(markdown, /LF-SCREEN-001/);
  assert.match(markdown, /IF-001-TRANS-01、IF-001-TRANS-02/);
  assert.match(markdown, /规格引用无效；Package 中存在无法解析的引用/);
  assert.match(markdown, /<summary>查看 Transition 与 UC 步骤追溯<\/summary>/);
  assert.match(markdown, /Interaction State Catalog（交互状态目录）/);
  assert.match(markdown, /<summary>查看完整状态定义<\/summary>/);
  assert.doesNotMatch(markdown, /派生行为摘要/);
  assert.doesNotMatch(markdown, /#### Business Rules（业务规则）/);
  assert.doesNotMatch(markdown, /\| 用户动作 \| 系统响应 \|/);
  assert.equal(markdown.match(/只有结构与引用全部有效的 Package 才能通过验证/g)?.length, 1);
  assert.equal(markdown.match(/规格作者可以提交验证请求/g)?.length, 1);
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
  const check = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--check', '--json']);
  assert.equal(check.exitCode, 0, JSON.stringify(check.output, null, 2));
});

test('atomic UC readiness blocks incomplete flow, traceability, blueprint, and exception recovery', async () => {
  const cases = [
    {
      mutate(data) { data.interactionFlows = []; },
      message: /UI Use Case 必须且只能有一个正式 Interaction Flow/,
    },
    {
      mutate(data) { data.interactionFlows[0].transitions[0].useCaseStepRefs = ['UC-001-EXC-01-STEP-01']; },
      message: /Use Case step 引用不存在|Use Case 步骤未追溯到 Transition/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints = []; },
      message: /UI Use Case 必须映射到至少一个 Low-Fi Screen/,
    },
    {
      mutate(data) { data.interactionFlows[0].transitions[1].failureResponse = null; },
      message: /异常场景必须正式声明失败、重试、恢复与返回决定/,
    },
  ];
  for (const invalidCase of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    invalidCase.mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
    assert.match(result.output.blockers.map((item) => item.message).join('\n'), invalidCase.message);
  }
});

test('atomic UC schema rejects duplicated derived facts', async () => {
  const cases = [
    (data) => { data.businessRules[0].appliesTo = ['UC-001']; },
    (data) => { data.interactionFlows[0].coveredScenarios = ['main', 'UC-001-EXC-01']; },
    (data) => { data.interactionFlows[0].transitions[0].userAction = '提交验证'; },
    (data) => { data.interactionFlows[0].transitions[0].systemResponse = '显示结果'; },
    (data) => { data.interactionFlows[0].transitions[1].failureResponse.failure = '引用无效'; },
    (data) => { data.lowFiUiBlueprints[0].useCases = ['UC-001']; },
  ];
  for (const mutate of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.ok(codes(result).has('AIH_ARTIFACT_SCHEMA_FAILED'), JSON.stringify(result.output, null, 2));
  }
});

test('atomic UC closure validates rules, states, actors, Screens, and Control traceability', async () => {
  const cases = [
    {
      mutate(data) { data.businessRules.push({ id: 'BR-002', statement: '未引用规则' }); },
      message: /Business Rule 未被任何 Use Case 引用：BR-002/,
    },
    {
      mutate(data) { data.interactionStates.push({ id: 'INT-STATE-004', name: '孤立状态', type: 'waiting', description: '未进入任何流程', terminal: false }); },
      message: /Interaction State 未被任何 Interaction Flow 使用：INT-STATE-004/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints[0].screens[0].regions[1].controls[0].transitionRefs = []; },
      message: /可交互 Low-Fi Control 必须追溯至少一个 Transition/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints[0].screens[0].regions[1].controls[0].transitionRefs = ['IF-999-TRANS-01']; },
      message: /Transition 引用不存在：IF-999-TRANS-01/,
    },
    {
      mutate(data) {
        data.actors.push({ id: 'ACTOR-002', name: '其他角色', goal: '执行其他验证' });
        data.useCases[0].actor = 'ACTOR-002';
      },
      message: /Low-Fi Control 引用了其他 Actor 的 Transition/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints[0].screens[0].useCases = []; },
      message: /Low-Fi Control 引用的 Transition 不属于当前 Screen 的 Use Case/,
    },
    {
      mutate(data) {
        data.actors.push({ id: 'ACTOR-002', name: '其他角色', goal: '执行其他验证' });
        data.useCases.push({
          id: 'UC-002', name: '执行其他验证', actor: 'ACTOR-002', goal: '完成其他验证', value: '获得结果', trigger: '角色请求验证',
          preconditions: [], successOutcome: '显示成功', minimumGuarantee: '保留输入', uiApplicability: { mode: 'required', reason: null },
          mainScenario: [{ id: 'UC-002-STEP-01', initiator: 'actor', action: '提交其他验证', outcome: '系统显示结果' }],
          alternateScenarios: [], businessRules: ['BR-001'], relationships: [],
        });
        data.interactionFlows.push({
          id: 'IF-002', useCase: 'UC-002', name: '其他验证', entryState: 'INT-STATE-001', completionStates: ['INT-STATE-002'],
          transitions: [{ id: 'IF-002-TRANS-01', scenarioRef: 'main', useCaseStepRefs: ['UC-002-STEP-01'], from: 'INT-STATE-001', to: 'INT-STATE-002', guard: null, branchLabel: null, failureResponse: null }],
        });
      },
      message: /共享 Interaction State 只能用于同一 Actor 的 Use Case/,
    },
  ];
  for (const invalidCase of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    invalidCase.mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
    assert.match(result.output.blockers.map((item) => item.message).join('\n'), invalidCase.message);
  }
});

test('system-initiated Transition does not require a Low-Fi Control reference', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
  artifact.data.lowFiUiBlueprints[0].screens[0].regions[1].controls[0].transitionRefs = ['IF-001-TRANS-01'];
  await writeArtifact(artifact);
  const rendered = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.output, null, 2));
  const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
});

test('atomic UC transitions require runnable UI HTML branch and recovery coverage', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const missingBranch = structuredClone(model);
  for (const scenario of missingBranch.scenarios) scenario.transitionIds = ['IF-001-TRANS-01'];
  await writeCanonical(path, missingBranch);
  const branch = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(branch).has('AIH_CANONICAL_UI_FLOW_COVERAGE_FAILED'));

  const missingRecovery = structuredClone(model);
  missingRecovery.scenarios.find((item) => item.id === 'SCENARIO-003').recoveryStateIds = [];
  await writeCanonical(path, missingRecovery);
  const recovery = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(recovery).has('AIH_CANONICAL_UI_FLOW_COVERAGE_FAILED'));
});

test('non-UI Use Case is explicit and requires neither flow nor Low-Fi blueprint', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
  artifact.data.useCases[0].uiApplicability = { mode: 'not-applicable', reason: '该用例由离线批处理完成，不提供用户界面。' };
  artifact.data.interactionStates = [];
  artifact.data.interactionFlows = [];
  artifact.data.lowFiUiBlueprints = [];
  await writeArtifact(artifact);
  const render = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
  const markdown = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  assert.match(markdown, /不适用（该用例由离线批处理完成，不提供用户界面。/);
});

test('legacy Wireflow is accepted only as a one-time input and converts into the atomic UC model', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
  const candidate = structuredClone(artifact.data);
  for (const useCase of candidate.useCases) delete useCase.uiApplicability;
  delete candidate.interactionStates;
  delete candidate.interactionFlows;
  delete candidate.lowFiUiBlueprints;
  const legacyRoot = resolve(root, 'legacy-wireflow-input');
  await mkdir(resolve(legacyRoot, 'ACTOR-001'), { recursive: true });
  const stateDelta = { show: ['REGION-001'], hide: [], enable: ['CONTROL-001'], disable: [], content: [] };
  const legacy = {
    apiVersion: 'psp.dev/v1',
    kind: 'WireflowMidSpecification',
    metadata: { status: 'ready', version: '1.0.0', upstreamArtifact: 'capabilities', actor: 'ACTOR-001' },
    siteMap: { entryScreen: 'SCREEN-001', nodes: [{ screen: 'SCREEN-001', parent: null }] },
    screens: [{
      id: 'SCREEN-001', name: '规格检查页', purpose: '提交并查看结果', useCases: ['UC-001'],
      layoutTree: { type: 'vertical', children: [{ type: 'region', region: 'REGION-001' }] },
      regions: [{ id: 'REGION-001', name: '验证区', purpose: '操作与反馈', content: ['验证结果'], controls: [{ id: 'CONTROL-001', type: 'action', label: '验证', purpose: '提交验证', dataBinding: null, action: 'validate' }] }],
    }],
    interactionStates: [
      { id: 'WF-STATE-001', screen: 'SCREEN-001', type: 'default', condition: '等待验证', stateDelta, terminal: false },
      { id: 'WF-STATE-002', screen: 'SCREEN-001', type: 'success', condition: '验证通过', stateDelta, terminal: true },
      { id: 'WF-STATE-003', screen: 'SCREEN-001', type: 'error', condition: '验证失败', stateDelta, terminal: true },
    ],
    wireflows: [{
      id: 'WF-001', useCase: 'UC-001', name: '验证规格', coveredScenarios: ['main', 'UC-001-EXC-01'],
      entry: { screen: 'SCREEN-001', state: 'WF-STATE-001' }, completionStates: ['WF-STATE-002', 'WF-STATE-003'],
      steps: [
        { id: 'WF-001-STEP-01', scenarioRef: 'main', useCaseStepRefs: ['UC-001-STEP-01'], from: { screen: 'SCREEN-001', state: 'WF-STATE-001' }, trigger: { event: 'validate', control: 'CONTROL-001' }, guard: '有效', branchLabel: '成功', to: { screen: 'SCREEN-001', state: 'WF-STATE-002' } },
        { id: 'WF-001-STEP-02', scenarioRef: 'UC-001-EXC-01', useCaseStepRefs: ['UC-001-EXC-01-STEP-01'], from: { screen: 'SCREEN-001', state: 'WF-STATE-001' }, trigger: { event: 'validate', control: 'CONTROL-001' }, guard: '引用无效', branchLabel: '失败', to: { screen: 'SCREEN-001', state: 'WF-STATE-003' } },
      ],
    }],
    gates: [],
    gaps: [],
  };
  await writeFile(resolve(legacyRoot, 'ACTOR-001', 'wireflow-mid.yaml'), stringifyYaml(legacy));
  const migrated = await migrateLegacyWireflowDirectory(candidate, legacyRoot);
  const schema = JSON.parse(await readFile(resolve(root, '.agents/skills/product-design/capabilities/schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  assert.equal(validate(migrated), true, JSON.stringify(validate.errors));
  assert.equal(migrated.interactionFlows[0].id, 'IF-001');
  assert.equal(migrated.interactionFlows[0].transitions[1].failureResponse.returnToState, 'INT-STATE-001');
  assert.equal(migrated.lowFiUiBlueprints[0].screens[0].id, 'LF-SCREEN-001');
  assert.deepEqual(migrated.lowFiUiBlueprints[0].screens[0].regions[0].controls[0].transitionRefs, ['IF-001-TRANS-01', 'IF-001-TRANS-02']);
  assert.equal('coveredScenarios' in migrated.interactionFlows[0], false);
  assert.equal('userAction' in migrated.interactionFlows[0].transitions[0], false);
  assert.equal('failure' in migrated.interactionFlows[0].transitions[1].failureResponse, false);
  assert.equal('wireflows' in migrated, false);

  legacy.screens[0].regions[0].controls.push({ ...legacy.screens[0].regions[0].controls[0] });
  await writeFile(resolve(legacyRoot, 'ACTOR-001', 'wireflow-mid.yaml'), stringifyYaml(legacy));
  await assert.rejects(
    migrateLegacyWireflowDirectory(candidate, legacyRoot),
    (error) => error.code === 'AIH_REFERENCE_UNRESOLVED' && /Control ID 重复/.test(error.message),
  );
});

test('canonical-ui.ts remains an internal machine index with only a deterministic hidden JSON projection', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts['canonical-ui-prototype'];
  const hidden = await readFile(resolve(root, stage.root, binding.memberProjections[0].root, 'ACTOR-001', binding.memberProjections[0].member), 'utf8');
  assert.equal(binding.memberProjections.length, 1);
  assert.equal(binding.memberProjections[0].role, 'generated-support');
  assert.match(hidden, /"screens":/);
  assert.match(hidden, /"draft":/);
  assert.equal(runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--check', '--json']).exitCode, 0);
});

test('Canonical UI actor directories remain independent packages and build separately', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const appsRoot = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root);
  await cp(resolve(appsRoot, 'ACTOR-001'), resolve(appsRoot, 'ACTOR-002'), { recursive: true });
  const actorTwoSource = resolve(appsRoot, 'ACTOR-002', 'src/spec/canonical-ui.ts');
  await writeFile(actorTwoSource, (await readFile(actorTwoSource, 'utf8')).replace('"actor": "ACTOR-001"', '"actor": "ACTOR-002"'));
  for (const actor of ['ACTOR-001', 'ACTOR-002']) {
    assert.ok((await stat(resolve(appsRoot, actor, 'package.json'))).isFile());
    assert.ok((await stat(resolve(appsRoot, actor, 'index.html'))).isFile());
  }
  const built = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/runtime.mjs', root, ['--capability', 'build']);
  assert.equal(built.exitCode, 0, JSON.stringify(built.output, null, 2));
  assert.match(built.output.stdout, /ACTOR-001 独立应用构建通过/);
  assert.match(built.output.stdout, /ACTOR-002 独立应用构建通过/);
  assert.ok((await stat(resolve(appsRoot, 'ACTOR-001', 'dist', 'index.html'))).isFile());
  assert.ok((await stat(resolve(appsRoot, 'ACTOR-002', 'dist', 'index.html'))).isFile());
});

test('strict validation separates workflow state from component state and checks traceability', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));

  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const source = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root, 'ACTOR-001', 'src/spec/canonical-ui.ts');
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

test('Canonical UI input gate exact component source parity closes every Figma page, viewport, and legal matrix tuple exactly once', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  configureStaticExactParity(model);
  const expectedCount = model.componentContracts.flatMap((contract) => (
    contract.pageInstances.filter((item) => item.origin === 'figma').flatMap((pageInstance) => {
      const mapping = model.componentMappings.find((item) => item.id === contract.mappingId);
      const source = model.designSources.find((item) => item.id === mapping.sourceId);
      const viewportIds = [...new Set(
        source.coverage
          .filter((item) => item.screenId === pageInstance.screenId)
          .flatMap((item) => item.viewportIds),
      )];
      const legalEntries = model.stateMatrix.filter((item) => (
        item.componentContractId === contract.id && item.classification === 'legal'
      ));
      return viewportIds.flatMap((viewportId) => legalEntries.map((entry) => (
        contract.id + '/' + pageInstance.id + '/' + entry.id + '/' + viewportId
      )));
    })
  )).length;
  assert.equal(model.componentSourceParityAssertions.length, expectedCount);
  const schema = JSON.parse(await readFile(resolve(root, '.agents/skills/product-design/canonical-ui-prototype/schema.json'), 'utf8'));
  assert.equal(schema.properties.componentSourceParityAssertions.uniqueItems, true);

  await writeCanonical(path, model);
  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const complete = structuredClone(model);
  model.componentSourceParityAssertions.pop();
  await writeCanonical(path, model);
  const missing = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(missing).has('AIH_VISUAL_SOURCE_INCOMPLETE'), JSON.stringify(missing.output, null, 2));
  assert.ok(missing.output.blockers.some((item) => item.message.includes('实际 0 条')));

  const duplicate = structuredClone(complete);
  duplicate.componentSourceParityAssertions.push({
    ...duplicate.componentSourceParityAssertions[0],
    id: 'COMPONENT-PARITY-DUPLICATE',
  });
  await writeCanonical(path, duplicate);
  const duplicated = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(duplicated).has('AIH_VISUAL_SOURCE_INCOMPLETE'), JSON.stringify(duplicated.output, null, 2));
  assert.ok(duplicated.output.blockers.some((item) => item.message.includes('实际 2 条')));

  for (const [field, value] of [
    ['componentContractId', 'COMPONENT-CONTRACT-999'],
    ['pageInstanceId', 'REVIEW-UNKNOWN-INSTANCE'],
    ['stateMatrixEntryId', 'STATE-MATRIX-UNKNOWN'],
    ['viewportId', 'VIEWPORT-UNKNOWN'],
  ]) {
    const invalidModel = structuredClone(complete);
    invalidModel.componentSourceParityAssertions[0][field] = value;
    await writeCanonical(path, invalidModel);
    const invalid = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
    assert.ok(codes(invalid).has('AIH_VISUAL_SOURCE_INCOMPLETE'), field + ': ' + JSON.stringify(invalid.output, null, 2));
    assert.ok(invalid.output.blockers.some((item) => item.message.includes('Contract / Figma Page / 合法 Matrix / Viewport') || item.message.includes('闭合到可用 Figma Registration')));
  }
});

test('Canonical UI input gate Review evidence binds a real address to the frozen Draft', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  model.visualPolicy = { mode: 'autonomous', selectedBy: 'default-policy', aspects: [], coverage: [] };
  model.designSources = [];
  model.assets = [];
  model.tokens = [];
  model.sourceParityAssertions = [];
  removeFigmaComponentBindings(model);
  await writeCanonical(path, model);
  const rendered = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.output, null, 2));
  const reviewed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/review.mjs', root, ['--json']);
  assert.equal(reviewed.exitCode, 0, JSON.stringify(reviewed.output, null, 2));
  assert.match(reviewed.output.actors[0].reviewAddress, /^http:\/\/127\.0\.0\.1:[0-9]+\/\?review=1$/);
  const evidence = JSON.parse(await readFile(reviewed.output.reviewEvidence, 'utf8'));
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.version, '2.0.0');
  assert.equal(evidence.actors[0].draftVersion, '1.0.0');
  assert.ok(evidence.actors[0].screenshots.length > 0);
  assert.deepEqual(evidence.feedbackPackets, []);
  assert.deepEqual(evidence.markers, []);
  assert.equal((await fixtureProject(root)).stages['product-design'].status, 'active');
});

test('Review Feedback Packets validate, reject stale or misrouted input, and normalize CLI order', async () => {
  const root = await temporaryRepository();
  const locks = [{ actor: 'ACTOR-001', draftVersion: '1.0.0' }];
  const manifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  const operation = manifest.operations.find((item) => item.id === 'canonical-ui-review');
  const firstPath = resolve(root, 'feedback-first.json');
  const equivalentFirstPath = resolve(root, 'feedback-first-minified.json');
  const secondPath = resolve(root, 'feedback-second.json');
  const firstPacket = reviewFeedback('ACTOR-001', locks[0].draftVersion, 'interaction', 1);
  await writeFile(firstPath, JSON.stringify(firstPacket, null, 2) + '\n');
  await writeFile(equivalentFirstPath, JSON.stringify(firstPacket));
  await writeFile(secondPath, JSON.stringify(reviewFeedback('ACTOR-001', locks[0].draftVersion, 'position-size', 2), null, 2) + '\n');

  const forward = await loadReviewFeedback(root, operation, locks, [firstPath, secondPath]);
  const reversed = await loadReviewFeedback(root, operation, locks, [secondPath, firstPath]);
  const equivalent = await loadReviewFeedback(root, operation, locks, [equivalentFirstPath, secondPath]);
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, equivalent);
  assert.equal(forward.feedbackPackets.length, 2);
  assert.equal(forward.markers.length, 2);
  assert.equal(
    reviewIdentity(operation.evidenceVersion, locks, forward),
    reviewIdentity(operation.evidenceVersion, locks, reversed),
  );

  const stalePath = resolve(root, 'feedback-stale.json');
  await writeFile(stalePath, JSON.stringify(reviewFeedback('ACTOR-001', '9.9.9', 'text'), null, 2) + '\n');
  await assert.rejects(
    loadReviewFeedback(root, operation, locks, [stalePath]),
    (error) => error.code === 'AIH_CANONICAL_UI_FEEDBACK_STALE',
  );

  const wrongActorPath = resolve(root, 'feedback-wrong-actor.json');
  await writeFile(wrongActorPath, JSON.stringify(reviewFeedback('ACTOR-999', locks[0].draftVersion, 'text'), null, 2) + '\n');
  await assert.rejects(
    loadReviewFeedback(root, operation, locks, [wrongActorPath]),
    (error) => error.code === 'AIH_CANONICAL_UI_FEEDBACK_STALE',
  );

  const invalidPath = resolve(root, 'feedback-invalid.json');
  await writeFile(invalidPath, '{"not":"a feedback packet"}\n');
  await assert.rejects(
    loadReviewFeedback(root, operation, locks, [invalidPath]),
    (error) => error.code === 'AIH_CANONICAL_UI_FEEDBACK_PACKET_INVALID',
  );

  const misrouted = reviewFeedback('ACTOR-001', locks[0].draftVersion, 'interaction');
  misrouted.markers[0].routedTo = 'visual-spec';
  const misroutedPath = resolve(root, 'feedback-misrouted.json');
  await writeFile(misroutedPath, JSON.stringify(misrouted, null, 2) + '\n');
  await assert.rejects(
    loadReviewFeedback(root, operation, locks, [misroutedPath]),
    (error) => error.code === 'AIH_CANONICAL_UI_FEEDBACK_ROUTE_INVALID',
  );
});

test('Canonical UI input gate, Publish lock, drift invalidation, and Reopen form one lifecycle', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const packagePath = resolve(root, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.scripts['fixture:pass'] = 'node -e "process.exit(0)"';
  await writeFile(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  const manifestPath = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.commands.push({
    id: 'fixture-pass', npmScript: 'fixture:pass', run: 'npm run fixture:pass', purpose: 'fixture', blocking: true,
    executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-pass.mjs' },
  });
  manifest.validationProfiles.find((item) => item.id === 'canonical-ui-review-readiness').commands = ['fixture-pass'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  let project = await fixtureProject(root);
  await writeReviewEvidence(root, await canonicalLocks(root, project));
  const published = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/publication.mjs', root, [
    '--operation', 'publish-product-design', '--json',
  ]);
  assert.equal(published.exitCode, 0, JSON.stringify(published.output, null, 2));
  assert.equal(published.output.downstreamAction, 'NOT_RUN');
  project = await fixtureProject(root);
  assert.equal(project.stages['product-design'].status, 'published');
  assert.equal(project.stages['architecture-design'].status, 'uninitialized');
  const ledger = JSON.parse(await readFile(resolve(root, project.stages['product-design'].publication.receipt), 'utf8'));
  assert.equal(ledger.version, '3.0.0');
  assert.ok(ledger.current.credential.startsWith('sha256:'));
  assert.equal(ledger.current.inputLocks.visualAssets.length, 1);
  assert.equal(ledger.current.visualAcceptance, null);

  const stage = project.stages['product-design'];
  const appPath = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root, 'ACTOR-001', 'src/psp-app.ts');
  await appendFile(appPath, '\n// manual published drift\n');
  const stale = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(stale).has('AIH_PUBLISH_CREDENTIAL_STALE'));
  const locked = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact', '--artifact', 'capabilities', '--input', resolve(root, stage.root, stage.artifacts.capabilities.internalModel), '--dry-run', '--json',
  ]);
  assert.ok(codes(locked).has('AIH_STAGE_LOCKED'));
  const repairLocked = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.ok(codes(repairLocked).has('AIH_STAGE_LOCKED'), JSON.stringify(repairLocked.output, null, 2));
  const refreshLocked = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/refresh-projections.mjs', root, [
    '--operation', 'refresh-canonical-ui-projections', '--json',
  ]);
  assert.ok(codes(refreshLocked).has('AIH_STAGE_LOCKED'), JSON.stringify(refreshLocked.output, null, 2));

  const reopened = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/publication.mjs', root, [
    '--operation', 'reopen-product-design', '--json',
  ]);
  assert.equal(reopened.exitCode, 0, JSON.stringify(reopened.output, null, 2));
  project = await fixtureProject(root);
  assert.equal(project.stages['product-design'].status, 'active');
  const history = JSON.parse(await readFile(resolve(root, project.stages['product-design'].publication.receipt), 'utf8'));
  assert.equal(history.current, null);
  assert.equal(history.history.length, 1);
  const refreshReopened = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/refresh-projections.mjs', root, [
    '--operation', 'refresh-canonical-ui-projections', '--json',
  ]);
  assert.equal(refreshReopened.exitCode, 0, JSON.stringify(refreshReopened.output, null, 2));

  await writeReviewEvidence(root, await canonicalLocks(root, project));
  const sameVersion = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/publication.mjs', root, [
    '--operation', 'publish-product-design', '--json',
  ]);
  assert.ok(codes(sameVersion).has('AIH_PUBLISH_VERSION_NOT_ADVANCED'));
});

test('exact Human Visual Acceptance requires explicit user confirmation and becomes stale after scope drift', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const exact = await prepareExactFixture(root);
  let project = await fixtureProject(root);
  await writeReviewEvidence(root, await canonicalLocks(root, project));

  const implicit = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/visual-acceptance.mjs', root, ['--json']);
  assert.ok(codes(implicit).has('AIH_HUMAN_VISUAL_ACCEPTANCE_REQUIRED'));

  const accepted = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/visual-acceptance.mjs', root, [
    '--accepted-by', 'user:fixture-reviewer', '--confirm', 'HUMAN_VISUAL_ACCEPTED', '--json',
  ]);
  assert.equal(accepted.exitCode, 0, JSON.stringify(accepted.output, null, 2));
  assert.equal(accepted.output.acceptance, 'accepted');

  const manifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  assert.deepEqual(await verifyVisualAcceptance(root, project, manifest), []);

  exact.model.componentContracts[0].properties[0].defaultValue = 'scope-drift';
  await writeCanonical(exact.path, exact.model);
  project = await fixtureProject(root);
  const stale = await verifyVisualAcceptance(root, project, manifest, { markStale: true });
  assert.equal(stale[0].code, 'AIH_HUMAN_VISUAL_ACCEPTANCE_STALE');
  const record = JSON.parse(await readFile(visualAcceptanceRecordPath(root), 'utf8'));
  assert.equal(record.status, 'stale');
});

test('Figma source registration packet validates adapter output without owning Canonical UI identifiers', async () => {
  const root = await temporaryRepository();
  const schema = JSON.parse(await readFile(
    resolve(root, '.agents/skills/figma-workflow/source-registration.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const packet = {
    version: '2.0.0',
    sourceId: 'DESIGN-SOURCE-001',
    sourceVersion: { kind: 'figma-file-version', value: 'fixture-version-20260715' },
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: 'sha256:' + 'a'.repeat(64),
    capturePlan: { path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json', sha256: 'sha256:' + 'b'.repeat(64) },
    designContext: { path: 'design-sources/DESIGN-SOURCE-001/design-context.json', sha256: 'sha256:' + 'e'.repeat(64) },
    ingestReceipt: { path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json', sha256: 'sha256:' + 'c'.repeat(64) },
    componentHandshake: [{
      proposalId: 'COMPONENT-PROPOSAL-001',
      decision: 'shared-component',
      semanticRole: '展示验证状态',
      reason: '共同语义与结构支持复用。',
      counterexample: '仅颜色相同但职责不同的卡片不能复用。',
      finalNodeIds: ['2:1', '2:2', '1:2'],
      structureSignatures: ['sha256:' + 'f'.repeat(64)],
      interfaceProposal: {
        properties: [{
          kind: 'variant',
          figmaProperty: 'Mode',
          litProperty: 'mode',
          litAttribute: 'mode',
          values: [{ figmaValue: 'Default', litValue: 'default' }],
        }],
        slots: [],
        events: [],
      },
      usageBindings: [{ instanceNodeId: '1:2', screenId: 'SCREEN-001' }],
      baselineEvidenceItemIds: ['EVIDENCE-SCREENSHOT-001'],
      figmaComponentNodeId: '2:1',
      variantDefinitionNodeIds: ['2:2'],
      variantUsageInstanceNodeIds: ['1:2'],
    }],
    assets: [{
      path: 'public/assets/DESIGN-SOURCE-001/source.svg',
      sourceNodeId: '1:3',
      assetKind: 'icon',
      captureScope: 'layer',
      containsDynamicContent: false,
      strategy: 'asset',
      format: 'svg',
      scale: 1,
      cropBounds: { x: 0, y: 0, width: 40, height: 40 },
      transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      expectedDimensions: { width: 40, height: 40 },
      sha256: 'sha256:' + 'd'.repeat(64),
      downloadOperation: 'figma:export-node',
      consumerTargets: ['COMPONENT-001'],
      status: 'verified',
    }],
    gaps: [],
  };
  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(Object.hasOwn(packet.assets[0], 'id'), false);
  delete packet.assets[0].consumerTargets;
  assert.equal(validate(packet), false);
});

test('controlled Figma Asset Ingest validates temporary acquisition before formal writes', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const session = await mkdtemp(resolve(tmpdir(), 'pre-sdd-ingest-test-'));
  const downloadDirectory = resolve(session, 'downloads');
  await mkdir(downloadDirectory);
  const formalPlanPath = resolve(areaPath, 'design-sources/DESIGN-SOURCE-001/capture-plan.json');
  const formalAssetPath = resolve(areaPath, 'public/assets/DESIGN-SOURCE-001/source.svg');
  const plan = JSON.parse(await readFile(formalPlanPath, 'utf8'));
  const now = Date.now();
  plan.scopeConfirmation.scanInventory.scannedAt = new Date(now - 60_000).toISOString();
  plan.scopeConfirmation.confirmedAt = new Date(now - 50_000).toISOString();
  plan.highImpactConfirmation.confirmedAt = new Date(now - 40_000).toISOString();
  plan.writebackBoundary.completedAt = new Date(now - 30_000).toISOString();
  plan.frozenAt = new Date(now - 20_000).toISOString();
  plan.formalCapture.startedAt = new Date(now - 10_000).toISOString();
  plan.formalCapture.completedAt = new Date(now + 60_000).toISOString();
  plan.scopeConfirmation.sha256 = confirmationSha256(plan.scopeConfirmation);
  plan.highImpactConfirmation.scopeConfirmationSha256 = plan.scopeConfirmation.sha256;
  plan.highImpactConfirmation.sha256 = confirmationSha256(plan.highImpactConfirmation);
  plan.writebackBoundary.highImpactConfirmationSha256 = plan.highImpactConfirmation.sha256;
  const planContent = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const assetContent = await readFile(formalAssetPath);
  const planPath = resolve(session, 'capture-plan.json');
  const downloadPath = resolve(downloadDirectory, 'source.svg');
  await Promise.all([writeFile(planPath, planContent), writeFile(downloadPath, assetContent)]);
  const assetPlan = plan.candidateVisualNodes.find((item) => item.strategy === 'asset');
  const acquisition = {
    version: '1.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlanSha256: sha256(planContent),
    downloadedAt: new Date(now).toISOString(),
    downloadOperation: assetPlan.assetExport.downloadOperation,
    files: [{
      sourceNodeId: assetPlan.nodeId,
      path: 'downloads/source.svg',
      targetPath: assetPlan.assetExport.targetPath,
      assetKind: assetPlan.assetKind,
      captureScope: assetPlan.captureScope,
      containsDynamicContent: assetPlan.containsDynamicContent,
      format: assetPlan.assetExport.format,
      scale: assetPlan.assetExport.scale,
      cropBounds: assetPlan.assetExport.cropBounds,
      transparentPadding: assetPlan.assetExport.transparentPadding,
      dimensions: assetPlan.assetExport.expectedDimensions,
      sha256: sha256(assetContent),
    }],
  };
  const acquisitionPath = resolve(session, 'acquisition.json');
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');

  const ingested = runScript('.agents/skills/figma-workflow/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.equal(ingested.exitCode, 0, JSON.stringify(ingested.output, null, 2));
  assert.equal(ingested.output.assets[0].status, 'verified');

  acquisition.files[0].sha256 = 'sha256:' + 'f'.repeat(64);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const mismatched = runScript('.agents/skills/figma-workflow/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(mismatched).has('AIH_ASSET_HASH_MISMATCH'), JSON.stringify(mismatched.output, null, 2));

  const ambiguousPlan = structuredClone(plan);
  ambiguousPlan.candidateVisualNodes.push({
    nodeId: assetPlan.nodeId,
    name: 'Conflicting classification',
    strategy: 'ignored',
    reason: 'fixture conflict',
  });
  const ambiguousPlanContent = Buffer.from(JSON.stringify(ambiguousPlan, null, 2) + '\n');
  await writeFile(planPath, ambiguousPlanContent);
  acquisition.capturePlanSha256 = sha256(ambiguousPlanContent);
  acquisition.files[0].sha256 = sha256(assetContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const ambiguous = runScript('.agents/skills/figma-workflow/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(ambiguous).has('AIH_ASSET_CLASSIFICATION_INCOMPLETE'), JSON.stringify(ambiguous.output, null, 2));

  const expandedPlan = structuredClone(plan);
  expandedPlan.candidateVisualNodes.push({
    nodeId: '1:99',
    name: 'Agent-expanded visual node',
    strategy: 'dom-css',
  });
  const expandedPlanContent = Buffer.from(JSON.stringify(expandedPlan, null, 2) + '\n');
  await writeFile(planPath, expandedPlanContent);
  acquisition.capturePlanSha256 = sha256(expandedPlanContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const expanded = runScript('.agents/skills/figma-workflow/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(expanded).has('AIH_SOURCE_CAPTURE_BLOCKED'), JSON.stringify(expanded.output, null, 2));

  const unapprovedDetachPlan = structuredClone(plan);
  unapprovedDetachPlan.highImpactConfirmation.writebackOperations = [{
    id: 'WRITEBACK-001',
    kind: 'detach-instance',
    targetNodeIds: ['1:2'],
    reason: 'Fixture detach request.',
  }];
  unapprovedDetachPlan.writebackBoundary.operationIds = ['WRITEBACK-001'];
  const unapprovedDetachContent = Buffer.from(JSON.stringify(unapprovedDetachPlan, null, 2) + '\n');
  await writeFile(planPath, unapprovedDetachContent);
  acquisition.capturePlanSha256 = sha256(unapprovedDetachContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const unapprovedDetach = runScript('.agents/skills/figma-workflow/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(unapprovedDetach).has('AIH_SOURCE_CAPTURE_BLOCKED'), JSON.stringify(unapprovedDetach.output, null, 2));

  const missingSecondConfirmation = structuredClone(plan);
  delete missingSecondConfirmation.highImpactConfirmation;
  const missingSecondConfirmationContent = Buffer.from(JSON.stringify(missingSecondConfirmation, null, 2) + '\n');
  await writeFile(planPath, missingSecondConfirmationContent);
  acquisition.capturePlanSha256 = sha256(missingSecondConfirmationContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const missingConfirmation = runScript('.agents/skills/figma-workflow/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(missingConfirmation).has('AIH_SOURCE_CAPTURE_BLOCKED'), JSON.stringify(missingConfirmation.output, null, 2));
});

test('Canonical UI 11.0 rejects legacy structures and incomplete public Lit projection contracts', async () => {
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

  const unnamedComponentState = structuredClone(model);
  delete unnamedComponentState.stateAxes.find((axis) => axis.kind === 'runtime-state').renderBinding.name;
  await writeCanonical(path, unnamedComponentState);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const missingRuntimeRenderValue = structuredClone(model);
  delete missingRuntimeRenderValue.stateAxes.find((axis) => axis.kind === 'runtime-state').values[0].renderValue;
  await writeCanonical(path, missingRuntimeRenderValue);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const unknownRuntimeProperty = structuredClone(model);
  unknownRuntimeProperty.stateAxes.find((axis) => axis.kind === 'runtime-state').renderBinding.name = 'undeclaredState';
  await writeCanonical(path, unknownRuntimeProperty);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_STATE_MATRIX_INVALID'));
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
  missingVariant.componentVariantDefinitions = missingVariant.componentVariantDefinitions.filter(
    (item) => item.figmaComponentNodeId !== '2:3',
  );
  await writeCanonical(path, missingVariant);
  const incomplete = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(incomplete).has('AIH_COMPONENT_VARIANT_COVERAGE_FAILED'), JSON.stringify(incomplete.output, null, 2));
});

test('Component Contract and State Matrix classify every finite combination exactly once', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const missingContract = structuredClone(model);
  missingContract.componentContracts = [];
  await writeCanonical(path, missingContract);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_COMPONENT_CONTRACT_INVALID'));

  const bypassedInterface = structuredClone(model);
  bypassedInterface.componentContracts[0].litTagName = 'copied-state-card';
  await writeCanonical(path, bypassedInterface);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_COMPONENT_CONTRACT_INVALID'));

  const missingShell = structuredClone(model);
  missingShell.componentContracts[0].implementationRole = 'shared-component';
  await writeCanonical(path, missingShell);
  const missingShellResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(
    missingShellResult.output.blockers.some((item) => item.message.includes('每个 Screen 必须且只能声明一个 app-shell Page Instance')),
    JSON.stringify(missingShellResult.output, null, 2),
  );

  const duplicateShell = structuredClone(model);
  const duplicateShellContract = structuredClone(duplicateShell.componentContracts[0]);
  duplicateShellContract.id = 'COMPONENT-CONTRACT-DUPLICATE-SHELL';
  delete duplicateShellContract.mappingId;
  duplicateShellContract.figmaInstanceNodeIds = [];
  duplicateShellContract.pageInstances = [{
    id: 'REVIEW-DUPLICATE-SHELL-INSTANCE',
    screenId: 'SCREEN-001',
    origin: 'local',
  }];
  duplicateShellContract.implementationPaths = ['src/product-router.ts'];
  duplicateShell.componentContracts.push(duplicateShellContract);
  await writeCanonical(path, duplicateShell);
  const duplicateShellResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(
    duplicateShellResult.output.blockers.some((item) => item.message.includes('每个 Screen 必须且只能声明一个 app-shell Page Instance')),
    JSON.stringify(duplicateShellResult.output, null, 2),
  );

  const missingTokenBinding = structuredClone(model);
  delete missingTokenBinding.tokens[0].cssProperty;
  await writeCanonical(path, missingTokenBinding);
  const missingTokenResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(
    missingTokenResult.output.blockers.some((item) => item.message.includes('Token 必须声明非空 targetIds 与合法 cssProperty')),
    JSON.stringify(missingTokenResult.output, null, 2),
  );

  const missingCombination = structuredClone(model);
  missingCombination.stateMatrix.pop();
  await writeCanonical(path, missingCombination);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_STATE_MATRIX_INVALID'));

  const duplicateCombination = structuredClone(model);
  duplicateCombination.stateMatrix.push({ ...duplicateCombination.stateMatrix[0], id: 'STATE-MATRIX-DUPLICATE' });
  await writeCanonical(path, duplicateCombination);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_STATE_MATRIX_INVALID'));

  const confusedKinds = structuredClone(model);
  confusedKinds.stateAxes.find((axis) => axis.kind === 'content-override').values[0].stateId = 'COMPONENT-STATE-DEFAULT';
  await writeCanonical(path, confusedKinds);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_STATE_MATRIX_INVALID'));
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
  Object.assign(blocked.designSources[0], {
    status: 'blocked',
    capturedAt: null,
    evidence: null,
    registration: null,
    coverage: [],
  });
  blocked.gaps = [{ id: 'GAP-SOURCE-001', description: 'Figma 节点无访问权限', owner: 'product-design', sourceIds: ['DESIGN-SOURCE-001'] }];
  await writeCanonical(path, blocked);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_SOURCE_CAPTURE_BLOCKED'));

  const missingCoverage = structuredClone(model);
  missingCoverage.visualPolicy.mode = 'exact';
  missingCoverage.visualPolicy.aspects = ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'];
  missingCoverage.designSources[0].coverage[0].stateIds = ['INT-STATE-001'];
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
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_ASSET_MISSING'));
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

test('Figma asset closure blocks missing files, hash drift, and manifest drift', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  const assetRelativePath = model.assets[0].path;
  const assetPath = resolve(areaPath, assetRelativePath);
  const original = await readFile(assetPath);

  await rm(assetPath);
  const missing = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(missing).has('AIH_ASSET_MISSING'), JSON.stringify(missing.output, null, 2));

  await writeFile(assetPath, Buffer.concat([original, Buffer.from('<!-- drift -->\n')]));
  const hashDrift = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(hashDrift).has('AIH_ASSET_HASH_MISMATCH'), JSON.stringify(hashDrift.output, null, 2));

  await writeFile(assetPath, original);
  const manifestDrift = structuredClone(model);
  manifestDrift.assets[0].sha256 = 'sha256:' + 'f'.repeat(64);
  await writeCanonical(path, manifestDrift);
  const closure = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(closure).has('AIH_ASSET_CLOSURE_FAILED'), JSON.stringify(closure.output, null, 2));

  await writeCanonical(path, model);
  const closed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(closed.exitCode, 0, JSON.stringify(closed.output, null, 2));
});

test('browser validator executes declared routes, interactions and viewports with temporary evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  assert.equal(result.output.evidence.filter((item) => item.kind === 'route').length, 2);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'scenario').length, 6);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'component').length, 8);
  assert.deepEqual(new Set(result.output.evidence.filter((item) => item.kind === 'scenario').map((item) => item.viewportId)), new Set(['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP']));
  for (const item of result.output.evidence.filter((entry) => entry.kind === 'scenario')) {
    const expected = item.scenarioId === 'SCENARIO-001'
      ? [['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS']]
      : item.scenarioId === 'SCENARIO-002'
        ? [['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR']]
        : [['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'], ['COMPONENT-STATE-DEFAULT']];
    assert.deepEqual(item.actionStateTraces.map((trace) => trace.stateIds), expected);
  }
  assert.ok(result.output.evidence.filter((item) => item.screenshot).every((item) => !item.screenshot.startsWith(root)));

  const routerPath = resolve(areaPath, 'src/product-router.ts');
  const router = await readFile(routerPath, 'utf8');
  await writeFile(routerPath, router.replace(
    'host.setAttribute(attribute, value);',
    "host.setAttribute(attribute, 'special');",
  ));
  const mismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(mismatch).has('AIH_COMPONENT_IMPLEMENTATION_MISMATCH'), JSON.stringify(mismatch.output, null, 2));
  const repair = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--new-session', '--json']);
  assert.equal(repair.output.status, 'REPAIR_REQUIRED', JSON.stringify(repair.output, null, 2));
  assert.ok(repair.output.failures.some((item) => item.defectClass === 'html-structure'));
  assert.ok(repair.output.failures.some((item) => item.defectClass === 'component-contract'));
});

test('browser validator enforces the single App Shell and registered Token consumption', async () => {
  {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const { areaPath } = await canonicalFixture(root);
    const routerPath = resolve(areaPath, 'src/product-router.ts');
    const router = await readFile(routerPath, 'utf8');
    await writeFile(
      routerPath,
      router.replace(
        '</psp-app>',
        '</psp-app><psp-app data-component-id="COMPONENT-001"></psp-app>',
      ),
    );
    const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
    assert.ok(codes(result).has('AIH_COMPONENT_IMPLEMENTATION_MISMATCH'), JSON.stringify(result.output, null, 2));
    assert.ok(result.output.blockers.some((item) => item.message.includes('app-shell')));
  }

  {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const { areaPath } = await canonicalFixture(root);
    const appPath = resolve(areaPath, 'src/psp-app.ts');
    const app = await readFile(appPath, 'utf8');
    await writeFile(appPath, app.replaceAll('var(--accent)', '#c8f36a'));
    const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
    assert.ok(codes(result).has('AIH_VISUAL_STYLE_BINDING_FAILED'), JSON.stringify(result.output, null, 2));
    assert.ok(result.output.blockers.some((item) => item.message.includes('CSS var() 消费')));
  }
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
  removeFigmaComponentBindings(autonomous);
  autonomous.sourceParityAssertions = [];
  await writeCanonical(path, autonomous);
  const autonomousResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(autonomousResult.exitCode, 0, JSON.stringify(autonomousResult.output, null, 2));
  const autonomousAppPath = resolve(areaPath, 'src/psp-app.ts');
  const autonomousApp = await readFile(autonomousAppPath, 'utf8');
  await writeFile(autonomousAppPath, autonomousApp.replace('min-height: 44px;', 'min-height: 10px;'));
  const autonomousRepair = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--new-session', '--json']);
  assert.equal(autonomousRepair.output.status, 'REPAIR_REQUIRED', JSON.stringify(autonomousRepair.output, null, 2));
  assert.ok(autonomousRepair.output.failures.some((item) => item.defectClass === 'css-rendering'));
  await writeFile(autonomousAppPath, autonomousApp);

  await writeCanonical(path, model);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app.replace('data-screen-id="SCREEN-001"', 'data-screen-id="SCREEN-BROKEN"'));
  const guidedDomRepair = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--new-session', '--json']);
  assert.equal(guidedDomRepair.output.status, 'REPAIR_REQUIRED', JSON.stringify(guidedDomRepair.output, null, 2));
  assert.ok(guidedDomRepair.output.failures.some((item) => item.defectClass === 'html-structure'));
  await writeFile(appPath, app);
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const guidedMismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(guidedMismatch).has('AIH_VISUAL_STYLE_BINDING_FAILED'), JSON.stringify(guidedMismatch.output, null, 2));
  const guidedRepair = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--new-session', '--json']);
  assert.equal(guidedRepair.output.status, 'REPAIR_REQUIRED');
  assert.ok(guidedRepair.output.repairPacket);
  assert.ok(guidedRepair.output.failures.some((item) => item.defectClass === 'source-parity'));
  await writeFile(appPath, app);

  const exact = (await prepareExactFixture(root)).model;

  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const exactMismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(exactMismatch).has('AIH_VISUAL_SOURCE_PARITY_FAILED'), JSON.stringify(exactMismatch.output, null, 2));
  assert.ok(exactMismatch.output.evidence.some((item) => item.kind === 'repair-diagnostic' && item.defectClass === 'source-parity'));

  const localManifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  const defaultProfile = localManifest.validationProfiles.find((item) => item.id === 'canonical-ui-prototype');
  assert.ok(defaultProfile.commands.includes('product-strict'));
});

test('provider-neutral implementation inputs accept guided screenshots and exact screenshot or export evidence without Figma closure', async () => {
  {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const { areaPath, path, model } = await canonicalFixture(root);
    const guided = structuredClone(model);
    const evidenceIds = await convertFixtureSourceToProviderNeutral(areaPath, guided, 'screenshot');
    guided.designSources[0].status = 'partial';
    guided.designSources[0].coverage[0].stateIds = ['INT-STATE-001'];
    guided.designSources[0].coverage[0].evidenceItemIds = guided.designSources[0].coverage[0].evidenceItemIds.filter((id) => evidenceIds.has(id));
    guided.visualPolicy.coverage[0].stateIds = ['INT-STATE-001'];
    guided.visualPolicy.coverage[0].evidenceItemIds = guided.visualPolicy.coverage[0].evidenceItemIds.filter((id) => evidenceIds.has(id));
    await writeCanonical(path, guided);
    const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
    assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  }

  for (const kind of ['screenshot', 'export']) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const exactFixture = await prepareExactFixture(root);
    const exact = structuredClone(exactFixture.model);
    const evidenceIds = await convertFixtureSourceToProviderNeutral(exactFixture.areaPath, exact, kind);
    exact.designSources[0].coverage[0].evidenceItemIds = exact.designSources[0].coverage[0].evidenceItemIds.filter((id) => evidenceIds.has(id));
    exact.visualPolicy.coverage[0].evidenceItemIds = exact.visualPolicy.coverage[0].evidenceItemIds.filter((id) => evidenceIds.has(id));
    await writeCanonical(exactFixture.path, exact);
    const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
    assert.equal(result.exitCode, 0, kind + ': ' + JSON.stringify(result.output, null, 2));
    if (kind === 'screenshot') {
      const missingCoverage = structuredClone(exact);
      missingCoverage.designSources[0].coverage[0].stateIds = ['INT-STATE-001'];
      await writeCanonical(exactFixture.path, missingCoverage);
      const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
      assert.ok(codes(strict).has('AIH_SOURCE_COVERAGE_FAILED'), JSON.stringify(strict.output, null, 2));
    }
  }
});

test('exact visual repair emits a complete packet and passes after an allowed implementation fix', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { appPath, app } = await prepareExactFixture(root);
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  await assert.rejects(stat(resolve(root, '.psp/handoffs/receipts')), (error) => error.code === 'ENOENT');
  await assert.rejects(stat(visualAcceptanceRecordPath(root)), (error) => error.code === 'ENOENT');

  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--new-session', '--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));
  assert.equal(requested.output.attempt, 1);
  const packet = JSON.parse(await readFile(requested.output.repairPacket, 'utf8'));
  assert.equal(packet.version, '5.0.0');
  assert.equal(packet.status, 'REPAIR_REQUIRED');
  assert.equal(packet.maxAttempts, 1);
  assert.deepEqual(packet.implementationPolicy, {
    evidenceBeforeEdit: true,
    sourceResolution: 'when-source-backed',
    preserveInteractiveDom: true,
    preferSourceAssets: true,
    allowSubjectiveApproximation: false,
    minimalImplementationScope: true,
    stableComparisonEnvironment: true,
    fixOrder: ['structure', 'geometry', 'typography', 'paint', 'effects', 'assets'],
  });
  const styleFailure = packet.failures.find((failure) => failure.check.kind === 'computed-style');
  assert.deepEqual(styleFailure.scope.targetIds, ['CONTROL-001']);
  assert.equal(styleFailure.check.property, 'background-color');
  assert.equal(styleFailure.check.expected, 'rgb(200, 243, 106)');

  await writeFile(appPath, app);
  const repaired = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--session', requested.output.repairSessionId, '--json']);
  assert.equal(repaired.exitCode, 0, JSON.stringify(repaired.output, null, 2));
  assert.equal(repaired.output.status, 'PASS');
  assert.equal(repaired.output.attempts, 1);
  const actionReport = JSON.parse(await readFile(repaired.output.repairActionReport, 'utf8'));
  assert.equal(actionReport.status, 'PASS');
  assert.equal(actionReport.actor, 'ACTOR-001');
  assert.equal(actionReport.attempts, 1);
  assert.equal(actionReport.version, '2.0.0');
  assert.equal(actionReport.repairSessionId, requested.output.repairSessionId);
  assert.ok(actionReport.resolvedFailures.length > 0);
  assert.ok(actionReport.validationGates.every((gate) => gate.status === 'PASS'));
});

test('repair entry does not depend on Handoff Receipt or Human Visual Acceptance', async () => {
  const source = await readFile(resolve(
    import.meta.dirname,
    '../canonical-ui-prototype/scripts/repair.mjs',
  ), 'utf8');
  assert.doesNotMatch(source, /handoff|receipt|visualAcceptance|visual-acceptance/i);
  assert.doesNotMatch(source, /canonical-ui-dev|canonical-ui-review|publish-product-design/);
  assert.match(source, /stage\?\.status === 'published'/);
  assert.match(source, /stage\?\.status !== 'active'/);
  assert.match(source, /repair\.allowedVisualModes\.includes/);
  assert.doesNotMatch(source, /repairPolicy\.enabled|repairableBlockerCodes/);
});

test('Canonical UI projection refresh supports dry-run, exact bound writes, and published locking', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  const updatedTitle = model.screens[0].title + '（更新）';
  model.screens[0].title = updatedTitle;
  await writeCanonical(path, model);
  const authority = await readFile(path);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const projectionBinding = stage.artifacts['canonical-ui-prototype'].memberProjections[0];
  const projectionPath = resolve(root, stage.root, projectionBinding.root, 'ACTOR-001', projectionBinding.member);
  const before = await readFile(projectionPath, 'utf8');

  const dryRun = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/refresh-projections.mjs', root, [
    '--operation', 'refresh-canonical-ui-projections', '--dry-run', '--json',
  ]);
  assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun.output, null, 2));
  assert.deepEqual(dryRun.output.targets, [
    stage.root + '/' + projectionBinding.root + '/ACTOR-001/' + projectionBinding.member,
  ]);
  assert.equal(await readFile(projectionPath, 'utf8'), before);

  const refreshed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/refresh-projections.mjs', root, [
    '--operation', 'refresh-canonical-ui-projections', '--json',
  ]);
  assert.equal(refreshed.exitCode, 0, JSON.stringify(refreshed.output, null, 2));
  assert.equal(JSON.parse(await readFile(projectionPath, 'utf8')).screens[0].title, updatedTitle);
  assert.deepEqual(await readFile(path), authority);

  project.stages['product-design'].status = 'published';
  await writeFile(resolve(root, 'psp.project.yaml'), stringifyYaml(project));
  const locked = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/refresh-projections.mjs', root, [
    '--operation', 'refresh-canonical-ui-projections', '--json',
  ]);
  assert.ok(codes(locked).has('AIH_STAGE_LOCKED'), JSON.stringify(locked.output, null, 2));
});

test('exact visual repair keeps external evidence hashes but does not hash-gate code edits', async () => {
  const changedRoot = await temporaryRepository();
  await completeProductFixture(changedRoot);
  const changed = await prepareExactFixture(changedRoot);
  await writeFile(changed.appPath, changed.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', changedRoot, ['--new-session', '--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));
  await appendFile(changed.baselinePath, 'baseline-mutated');
  const changedEvidence = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', changedRoot, ['--session', requested.output.repairSessionId, '--json']);
  assert.ok(codes(changedEvidence).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(changedEvidence.output, null, 2));

  const missingRoot = await temporaryRepository();
  await completeProductFixture(missingRoot);
  const missing = await prepareExactFixture(missingRoot);
  await rm(missing.baselinePath);
  const missingSource = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', missingRoot, ['--new-session', '--json']);
  assert.equal(missingSource.output.status, 'BLOCKED');
  assert.equal(missingSource.output.repairPacket, undefined);
  assert.ok(codes(missingSource).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(missingSource.output, null, 2));
});

test('canonical UI repair blocks non-repairable failures and permits one Agent implementation attempt', async () => {
  const nonVisualRoot = await temporaryRepository();
  await completeProductFixture(nonVisualRoot);
  const nonVisual = await prepareExactFixture(nonVisualRoot);
  await writeFile(
    nonVisual.appPath,
    nonVisual.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;') + "\nconsole.error('repair-nonvisual');\n",
  );
  const nonVisualResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', nonVisualRoot, ['--new-session', '--json']);
  assert.equal(nonVisualResult.output.status, 'BLOCKED');
  assert.equal(nonVisualResult.output.repairPacket, undefined);
  assert.ok(codes(nonVisualResult).has('AIH_CANONICAL_UI_CONSOLE_FAILED'), JSON.stringify(nonVisualResult.output, null, 2));

  const exhaustedRoot = await temporaryRepository();
  await completeProductFixture(exhaustedRoot);
  const exhausted = await prepareExactFixture(exhaustedRoot);
  await writeFile(exhausted.appPath, exhausted.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const first = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--new-session', '--json']);
  assert.equal(first.output.attempt, 1, JSON.stringify(first.output, null, 2));
  await appendFile(exhausted.appPath, '\n// single Agent repair attempt\n');
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--session', first.output.repairSessionId, '--json']);
  assert.equal(result.output.status, 'BLOCKED', JSON.stringify(result.output, null, 2));
  assert.match(result.stderr, /AIH_UI_REPAIR_EXHAUSTED/);
  const exhaustedPacket = JSON.parse(await readFile(result.output.repairPacket, 'utf8'));
  assert.equal(exhaustedPacket.attempts.length, 1);
  assert.ok(exhaustedPacket.attempts[0].failures.some((failure) => failure.check.kind === 'computed-style'));
  const reused = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--session', first.output.repairSessionId, '--json']);
  assert.ok(codes(reused).has('AIH_UI_REPAIR_SESSION_INVALID'));
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

test('Component Contract runner generates isolated Playwright checks from the shared State Matrix', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const { areaPath, path, model } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');

  await writeFile(appPath, app.replace('    mode: { type: String, reflect: true },\n', ''));
  const ignoredVariant = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.ok(codes(ignoredVariant).has('AIH_COMPONENT_CONTRACT_TEST_FAILED'), JSON.stringify(ignoredVariant.output, null, 2));
  assert.ok(ignoredVariant.output.blockers.some((item) => item.message.includes('Variant 未通过声明的 Lit Attribute 实际渲染')));

  await writeFile(appPath, app.replace('${this.message || this.feedback}', '${this.feedback}'));
  const ignoredContent = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.ok(codes(ignoredContent).has('AIH_COMPONENT_CONTRACT_TEST_FAILED'), JSON.stringify(ignoredContent.output, null, 2));
  assert.ok(ignoredContent.output.blockers.some((item) => item.message.includes('Content Override 的 Lit Property 未形成可见内容')));

  await writeFile(appPath, app);
  model.componentContracts[0].properties[0].defaultValue = 'unexpected';
  await writeCanonical(path, model);
  const failed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.ok(codes(failed).has('AIH_COMPONENT_CONTRACT_TEST_FAILED'), JSON.stringify(failed.output, null, 2));
});

test('Matrix Mount preserves Lit Boolean attribute semantics and requires visible Slot assignment', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  const contract = model.componentContracts[0];
  contract.properties.push({ name: 'compact', type: 'boolean', required: false, defaultValue: false });
  contract.attributes.push({ name: 'compact', propertyName: 'compact' });
  contract.slots.push('label');
  model.stateAxes.push(
    {
      id: 'STATE-AXIS-COMPACT',
      componentContractId: contract.id,
      kind: 'content-override',
      name: 'compact',
      renderBinding: { kind: 'lit-attribute', name: 'compact' },
      values: [{ id: 'AXIS-VALUE-COMPACT-FALSE', value: 'false', renderValue: false }],
    },
    {
      id: 'STATE-AXIS-LABEL',
      componentContractId: contract.id,
      kind: 'content-override',
      name: 'label',
      renderBinding: { kind: 'slot-text', name: 'label' },
      values: [{ id: 'AXIS-VALUE-LABEL-FIXTURE', value: 'fixture', renderValue: 'Slotted fixture' }],
    },
  );
  for (const entry of model.stateMatrix) {
    entry.values['STATE-AXIS-COMPACT'] = 'AXIS-VALUE-COMPACT-FALSE';
    entry.values['STATE-AXIS-LABEL'] = 'AXIS-VALUE-LABEL-FIXTURE';
  }
  await writeCanonical(path, model);

  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  const withBindings = app
    .replace('    message: { type: String },', '    message: { type: String },\n    compact: { type: Boolean, reflect: true },')
    .replace('  declare message: string;', '  declare message: string;\n  declare compact: boolean;')
    .replace("    this.message = '';", "    this.message = '';\n    this.compact = false;")
    .replace('<p>${this.message || this.feedback}</p>', '<p>${this.message || this.feedback}</p>\n                <slot name="label"></slot>');
  await writeFile(appPath, withBindings);

  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const mountPath = resolve(areaPath, 'src/matrix-mount.ts');
  const mount = await readFile(mountPath, 'utf8');
  await writeFile(mountPath, mount.replace(
    '    else host.removeAttribute(name);',
    "    else host.setAttribute(name, 'false');",
  ));
  const falseAsPresent = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.ok(codes(falseAsPresent).has('AIH_COMPONENT_CONTRACT_TEST_FAILED'), JSON.stringify(falseAsPresent.output, null, 2));
  assert.ok(falseAsPresent.output.blockers.some((item) => item.message.includes('Lit Attribute 未实际渲染')));

  await writeFile(mountPath, mount);
  await writeFile(appPath, withBindings.replace('<slot name="label"></slot>', ''));
  const unassignedSlot = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.ok(codes(unassignedSlot).has('AIH_COMPONENT_CONTRACT_TEST_FAILED'), JSON.stringify(unassignedSlot.output, null, 2));
  assert.ok(unassignedSlot.output.blockers.some((item) => item.message.includes('Slot 文本未实际渲染')));
});

test('incremental validation selects impacted component routes and viewports, then reuses OS-temporary cache', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const args = ['--actor', 'ACTOR-001', '--changed-path', 'src/psp-app.ts', '--json'];
  const first = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-incremental.mjs', root, args);
  assert.equal(first.exitCode, 0, JSON.stringify(first.output, null, 2));
  assert.equal(first.output.formalReadiness, 'NOT_RUN');
  assert.deepEqual(first.output.impact.components, ['COMPONENT-001']);
  assert.deepEqual(first.output.impact.routes, ['ROUTE-001']);
  assert.deepEqual(first.output.impact.viewports.sort(), ['VIEWPORT-DESKTOP', 'VIEWPORT-MOBILE']);
  assert.ok(first.output.layers.every((item) => ['PASS', 'NOT_RUN'].includes(item.status)));
  assert.equal(first.output.performance.before.browserRuntimeMs.p50Ms, 49102);

  const second = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-incremental.mjs', root, args);
  assert.equal(second.exitCode, 0, JSON.stringify(second.output, null, 2));
  assert.equal(second.output.cache.hits, 4);
  assert.equal(second.output.cache.misses, 0);
  assert.ok(second.output.layers.every((item) => item.cacheHit));
  assert.ok(second.output.performance.after.machineGatesMs.p50Ms !== null);
});

test('browser validator skips accessibility checks when the user did not select them', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  delete model.accessibility;
  await writeCanonical(path, model);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app.replace(/              >\r?\n                模拟错误\r?\n              <\/button>/, '              >\n              </button>'));
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
  assert.ok(codes(result).has('AIH_ASSET_CSS_BYPASS'), JSON.stringify(result.output, null, 2));
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
    .replace(/            <img src="\/assets\/DESIGN-SOURCE-001\/source\.svg" alt="Fixture source" width="40" height="40" \/>\r?\n/, '')
    .replace(/                data-control-id="CONTROL-001"\r?\n/, '                data-control-id="CONTROL-001"\n                tabindex="-1"\n')
    .replace('                data-action-id="ACTION-001"', '                data-action-id="ACTION-UNKNOWN"')
    .replace(/              >\r?\n                模拟错误\r?\n              <\/button>/, '              >\n              </button>')
    .replace(/    button \{\r?\n      min-height: 44px;/, '    button {\n      box-sizing: border-box;\n      width: 30px;\n      overflow: hidden;\n      min-height: 10px;')
    .replace('button.primary { background: var(--accent); }', 'button.primary { background: var(--accent); }\n    button + button { margin-left: -10px; }')
    .replace('button:focus-visible { outline: 3px solid #678e25; outline-offset: 3px; }', 'button:focus-visible { outline: none; box-shadow: none; }'));

  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  const actual = codes(result);
  for (const expected of [
    'AIH_CANONICAL_UI_CONSOLE_FAILED',
    'AIH_CANONICAL_UI_NETWORK_FAILED',
    'AIH_CANONICAL_UI_VISUAL_FAILED',
    'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED',
    'AIH_ASSET_CSS_BYPASS',
  ]) assert.ok(actual.has(expected), JSON.stringify(result.output, null, 2));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_CONSOLE_FAILED' && item.message.includes('页面异常')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_RUNTIME_FAILED' && item.message.includes('事件控件未绑定声明动作')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('键盘 Tab 到达')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('缺少可访问名称')));
  assert.equal(result.output.evidence.filter((item) => ['route', 'scenario'].includes(item.kind)).length, 8);
  assert.ok(result.output.evidence.some((item) => item.kind === 'repair-diagnostic'));
});
