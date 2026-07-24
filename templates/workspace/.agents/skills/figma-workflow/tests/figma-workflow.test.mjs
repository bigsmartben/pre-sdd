import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const skillRoot = resolve(repositoryRoot, '.agents/skills/figma-workflow');
const ingestScript = resolve(skillRoot, 'scripts/ingest-assets.mjs');

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  return '{' + Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
    .join(',') + '}';
}

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function confirmationSha256(value) {
  const payload = { ...value };
  delete payload.sha256;
  return sha256(Buffer.from(canonicalJson(payload), 'utf8'));
}

async function schema(name) {
  return JSON.parse(await readFile(resolve(skillRoot, name), 'utf8'));
}

function validator(value) {
  return new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(value);
}

function sourceVersion(value = 'fixture-version-1') {
  return { kind: 'figma-file-version', value };
}

function validCapturePlan() {
  const version = sourceVersion();
  const now = Date.now();
  const timestamp = (offset) => new Date(now + offset).toISOString();
  const scopeConfirmation = {
    id: 'SCOPE-CONFIRMATION-001',
    sha256: 'sha256:' + '0'.repeat(64),
    confirmedBy: 'user:fixture-reviewer',
    confirmedAt: timestamp(-5_000),
    sourceVersion: version,
    rootNodeId: '1:2',
    scanInventory: {
      scannedAt: timestamp(-6_000),
      sourceVersion: version,
      rootNodeId: '1:2',
      nodes: [
        { kind: 'component', nodeId: '1:2', name: 'Status instance' },
        { kind: 'visual', nodeId: '1:2', name: 'Status instance' },
      ],
    },
    screenBindings: [{
      screenId: 'SCREEN-STATUS',
      figmaRootNodeId: '1:2',
      viewportId: 'VIEWPORT-DESKTOP',
      scenarioId: 'SCENARIO-001',
      stateIds: ['STATE-DEFAULT'],
    }],
    includedNodes: [
      { kind: 'component', nodeId: '1:2', name: 'Status instance' },
      { kind: 'visual', nodeId: '1:2', name: 'Status instance' },
    ],
    excludedNodes: [],
    viewportIds: ['VIEWPORT-DESKTOP'],
    scenarioIds: ['SCENARIO-001'],
    stateIds: ['STATE-DEFAULT'],
    counts: { pages: 0, components: 1, visualNodes: 1, viewports: 1, scenarios: 1, states: 1 },
  };
  scopeConfirmation.sha256 = confirmationSha256(scopeConfirmation);
  const highImpactConfirmation = {
    id: 'HIGH-IMPACT-CONFIRMATION-001',
    sha256: 'sha256:' + '0'.repeat(64),
    confirmedBy: 'user:fixture-reviewer',
    confirmedAt: timestamp(-4_000),
    sourceVersion: version,
    scopeConfirmationId: scopeConfirmation.id,
    scopeConfirmationSha256: scopeConfirmation.sha256,
    componentProposals: [{
      id: 'COMPONENT-PROPOSAL-001',
      nodeIds: ['1:2'],
      decision: 'shared-component',
      componentName: 'StatusCard',
      semanticRole: 'Status feedback',
      structureSignatures: ['sha256:' + '1'.repeat(64)],
      reason: 'Shared responsibility and structure.',
      counterexample: 'A destructive confirmation card has different responsibility.',
      componentBoundary: {
        kind: 'single-component',
        rootNodeId: '1:2',
        nestedComponentNodeIds: [],
      },
      sizeBehavior: {
        width: { mode: 'fill', min: 240, max: null },
        height: { mode: 'hug', min: 48, max: null },
        wrap: 'content',
      },
      interfaceProposal: {
        properties: [{
          kind: 'variant',
          figmaProperty: 'Mode',
          litProperty: 'mode',
          litAttribute: 'mode',
          values: [
            { figmaValue: 'Default', litValue: 'default' },
            { figmaValue: 'Busy', litValue: 'busy' },
          ],
        }],
        slots: [],
        events: [],
      },
    }],
    stateAxes: [{
      id: 'STATE-AXIS-MODE',
      proposalId: 'COMPONENT-PROPOSAL-001',
      kind: 'variant',
      name: 'Mode',
      values: ['Default', 'Busy'],
    }],
    resourceAmbiguities: [],
    writebackOperations: [],
    detachApprovals: [],
  };
  highImpactConfirmation.sha256 = confirmationSha256(highImpactConfirmation);
  return {
    version: '2.0.0',
    sourceId: 'DESIGN-SOURCE-001',
    rootNodeId: '1:2',
    sourceVersion: version,
    scopeConfirmation,
    highImpactConfirmation,
    writebackBoundary: {
      scopeConfirmationId: scopeConfirmation.id,
      highImpactConfirmationId: highImpactConfirmation.id,
      highImpactConfirmationSha256: highImpactConfirmation.sha256,
      sourceVersionBefore: version,
      sourceVersionAfter: version,
      operationIds: [],
      completedAt: timestamp(-3_000),
      formalCaptureOrdinal: 1,
      recaptureTriggers: ['scope-change', 'source-version-change', 'post-freeze-writeback'],
    },
    frozenAt: timestamp(-2_000),
    formalCapture: {
      ordinal: 1,
      startedAt: timestamp(-1_000),
      completedAt: timestamp(600_000),
      sourceVersionBefore: version,
      sourceVersionAfter: version,
    },
    candidateVisualNodes: [{
      nodeId: '1:2',
      name: 'Status instance',
      strategy: 'dom-css',
    }],
  };
}

