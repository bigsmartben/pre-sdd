import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { createSchemaValidatorCache } from '../scripts/lib/figma-contract-validation.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../../../..');
const skillRoot = resolve(repositoryRoot, '.agents/skills/figma-workflow');
const ingestScript = resolve(skillRoot, 'scripts/ingest-assets.mjs');

test('schema validator cache loads and compiles each schema path once per process', async () => {
  let loadCount = 0;
  const cache = createSchemaValidatorCache(async () => {
    loadCount += 1;
    return {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      required: ['id'],
      properties: { id: { type: 'string' } },
      additionalProperties: false,
    };
  });

  const [first, second, schema] = await Promise.all([
    cache.get('fixture.schema.json'),
    cache.get('fixture.schema.json'),
    cache.schema('fixture.schema.json'),
  ]);

  assert.equal(first, second);
  assert.equal(loadCount, 1);
  assert.equal(first({ id: 'ok' }), true);
  assert.equal(schema.type, 'object');
});

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function contentSha(value) {
  const payload = { ...value };
  delete payload.sha256;
  return sha256(Buffer.from(canonicalJson(payload), 'utf8'));
}

function sourceVersion(value = 'fixture-version-1') {
  return { kind: 'figma-file-version', value };
}

function visualAssetCandidate() {
  return {
    nodeId: '3:1',
    name: 'Status artwork',
    strategy: 'asset',
    assetBoundaryNodeId: '3:1',
    assetKind: 'illustration',
    captureScope: 'artwork-subtree',
    containsDynamicContent: false,
    consumerTargets: ['COMPONENT-STATUS'],
    assetExport: {
      format: 'svg',
      scale: 1,
      cropBounds: { x: 0, y: 0, width: 16, height: 16 },
      transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      expectedDimensions: { width: 16, height: 16 },
      targetPath: 'public/assets/DESIGN-SOURCE-001/status-artwork.svg',
      downloadOperation: 'figma:export-node',
    },
  };
}

function validPlan() {
  const version = sourceVersion();
  const scanInventory = {
    scannedAt: '2026-07-15T09:50:00Z',
    sourceVersion: version,
    rootNodeId: '1:2',
    nodes: [
      { kind: 'page', nodeId: '1:1', name: 'Status', visible: true },
      { kind: 'frame', nodeId: '1:2', name: 'Status screen', visible: true, parentNodeId: '1:1' },
      { kind: 'component-set', nodeId: '2:1', name: 'StatusCard', visible: true, parentNodeId: '1:1' },
      { kind: 'component', nodeId: '2:2', name: 'Mode=Default', visible: true, parentNodeId: '2:1' },
      { kind: 'component', nodeId: '2:3', name: 'Mode=Busy', visible: true, parentNodeId: '2:1' },
      { kind: 'instance', nodeId: '1:3', name: 'StatusCard instance', visible: true, parentNodeId: '1:2' },
      { kind: 'group', nodeId: '3:1', name: 'Status artwork', visible: true, parentNodeId: '1:2' },
      { kind: 'visual', nodeId: '3:2', name: 'Border', visible: true, parentNodeId: '3:1' },
      { kind: 'image', nodeId: '3:3', name: 'Icon', visible: true, parentNodeId: '3:1' },
    ],
  };
  const pageCoverage = [{ expectedPageId: 'PAGE-STATUS', figmaPageNodeId: '1:1', status: 'PASS' }];
  const groupIntegrity = [{
    groupNodeId: '3:1',
    memberNodeIds: ['3:2', '3:3'],
    containsVisualContent: true,
    assetBoundaryNodeId: '3:1',
    status: 'PASS',
  }];
  const imageGroupCoverage = [{
    imageNodeId: '3:3',
    ownerGroupNodeId: '3:1',
    expectedGroupNodeId: '3:1',
    status: 'PASS',
  }];
  const stateCoverage = [{
    screenId: 'SCREEN-STATUS',
    stateId: 'STATE-DEFAULT',
    figmaNodeIds: ['1:2'],
    status: 'PASS',
  }];
  const variantCoverage = [{
    proposalId: 'COMPONENT-PROPOSAL-001',
    axisName: 'Mode',
    expectedValues: ['Default', 'Busy'],
    observedValues: ['Default', 'Busy'],
    definitionNodeIds: ['2:2', '2:3'],
    status: 'PASS',
  }];
  const componentProposal = {
    id: 'COMPONENT-PROPOSAL-001',
    nodeIds: ['2:1', '2:2', '2:3', '1:3'],
    decision: 'shared-component',
    structureSignatures: ['sha256:' + '2'.repeat(64), 'sha256:' + '3'.repeat(64)],
    componentBoundary: {
      kind: 'component-set',
      rootNodeId: '2:1',
      nestedComponentNodeIds: ['2:2', '2:3', '1:3'],
    },
    figmaComponentContract: {
      name: 'StatusCard',
      properties: [{ name: 'Mode', kind: 'variant', values: ['Default', 'Busy'] }],
      variantAxes: [{ name: 'Mode', values: ['Default', 'Busy'] }],
      contentRegions: [{ name: 'Label', role: 'status-text' }],
      nestedComponentNodeIds: [],
      sizeBehavior: { width: 'fill', height: 'hug', wrap: 'content' },
    },
  };
  const scopeAudit = {
    id: 'SCOPE-AUDIT-001',
    sha256: 'sha256:' + '0'.repeat(64),
    scopeMode: 'file',
    sourceVersion: version,
    rootNodeId: '1:2',
    scanInventory,
    screenBindings: [{
      screenId: 'SCREEN-STATUS',
      figmaRootNodeId: '1:2',
      viewportId: 'VIEWPORT-DESKTOP',
      scenarioId: 'SCENARIO-DEFAULT',
      stateIds: ['STATE-DEFAULT'],
    }],
    includedNodes: scanInventory.nodes.map(({ kind, nodeId, name }) => ({ kind, nodeId, name })),
    excludedNodes: [],
    pageCoverage,
    groupIntegrity,
    imageGroupCoverage,
    stateCoverage,
    variantCoverage,
    findings: [],
    writebackPlan: [],
    componentProposals: [componentProposal],
  };
  scopeAudit.sha256 = contentSha(scopeAudit);
  const writebackApproval = {
    id: 'WRITEBACK-APPROVAL-001',
    sha256: 'sha256:' + '0'.repeat(64),
    confirmedBy: 'user:fixture-reviewer',
    confirmedAt: '2026-07-15T09:52:00Z',
    sourceVersion: version,
    scopeAuditId: scopeAudit.id,
    scopeAuditSha256: scopeAudit.sha256,
    operationIds: [],
    detachApprovals: [],
  };
  writebackApproval.sha256 = contentSha(writebackApproval);
  const postWriteAudit = {
    scanInventory: { ...scanInventory, scannedAt: '2026-07-15T09:54:00Z' },
    pageCoverage,
    groupIntegrity,
    imageGroupCoverage,
    stateCoverage,
    variantCoverage,
    findings: [],
  };
  const writebackReceipt = {
    id: 'WRITEBACK-RECEIPT-001',
    sha256: 'sha256:' + '0'.repeat(64),
    writebackApprovalId: writebackApproval.id,
    writebackApprovalSha256: writebackApproval.sha256,
    sourceVersionBefore: version,
    sourceVersionAfter: version,
    operationIds: [],
    beforeInventorySha256: 'sha256:' + '4'.repeat(64),
    afterInventorySha256: 'sha256:' + '4'.repeat(64),
    screenshotEvidenceItemIds: ['EVIDENCE-BEFORE-001', 'EVIDENCE-AFTER-001'],
    postWriteAudit,
    completedAt: '2026-07-15T09:55:00Z',
  };
  writebackReceipt.sha256 = contentSha(writebackReceipt);
  const finalFigmaAcceptance = {
    id: 'FINAL-FIGMA-ACCEPTANCE-001',
    sha256: 'sha256:' + '0'.repeat(64),
    confirmedBy: 'user:fixture-reviewer',
    confirmedAt: '2026-07-15T09:56:00Z',
    sourceVersion: version,
    writebackReceiptId: writebackReceipt.id,
    writebackReceiptSha256: writebackReceipt.sha256,
    result: 'accepted',
  };
  finalFigmaAcceptance.sha256 = contentSha(finalFigmaAcceptance);
  return {
    version: '3.0.0',
    sourceId: 'DESIGN-SOURCE-001',
    rootNodeId: '1:2',
    sourceVersion: version,
    scopeAudit,
    writebackApproval,
    writebackReceipt,
    finalFigmaAcceptance,
    frozenAt: '2026-07-15T09:57:00Z',
    formalCapture: {
      ordinal: 1,
      startedAt: '2026-07-15T09:58:00Z',
      completedAt: '2099-07-15T10:30:00Z',
      sourceVersionBefore: version,
      sourceVersionAfter: version,
    },
    candidateVisualNodes: [
      visualAssetCandidate(),
      { nodeId: '3:2', name: 'Border', strategy: 'ignored', assetBoundaryNodeId: '3:1', reason: 'covered-by-asset-boundary:3:1' },
      { nodeId: '3:3', name: 'Icon', strategy: 'ignored', assetBoundaryNodeId: '3:1', reason: 'covered-by-asset-boundary:3:1' },
    ],
  };
}