function validDesignContext(plan, planHash) {
  const setSignature = 'sha256:' + '2'.repeat(64);
  const definitionSignature = 'sha256:' + '3'.repeat(64);
  return {
    version: '3.0.0',
    sourceId: plan.sourceId,
    nodeId: plan.rootNodeId,
    capturedAt: plan.formalCapture.startedAt,
    sourceVersion: plan.sourceVersion,
    rawCapture: {
      provider: 'figma',
      operation: 'get_design_context',
      requestedNodeId: plan.rootNodeId,
      capturedAt: plan.formalCapture.startedAt,
      sourceVersion: plan.sourceVersion,
      capturePlanSha256: planHash,
      path: 'design-sources/DESIGN-SOURCE-001/raw-design-context.json',
      sha256: 'sha256:' + '4'.repeat(64),
    },
    parameterCoverage: ['geometry', 'typography', 'paint', 'effects', 'components', 'assets'],
    frame: { x: 0, y: 0, width: 1440, height: 900 },
    layout: {
      mode: 'vertical',
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
      itemSpacing: 0,
      alignment: 'stretch',
      constraints: [],
    },
    typography: [],
    paints: [],
    effects: [],
    components: [
      {
        nodeId: '2:1',
        name: 'StatusCard',
        kind: 'component-set',
        componentKey: 'status-card',
        componentSetNodeId: '2:1',
        mainComponentNodeId: null,
        structureSignature: setSignature,
        variantProperties: {},
      },
      ...[
        ['2:2', 'Default'],
        ['2:3', 'Busy'],
      ].map(([nodeId, mode]) => ({
        nodeId,
        name: 'Mode=' + mode,
        kind: 'component',
        componentKey: 'status-card-' + mode.toLowerCase(),
        componentSetNodeId: '2:1',
        mainComponentNodeId: nodeId,
        structureSignature: definitionSignature,
        variantProperties: { Mode: mode },
      })),
      {
        nodeId: '1:2',
        name: 'StatusCard Instance',
        kind: 'instance',
        componentKey: 'status-card-default',
        componentSetNodeId: '2:1',
        mainComponentNodeId: '2:2',
        screenRootNodeId: '1:2',
        structureSignature: definitionSignature,
        variantProperties: { Mode: 'Default' },
      },
    ],
    componentSetCatalog: [{
      componentSetNodeId: '2:1',
      axes: [{ name: 'Mode', values: ['Default', 'Busy'] }],
      definitionNodeIds: ['2:2', '2:3'],
    }],
    assets: [],
  };
}