function validContext(plan, planHash) {
  const definitionSignature = 'sha256:' + '3'.repeat(64);
  return {
    version: '4.0.0',
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
    visualNodeCatalog: [
      { nodeId: '3:1', parentNodeId: '1:2', visible: true, hasPaint: true, hasStroke: false, hasEffect: false, hasMask: false, hasRaster: false, isText: false, assetBoundaryNodeId: '3:1' },
      { nodeId: '3:2', parentNodeId: '3:1', visible: true, hasPaint: false, hasStroke: true, hasEffect: false, hasMask: false, hasRaster: false, isText: false, assetBoundaryNodeId: '3:1' },
      { nodeId: '3:3', parentNodeId: '3:1', visible: true, hasPaint: false, hasStroke: false, hasEffect: false, hasMask: false, hasRaster: true, isText: false, assetBoundaryNodeId: '3:1' },
    ],
    components: [
      { nodeId: '2:1', name: 'StatusCard', kind: 'component-set', componentKey: 'status-card', componentSetNodeId: '2:1', mainComponentNodeId: null, structureSignature: 'sha256:' + '2'.repeat(64), variantProperties: {} },
      { nodeId: '2:2', name: 'Mode=Default', kind: 'component', componentKey: 'status-default', componentSetNodeId: '2:1', mainComponentNodeId: '2:2', structureSignature: definitionSignature, variantProperties: { Mode: 'Default' } },
      { nodeId: '2:3', name: 'Mode=Busy', kind: 'component', componentKey: 'status-busy', componentSetNodeId: '2:1', mainComponentNodeId: '2:3', structureSignature: definitionSignature, variantProperties: { Mode: 'Busy' } },
      { nodeId: '1:3', name: 'StatusCard instance', kind: 'instance', componentKey: 'status-default', componentSetNodeId: '2:1', mainComponentNodeId: '2:2', screenRootNodeId: '1:2', structureSignature: definitionSignature, variantProperties: { Mode: 'Default' } },
    ],
    componentSetCatalog: [{
      componentSetNodeId: '2:1',
      axes: [{ name: 'Mode', values: ['Default', 'Busy'] }],
      definitionNodeIds: ['2:2', '2:3'],
    }],
    assets: [{
      nodeId: '3:1',
      assetBoundaryNodeId: '3:1',
      assetKind: 'illustration',
      captureScope: 'artwork-subtree',
      containsDynamicContent: false,
      recommendedFormat: 'svg',
    }],
  };
}

function refreshWorkflowHashes(plan) {
  plan.scopeAudit.sha256 = contentSha(plan.scopeAudit);
  plan.writebackApproval.scopeAuditSha256 = plan.scopeAudit.sha256;
  plan.writebackApproval.sha256 = contentSha(plan.writebackApproval);
  plan.writebackReceipt.writebackApprovalSha256 = plan.writebackApproval.sha256;
  plan.writebackReceipt.sha256 = contentSha(plan.writebackReceipt);
  plan.finalFigmaAcceptance.writebackReceiptSha256 = plan.writebackReceipt.sha256;
  plan.finalFigmaAcceptance.sha256 = contentSha(plan.finalFigmaAcceptance);
  return plan;
}

async function schema(name) {
  return JSON.parse(await readFile(resolve(skillRoot, name), 'utf8'));
}

function validator(value) {
  return new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(value);
}