async function runIngest(plan) {
  const directory = await mkdtemp(resolve(tmpdir(), 'figma-workflow-test-'));
  const planPath = resolve(directory, 'capture-plan.json');
  const planContent = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const acquisitionPath = resolve(directory, 'acquisition.json');
  const acquisition = {
    version: '1.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlanSha256: sha256(planContent),
    downloadedAt: plan.formalCapture.startedAt,
    downloadOperation: 'figma:export-node',
    files: [],
  };
  await Promise.all([
    writeFile(planPath, planContent),
    writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n'),
  ]);
  const result = spawnSync(process.execPath, [
    ingestScript,
    '--actor', 'ACTOR-001',
    '--capture-plan', planPath,
    '--acquisition', acquisitionPath,
    '--json',
  ], { cwd: repositoryRoot, encoding: 'utf8' });
  return JSON.parse(result.stdout);
}

async function runRegistration(mutator = () => {}) {
  const session = await mkdtemp(resolve(tmpdir(), 'figma-registration-test-'));
  const workspace = resolve(session, 'workspace');
  const harnessDirectory = resolve(workspace, '.psp/harness');
  const workspaceSkillRoot = resolve(workspace, '.agents/skills/figma-workflow');
  const areaDirectory = resolve(workspace, '01-product-design/Canonical-UI-Prototypes/ACTOR-001');
  const sourceDirectory = resolve(areaDirectory, 'design-sources/DESIGN-SOURCE-001');
  await Promise.all([
    mkdir(harnessDirectory, { recursive: true }),
    mkdir(workspaceSkillRoot, { recursive: true }),
    mkdir(sourceDirectory, { recursive: true }),
  ]);
  const project = parseYaml(await readFile(resolve(repositoryRoot, 'psp.project.yaml'), 'utf8'));
  project.stages['product-design'].status = 'active';
  await Promise.all([
    writeFile(resolve(workspace, 'psp.project.yaml'), stringifyYaml(project)),
    copyFile(
      resolve(repositoryRoot, '.psp/harness/harness.manifest.json'),
      resolve(harnessDirectory, 'harness.manifest.json'),
    ),
    ...[
      'capture-plan.schema.json',
      'figma-design-context.schema.json',
      'ingest-receipt.schema.json',
      'source-registration.schema.json',
    ].map((name) => copyFile(resolve(skillRoot, name), resolve(workspaceSkillRoot, name))),
  ]);

  const plan = validCapturePlan();
  const planPath = resolve(sourceDirectory, 'capture-plan.json');
  const planContent = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const planHash = sha256(planContent);
  const rawPath = resolve(sourceDirectory, 'raw-design-context.json');
  const rawContent = Buffer.from(JSON.stringify({ source: 'figma', nodeId: plan.rootNodeId }) + '\n');
  const context = validDesignContext(plan, planHash);
  context.rawCapture.sha256 = sha256(rawContent);
  const contextPath = resolve(sourceDirectory, 'design-context.json');
  const contextContent = Buffer.from(JSON.stringify(context, null, 2) + '\n');
  const receipt = {
    version: '1.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlan: {
      path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json',
      sha256: planHash,
    },
    downloadOperation: 'figma:export-node',
    ingestedAt: plan.formalCapture.startedAt,
    assets: [],
    status: 'PASS',
  };
  const receiptPath = resolve(sourceDirectory, 'ingest-receipt.json');
  const receiptContent = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  const screenshotPath = resolve(sourceDirectory, 'node-screenshot.svg');
  const screenshotContent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>\n');
  const evidence = {
    version: '6.0.0',
    sourceId: plan.sourceId,
    kind: 'figma',
    location: 'https://www.figma.com/design/example/example?node-id=1-2',
    capturedAt: plan.formalCapture.startedAt,
    nodeId: plan.rootNodeId,
    sourceVersion: plan.sourceVersion,
    items: [
      {
        id: 'EVIDENCE-RAW-CONTEXT-001',
        role: 'raw-design-context',
        path: 'design-sources/DESIGN-SOURCE-001/raw-design-context.json',
        sha256: sha256(rawContent),
      },
      {
        id: 'EVIDENCE-DESIGN-CONTEXT-001',
        role: 'design-context',
        path: 'design-sources/DESIGN-SOURCE-001/design-context.json',
        sha256: sha256(contextContent),
      },
      {
        id: 'EVIDENCE-CAPTURE-PLAN-001',
        role: 'capture-plan',
        path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json',
        sha256: planHash,
      },
      {
        id: 'EVIDENCE-INGEST-RECEIPT-001',
        role: 'ingest-receipt',
        path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json',
        sha256: sha256(receiptContent),
      },
      {
        id: 'EVIDENCE-SCREENSHOT-001',
        role: 'screenshot',
        path: 'design-sources/DESIGN-SOURCE-001/node-screenshot.svg',
        sha256: sha256(screenshotContent),
      },
    ],
  };
  const evidencePath = resolve(sourceDirectory, 'evidence.json');
  const evidenceContent = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
  await Promise.all([
    writeFile(planPath, planContent),
    writeFile(rawPath, rawContent),
    writeFile(contextPath, contextContent),
    writeFile(receiptPath, receiptContent),
    writeFile(screenshotPath, screenshotContent),
    writeFile(evidencePath, evidenceContent),
  ]);

  const registration = {
    version: '2.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: sha256(evidenceContent),
    capturePlan: receipt.capturePlan,
    designContext: {
      path: 'design-sources/DESIGN-SOURCE-001/design-context.json',
      sha256: sha256(contextContent),
    },
    ingestReceipt: {
      path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json',
      sha256: sha256(receiptContent),
    },
    componentHandshake: [{
      proposalId: 'COMPONENT-PROPOSAL-001',
      decision: 'shared-component',
      semanticRole: 'Status feedback',
      reason: 'Shared responsibility and structure.',
      counterexample: 'A destructive confirmation card has different responsibility.',
      finalNodeIds: ['2:1', '2:2', '2:3', '1:2'],
      structureSignatures: ['sha256:' + '2'.repeat(64), 'sha256:' + '3'.repeat(64)],
      interfaceProposal: plan.highImpactConfirmation.componentProposals[0].interfaceProposal,
      usageBindings: [{ instanceNodeId: '1:2', screenId: 'SCREEN-STATUS' }],
      baselineEvidenceItemIds: ['EVIDENCE-SCREENSHOT-001'],
      figmaComponentNodeId: '2:1',
      variantDefinitionNodeIds: ['2:2', '2:3'],
      variantUsageInstanceNodeIds: ['1:2'],
    }],
    assets: [],
    gaps: [],
  };
  await mutator({ registration, context, evidence, areaDirectory, sourceDirectory });
  const registrationPath = resolve(session, 'registration.json');
  await writeFile(registrationPath, JSON.stringify(registration, null, 2) + '\n');
  const result = spawnSync(process.execPath, [
    ingestScript,
    '--actor', 'ACTOR-001',
    '--registration', registrationPath,
    '--json',
  ], {
    cwd: workspace,
    encoding: 'utf8',
    env: { ...process.env, PSP_REPOSITORY_ROOT: workspace },
  });
  return JSON.parse(result.stdout);
}

test('tightened Figma schemas accept the complete current-version interfaces', async () => {
  const plan = validCapturePlan();
  const planText = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const context = validDesignContext(plan, sha256(planText));
  const receipt = {
    version: '1.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlan: {
      path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json',
      sha256: sha256(planText),
    },
    downloadOperation: 'figma:export-node',
    ingestedAt: plan.formalCapture.startedAt,
    assets: [],
    status: 'PASS',
  };
  const registration = {
    version: '2.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: 'sha256:' + '5'.repeat(64),
    capturePlan: receipt.capturePlan,
    designContext: {
      path: 'design-sources/DESIGN-SOURCE-001/design-context.json',
      sha256: 'sha256:' + '6'.repeat(64),
    },
    ingestReceipt: {
      path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json',
      sha256: 'sha256:' + '7'.repeat(64),
    },
    componentHandshake: [{
      proposalId: 'COMPONENT-PROPOSAL-001',
      decision: 'shared-component',
      semanticRole: 'Status feedback',
      reason: 'Shared responsibility and structure.',
      counterexample: 'A destructive confirmation card has different responsibility.',
      finalNodeIds: ['2:1', '2:2', '2:3', '1:2'],
      structureSignatures: ['sha256:' + '2'.repeat(64), 'sha256:' + '3'.repeat(64)],
      interfaceProposal: plan.highImpactConfirmation.componentProposals[0].interfaceProposal,
      usageBindings: [{ instanceNodeId: '1:2', screenId: 'SCREEN-STATUS' }],
      baselineEvidenceItemIds: ['EVIDENCE-SCREENSHOT-001'],
      figmaComponentNodeId: '2:1',
      variantDefinitionNodeIds: ['2:2', '2:3'],
      variantUsageInstanceNodeIds: ['1:2'],
    }],
    assets: [],
    gaps: [],
  };
  const acquisition = {
    version: '1.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlanSha256: sha256(planText),
    downloadedAt: plan.formalCapture.startedAt,
    downloadOperation: 'figma:export-node',
    files: [],
  };

  for (const [file, value] of [
    ['capture-plan.schema.json', plan],
    ['figma-design-context.schema.json', context],
    ['ingest-receipt.schema.json', receipt],
    ['source-registration.schema.json', registration],
    ['acquisition-packet.schema.json', acquisition],
  ]) {
    const validate = validator(await schema(file));
    assert.equal(validate(value), true, file + ': ' + JSON.stringify(validate.errors));
  }
});