async function runIngest(plan = validPlan()) {
  const session = await mkdtemp(resolve(tmpdir(), 'figma-workflow-ingest-'));
  const planPath = resolve(session, 'capture-plan.json');
  const planContent = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const assetContent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>\n');
  await writeFile(resolve(session, 'status-artwork.svg'), assetContent);
  const acquisition = {
    version: '2.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlanSha256: sha256(planContent),
    downloadedAt: plan.formalCapture.startedAt,
    downloadOperation: 'figma:export-node',
    files: [{
      sourceNodeId: '3:1',
      assetBoundaryNodeId: '3:1',
      path: 'status-artwork.svg',
      targetPath: 'public/assets/DESIGN-SOURCE-001/status-artwork.svg',
      assetKind: 'illustration',
      captureScope: 'artwork-subtree',
      containsDynamicContent: false,
      format: 'svg',
      scale: 1,
      cropBounds: { x: 0, y: 0, width: 16, height: 16 },
      transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      dimensions: { width: 16, height: 16 },
      sha256: sha256(assetContent),
    }],
  };
  const acquisitionPath = resolve(session, 'acquisition.json');
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
  const session = await mkdtemp(resolve(tmpdir(), 'figma-registration-'));
  const workspace = resolve(session, 'workspace');
  const area = resolve(workspace, '01-product-design/Canonical-UI-Prototypes/ACTOR-001');
  const source = resolve(area, 'design-sources/DESIGN-SOURCE-001');
  await Promise.all([
    mkdir(resolve(workspace, '.agents/skills/figma-workflow'), { recursive: true }),
    mkdir(resolve(workspace, '.agents/skills/product-design/canonical-ui-prototype'), { recursive: true }),
    mkdir(resolve(area, 'public/assets/DESIGN-SOURCE-001'), { recursive: true }),
    mkdir(source, { recursive: true }),
  ]);
  const project = parseYaml(await readFile(resolve(repositoryRoot, 'psp.project.yaml'), 'utf8'));
  project.stages['product-design'].status = 'active';
  await Promise.all([
    writeFile(resolve(workspace, 'psp.project.yaml'), stringifyYaml(project)),
    ...['capture-plan.schema.json', 'figma-design-context.schema.json', 'ingest-receipt.schema.json', 'source-registration.schema.json']
      .map((name) => copyFile(resolve(skillRoot, name), resolve(workspace, '.agents/skills/figma-workflow', name))),
    copyFile(
      resolve(repositoryRoot, '.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json'),
      resolve(workspace, '.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json'),
    ),
  ]);

  const plan = validPlan();
  let planContent = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  let planHash = sha256(planContent);
  const rawContent = Buffer.from(JSON.stringify({ source: 'figma', nodeId: plan.rootNodeId }) + '\n');
  const context = validContext(plan, planHash);
  context.rawCapture.sha256 = sha256(rawContent);
  let contextContent = Buffer.from(JSON.stringify(context, null, 2) + '\n');
  const assetContent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>\n');
  const receipt = {
    version: '2.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlan: { path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json', sha256: planHash },
    downloadOperation: 'figma:export-node',
    ingestedAt: plan.formalCapture.startedAt,
    assets: [{
      sourceNodeId: '3:1',
      assetBoundaryNodeId: '3:1',
      path: 'public/assets/DESIGN-SOURCE-001/status-artwork.svg',
      assetKind: 'illustration',
      captureScope: 'artwork-subtree',
      containsDynamicContent: false,
      format: 'svg',
      scale: 1,
      cropBounds: { x: 0, y: 0, width: 16, height: 16 },
      transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      expectedDimensions: { width: 16, height: 16 },
      sha256: sha256(assetContent),
      consumerTargets: ['COMPONENT-STATUS'],
      status: 'verified',
    }],
    status: 'PASS',
  };
  let receiptContent = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  const screenshotContent = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>\n');
  const evidence = {
    version: '6.0.0',
    sourceId: plan.sourceId,
    kind: 'figma',
    location: 'https://www.figma.com/design/example/example?node-id=1-2',
    capturedAt: plan.formalCapture.startedAt,
    nodeId: plan.rootNodeId,
    sourceVersion: plan.sourceVersion,
    items: [
      { id: 'EVIDENCE-RAW-001', role: 'raw-design-context', path: 'design-sources/DESIGN-SOURCE-001/raw-design-context.json', sha256: sha256(rawContent) },
      { id: 'EVIDENCE-CONTEXT-001', role: 'design-context', path: 'design-sources/DESIGN-SOURCE-001/design-context.json', sha256: sha256(contextContent), schema: 'https://psp.dev/adapters/figma/design-context.schema.json' },
      { id: 'EVIDENCE-PLAN-001', role: 'capture-plan', path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json', sha256: planHash, schema: 'https://psp.dev/skills/figma-workflow/capture-plan.schema.json' },
      { id: 'EVIDENCE-RECEIPT-001', role: 'ingest-receipt', path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json', sha256: sha256(receiptContent), schema: 'https://psp.dev/adapters/figma/ingest-receipt.schema.json' },
      { id: 'EVIDENCE-SCREENSHOT-001', role: 'screenshot', path: 'design-sources/DESIGN-SOURCE-001/node-screenshot.svg', sha256: sha256(screenshotContent) },
      {
        id: 'EVIDENCE-ASSET-001',
        role: 'asset',
        path: 'public/assets/DESIGN-SOURCE-001/status-artwork.svg',
        sha256: sha256(assetContent),
        sourceNodeId: '3:1',
        assetBoundaryNodeId: '3:1',
        assetKind: 'illustration',
        captureScope: 'artwork-subtree',
        containsDynamicContent: false,
        strategy: 'asset',
        format: 'svg',
        scale: 1,
        cropBounds: { x: 0, y: 0, width: 16, height: 16 },
        transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
        expectedDimensions: { width: 16, height: 16 },
        downloadOperation: 'figma:export-node',
        consumerTargets: ['COMPONENT-STATUS'],
        status: 'verified',
      },
    ],
  };
  let evidenceContent = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
  await Promise.all([
    writeFile(resolve(source, 'capture-plan.json'), planContent),
    writeFile(resolve(source, 'raw-design-context.json'), rawContent),
    writeFile(resolve(source, 'design-context.json'), contextContent),
    writeFile(resolve(source, 'ingest-receipt.json'), receiptContent),
    writeFile(resolve(source, 'node-screenshot.svg'), screenshotContent),
    writeFile(resolve(source, 'evidence.json'), evidenceContent),
    writeFile(resolve(area, 'public/assets/DESIGN-SOURCE-001/status-artwork.svg'), assetContent),
  ]);

  const proposal = plan.scopeAudit.componentProposals[0];
  const registration = {
    version: '3.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: sha256(evidenceContent),
    capturePlan: receipt.capturePlan,
    designContext: { path: 'design-sources/DESIGN-SOURCE-001/design-context.json', sha256: sha256(contextContent) },
    ingestReceipt: { path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json', sha256: sha256(receiptContent) },
    componentHandshake: [{
      proposalId: proposal.id,
      decision: proposal.decision,
      finalNodeIds: proposal.nodeIds,
      structureSignatures: proposal.structureSignatures,
      figmaComponentContract: proposal.figmaComponentContract,
      usageBindings: [{ instanceNodeId: '1:3', screenId: 'SCREEN-STATUS' }],
      baselineEvidenceItemIds: ['EVIDENCE-SCREENSHOT-001'],
      figmaComponentNodeId: '2:1',
      variantDefinitionNodeIds: ['2:2', '2:3'],
      variantUsageInstanceNodeIds: ['1:3'],
    }],
    assets: [{
      path: 'public/assets/DESIGN-SOURCE-001/status-artwork.svg',
      sourceNodeId: '3:1',
      assetBoundaryNodeId: '3:1',
      assetKind: 'illustration',
      captureScope: 'artwork-subtree',
      containsDynamicContent: false,
      strategy: 'asset',
      format: 'svg',
      scale: 1,
      cropBounds: { x: 0, y: 0, width: 16, height: 16 },
      transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      expectedDimensions: { width: 16, height: 16 },
      sha256: sha256(assetContent),
      downloadOperation: 'figma:export-node',
      consumerTargets: ['COMPONENT-STATUS'],
      status: 'verified',
    }],
    gaps: [],
  };
  await mutator({ registration, plan, context, evidence });
  planContent = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  planHash = sha256(planContent);
  context.rawCapture.capturePlanSha256 = planHash;
  contextContent = Buffer.from(JSON.stringify(context, null, 2) + '\n');
  receipt.capturePlan.sha256 = planHash;
  receiptContent = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  const evidenceByRole = new Map(evidence.items.map((item) => [item.role, item]));
  evidenceByRole.get('design-context').sha256 = sha256(contextContent);
  evidenceByRole.get('capture-plan').sha256 = planHash;
  evidenceByRole.get('ingest-receipt').sha256 = sha256(receiptContent);
  evidenceContent = Buffer.from(JSON.stringify(evidence, null, 2) + '\n');
  registration.evidenceSha256 = sha256(evidenceContent);
  registration.capturePlan.sha256 = planHash;
  registration.designContext.sha256 = sha256(contextContent);
  registration.ingestReceipt.sha256 = sha256(receiptContent);
  await Promise.all([
    writeFile(resolve(source, 'capture-plan.json'), planContent),
    writeFile(resolve(source, 'design-context.json'), contextContent),
    writeFile(resolve(source, 'ingest-receipt.json'), receiptContent),
    writeFile(resolve(source, 'evidence.json'), evidenceContent),
  ]);
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

test('new Figma workflow schemas accept the provider-neutral v3 contract and reject legacy fields', async () => {
  const plan = validPlan();
  const planText = Buffer.from(JSON.stringify(plan, null, 2) + '\n');
  const context = validContext(plan, sha256(planText));
  const validatePlan = validator(await schema('capture-plan.schema.json'));
  const validateContext = validator(await schema('figma-design-context.schema.json'));
  assert.equal(validatePlan(plan), true, JSON.stringify(validatePlan.errors));
  assert.equal(validateContext(context), true, JSON.stringify(validateContext.errors));

  const legacyStrategy = structuredClone(plan);
  legacyStrategy.candidateVisualNodes[0].strategy = 'dom-css';
  assert.equal(validatePlan(legacyStrategy), false);
  const legacyConfirmation = structuredClone(plan);
  legacyConfirmation.scopeConfirmation = {};
  assert.equal(validatePlan(legacyConfirmation), false);
  const leakedLit = structuredClone(plan);
  leakedLit.scopeAudit.componentProposals[0].figmaComponentContract.litProperty = 'mode';
  assert.equal(validatePlan(leakedLit), false);
});

test('audit, approval and final acceptance gates emit stable blockers', async () => {
  const missingPage = validPlan();
  missingPage.scopeAudit.pageCoverage[0].status = 'FAIL';
  missingPage.scopeAudit.pageCoverage[0].reason = 'Expected page is missing.';
  missingPage.scopeAudit.sha256 = contentSha(missingPage.scopeAudit);
  missingPage.writebackApproval.scopeAuditSha256 = missingPage.scopeAudit.sha256;
  missingPage.writebackApproval.sha256 = contentSha(missingPage.writebackApproval);
  missingPage.writebackReceipt.writebackApprovalSha256 = missingPage.writebackApproval.sha256;
  missingPage.writebackReceipt.sha256 = contentSha(missingPage.writebackReceipt);
  missingPage.finalFigmaAcceptance.writebackReceiptSha256 = missingPage.writebackReceipt.sha256;
  missingPage.finalFigmaAcceptance.sha256 = contentSha(missingPage.finalFigmaAcceptance);
  const pageResult = await runIngest(missingPage);
  assert.ok(pageResult.blockers.some((item) => item.code === 'AIH_FIGMA_AUDIT_INCOMPLETE'));

  const wrongGroup = validPlan();
  wrongGroup.scopeAudit.groupIntegrity[0].assetBoundaryNodeId = '3:2';
  const groupResult = await runIngest(refreshWorkflowHashes(wrongGroup));
  assert.ok(groupResult.blockers.some((item) => item.code === 'AIH_FIGMA_VISUAL_POLICY_VIOLATION'));

  const crossGroupImage = validPlan();
  crossGroupImage.scopeAudit.imageGroupCoverage[0].ownerGroupNodeId = '1:2';
  const imageResult = await runIngest(refreshWorkflowHashes(crossGroupImage));
  assert.ok(imageResult.blockers.some((item) => item.code === 'AIH_FIGMA_AUDIT_INCOMPLETE'));

  const missingState = validPlan();
  missingState.scopeAudit.stateCoverage[0].figmaNodeIds = [];
  const stateResult = await runIngest(refreshWorkflowHashes(missingState));
  assert.ok(stateResult.blockers.some((item) => item.code === 'AIH_FIGMA_AUDIT_INCOMPLETE'));

  const missingVariant = validPlan();
  missingVariant.scopeAudit.variantCoverage[0].observedValues = ['Default'];
  const variantResult = await runIngest(refreshWorkflowHashes(missingVariant));
  assert.ok(variantResult.blockers.some((item) => item.code === 'AIH_COMPONENT_VARIANT_COVERAGE_FAILED'));

  const staleAcceptance = validPlan();
  staleAcceptance.finalFigmaAcceptance.sourceVersion = sourceVersion('stale');
  staleAcceptance.finalFigmaAcceptance.sha256 = contentSha(staleAcceptance.finalFigmaAcceptance);
  const acceptanceResult = await runIngest(staleAcceptance);
  assert.ok(acceptanceResult.blockers.some((item) => item.code === 'AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED'));

  const unapproved = validPlan();
  unapproved.scopeAudit.writebackPlan = [{
    id: 'WRITEBACK-001',
    kind: 'rename',
    targetNodeIds: ['1:2'],
    reason: 'Normalize the screen name.',
  }];
  unapproved.scopeAudit.sha256 = contentSha(unapproved.scopeAudit);
  unapproved.writebackApproval.scopeAuditSha256 = unapproved.scopeAudit.sha256;
  unapproved.writebackApproval.sha256 = contentSha(unapproved.writebackApproval);
  unapproved.writebackReceipt.writebackApprovalSha256 = unapproved.writebackApproval.sha256;
  unapproved.writebackReceipt.sha256 = contentSha(unapproved.writebackReceipt);
  unapproved.finalFigmaAcceptance.writebackReceiptSha256 = unapproved.writebackReceipt.sha256;
  unapproved.finalFigmaAcceptance.sha256 = contentSha(unapproved.finalFigmaAcceptance);
  const approvalResult = await runIngest(unapproved);
  assert.ok(approvalResult.blockers.some((item) => item.code === 'AIH_FIGMA_WRITEBACK_UNAPPROVED'));
});

test('visual Group is one Asset Boundary and layout cannot carry visual paint', async () => {
  const splitGroup = validPlan();
  splitGroup.candidateVisualNodes[1].strategy = 'asset';
  splitGroup.candidateVisualNodes[1].assetBoundaryNodeId = '3:2';
  splitGroup.candidateVisualNodes[1].assetKind = 'effect';
  splitGroup.candidateVisualNodes[1].captureScope = 'layer';
  splitGroup.candidateVisualNodes[1].containsDynamicContent = false;
  splitGroup.candidateVisualNodes[1].consumerTargets = ['COMPONENT-STATUS'];
  splitGroup.candidateVisualNodes[1].assetExport = {
    ...visualAssetCandidate().assetExport,
    targetPath: 'public/assets/DESIGN-SOURCE-001/border.svg',
  };
  delete splitGroup.candidateVisualNodes[1].reason;
  const splitResult = await runIngest(splitGroup);
  assert.ok(splitResult.blockers.some((item) => item.code === 'AIH_FIGMA_VISUAL_POLICY_VIOLATION'));

  const layoutResult = await runRegistration(({ plan, context }) => {
    const candidate = plan.candidateVisualNodes[0];
    candidate.strategy = 'layout';
    candidate.assetBoundaryNodeId = null;
    delete candidate.assetKind;
    delete candidate.captureScope;
    delete candidate.containsDynamicContent;
    delete candidate.consumerTargets;
    delete candidate.assetExport;
    context.visualNodeCatalog[0].assetBoundaryNodeId = null;
  });
  assert.ok(layoutResult.blockers.some((item) => item.code === 'AIH_FIGMA_VISUAL_POLICY_VIOLATION'));
});

test('registration closes Figma-only component, variant, screen and asset evidence', async () => {
  const valid = await runRegistration();
  assert.equal(valid.status, 'PASS', JSON.stringify(valid, null, 2));
  assert.equal(valid.componentHandshakes, 1);

  const missingDefinition = await runRegistration(({ registration }) => {
    registration.componentHandshake[0].variantDefinitionNodeIds = ['2:2'];
  });
  assert.ok(missingDefinition.blockers.some((item) => item.code === 'AIH_COMPONENT_VARIANT_COVERAGE_FAILED'));

  const wrongScreen = await runRegistration(({ registration }) => {
    registration.componentHandshake[0].usageBindings[0].screenId = 'SCREEN-UNKNOWN';
  });
  assert.ok(wrongScreen.blockers.some((item) => item.code === 'AIH_COMPONENT_VARIANT_COVERAGE_FAILED'));
});