test('old shapes and Canonical UI identifiers are rejected without a compatibility branch', async () => {
  const plan = validCapturePlan();
  delete plan.scopeConfirmation.sourceVersion;
  const validatePlan = validator(await schema('capture-plan.schema.json'));
  assert.equal(validatePlan(plan), false);

  const context = validDesignContext(validCapturePlan(), 'sha256:' + '8'.repeat(64));
  delete context.rawCapture;
  const validateContext = validator(await schema('figma-design-context.schema.json'));
  assert.equal(validateContext(context), false);

  const contextWithoutScreenRoot = validDesignContext(validCapturePlan(), 'sha256:' + '8'.repeat(64));
  delete contextWithoutScreenRoot.components.find((item) => item.kind === 'instance').screenRootNodeId;
  assert.equal(validateContext(contextWithoutScreenRoot), false);

  const validateRegistration = validator(await schema('source-registration.schema.json'));
  const invalidHandshake = {
    version: '2.0.0',
    sourceId: 'DESIGN-SOURCE-001',
    sourceVersion: sourceVersion(),
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: 'sha256:' + '1'.repeat(64),
    capturePlan: { path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json', sha256: 'sha256:' + '2'.repeat(64) },
    designContext: { path: 'design-sources/DESIGN-SOURCE-001/design-context.json', sha256: 'sha256:' + '3'.repeat(64) },
    ingestReceipt: { path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json', sha256: 'sha256:' + '4'.repeat(64) },
    componentHandshake: [{
      proposalNodeId: '1:2',
      decision: 'local-structure',
      semanticRole: 'Local status',
      reason: 'Only one local use.',
      counterexample: 'Shared status cards have a different contract.',
      finalNodeIds: ['1:2'],
      structureSignatures: ['sha256:' + '5'.repeat(64)],
      componentId: 'COMPONENT-001',
    }],
    assets: [],
    gaps: [],
  };
  assert.equal(validateRegistration(invalidHandshake), false);
});

test('ingest validator recomputes confirmation hashes and checks visual/component set equality', async () => {
  const valid = await runIngest(validCapturePlan());
  const validCodes = new Set((valid.blockers || []).map((item) => item.code));
  assert.equal(validCodes.has('AIH_SOURCE_INTEGRITY_FAILED'), false, JSON.stringify(valid, null, 2));
  assert.equal(validCodes.has('AIH_ASSET_CLASSIFICATION_INCOMPLETE'), false, JSON.stringify(valid, null, 2));
  assert.equal(validCodes.has('AIH_COMPONENT_ABSTRACTION_UNRESOLVED'), false, JSON.stringify(valid, null, 2));

  const alteredConfirmation = validCapturePlan();
  alteredConfirmation.scopeConfirmation.includedNodes[0].name = 'Changed after confirmation';
  const altered = await runIngest(alteredConfirmation);
  assert.ok(
    new Set(altered.blockers.map((item) => item.code)).has('AIH_SOURCE_INTEGRITY_FAILED'),
    JSON.stringify(altered, null, 2),
  );

  const missingVisual = validCapturePlan();
  missingVisual.scopeConfirmation.includedNodes.push({ kind: 'visual', nodeId: '1:3', name: 'Unclassified visual' });
  missingVisual.scopeConfirmation.scanInventory.nodes.push({ kind: 'visual', nodeId: '1:3', name: 'Unclassified visual' });
  missingVisual.scopeConfirmation.counts.visualNodes = 2;
  missingVisual.scopeConfirmation.sha256 = confirmationSha256(missingVisual.scopeConfirmation);
  missingVisual.highImpactConfirmation.scopeConfirmationSha256 = missingVisual.scopeConfirmation.sha256;
  missingVisual.highImpactConfirmation.sha256 = confirmationSha256(missingVisual.highImpactConfirmation);
  missingVisual.writebackBoundary.highImpactConfirmationSha256 = missingVisual.highImpactConfirmation.sha256;
  const visualResult = await runIngest(missingVisual);
  assert.ok(new Set(visualResult.blockers.map((item) => item.code)).has('AIH_ASSET_CLASSIFICATION_INCOMPLETE'));

  const missingComponent = validCapturePlan();
  missingComponent.highImpactConfirmation.componentProposals = [];
  missingComponent.highImpactConfirmation.stateAxes = [];
  missingComponent.highImpactConfirmation.sha256 = confirmationSha256(missingComponent.highImpactConfirmation);
  missingComponent.writebackBoundary.highImpactConfirmationSha256 = missingComponent.highImpactConfirmation.sha256;
  const componentResult = await runIngest(missingComponent);
  assert.ok(new Set(componentResult.blockers.map((item) => item.code)).has('AIH_COMPONENT_ABSTRACTION_UNRESOLVED'));

  const overlappingGroups = validCapturePlan();
  overlappingGroups.highImpactConfirmation.componentProposals.push({
    ...structuredClone(overlappingGroups.highImpactConfirmation.componentProposals[0]),
    id: 'COMPONENT-PROPOSAL-002',
  });
  overlappingGroups.highImpactConfirmation.stateAxes.push({
    ...structuredClone(overlappingGroups.highImpactConfirmation.stateAxes[0]),
    id: 'STATE-AXIS-MODE-002',
    proposalId: 'COMPONENT-PROPOSAL-002',
  });
  overlappingGroups.highImpactConfirmation.sha256 = confirmationSha256(overlappingGroups.highImpactConfirmation);
  overlappingGroups.writebackBoundary.highImpactConfirmationSha256 = overlappingGroups.highImpactConfirmation.sha256;
  const overlapResult = await runIngest(overlappingGroups);
  assert.ok(new Set(overlapResult.blockers.map((item) => item.code)).has('AIH_COMPONENT_ABSTRACTION_UNRESOLVED'));

  const incompleteInterface = validCapturePlan();
  incompleteInterface.highImpactConfirmation.componentProposals[0].interfaceProposal.properties[0].values.pop();
  incompleteInterface.highImpactConfirmation.sha256 = confirmationSha256(incompleteInterface.highImpactConfirmation);
  incompleteInterface.writebackBoundary.highImpactConfirmationSha256 = incompleteInterface.highImpactConfirmation.sha256;
  const interfaceResult = await runIngest(incompleteInterface);
  assert.ok(new Set(interfaceResult.blockers.map((item) => item.code)).has('AIH_COMPONENT_VARIANT_COVERAGE_FAILED'));

  const incompleteBindingMatrix = validCapturePlan();
  const incompleteScope = incompleteBindingMatrix.scopeConfirmation;
  incompleteScope.viewportIds = ['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'];
  incompleteScope.scenarioIds = ['SCENARIO-001', 'SCENARIO-002'];
  incompleteScope.screenBindings = [
    {
      screenId: 'SCREEN-STATUS',
      figmaRootNodeId: '1:2',
      viewportId: 'VIEWPORT-MOBILE',
      scenarioId: 'SCENARIO-001',
      stateIds: ['STATE-DEFAULT'],
    },
    {
      screenId: 'SCREEN-STATUS',
      figmaRootNodeId: '1:2',
      viewportId: 'VIEWPORT-DESKTOP',
      scenarioId: 'SCENARIO-002',
      stateIds: ['STATE-DEFAULT'],
    },
  ];
  incompleteScope.counts.viewports = 2;
  incompleteScope.counts.scenarios = 2;
  incompleteScope.sha256 = confirmationSha256(incompleteScope);
  incompleteBindingMatrix.highImpactConfirmation.scopeConfirmationSha256 = incompleteScope.sha256;
  incompleteBindingMatrix.highImpactConfirmation.sha256 = confirmationSha256(incompleteBindingMatrix.highImpactConfirmation);
  incompleteBindingMatrix.writebackBoundary.highImpactConfirmationSha256 = incompleteBindingMatrix.highImpactConfirmation.sha256;
  const incompleteBindingResult = await runIngest(incompleteBindingMatrix);
  assert.ok(
    incompleteBindingResult.blockers.some((item) => (
      item.code === 'AIH_SOURCE_CAPTURE_BLOCKED'
      && item.message.includes('Viewport × Scenario')
    )),
    JSON.stringify(incompleteBindingResult, null, 2),
  );
});

test('registration mode closes Raw Capture, Component Set definitions, and Instance usage without writing', async () => {
  const valid = await runRegistration();
  assert.equal(valid.status, 'PASS', JSON.stringify(valid, null, 2));
  assert.equal(valid.componentHandshakes, 1);

  const missingDefinition = await runRegistration(({ registration }) => {
    registration.componentHandshake[0].variantDefinitionNodeIds = ['2:2'];
  });
  assert.ok(
    new Set(missingDefinition.blockers.map((item) => item.code)).has('AIH_COMPONENT_VARIANT_COVERAGE_FAILED'),
    JSON.stringify(missingDefinition, null, 2),
  );

  const wrongScreen = await runRegistration(({ registration }) => {
    registration.componentHandshake[0].usageBindings[0].screenId = 'SCREEN-UNKNOWN';
  });
  assert.ok(
    new Set(wrongScreen.blockers.map((item) => item.code)).has('AIH_COMPONENT_VARIANT_COVERAGE_FAILED'),
    JSON.stringify(wrongScreen, null, 2),
  );

  const missingBaseline = await runRegistration(({ registration }) => {
    registration.componentHandshake[0].baselineEvidenceItemIds = ['EVIDENCE-UNKNOWN-001'];
  });
  assert.ok(
    new Set(missingBaseline.blockers.map((item) => item.code)).has('AIH_SOURCE_INTEGRITY_FAILED'),
    JSON.stringify(missingBaseline, null, 2),
  );
});
