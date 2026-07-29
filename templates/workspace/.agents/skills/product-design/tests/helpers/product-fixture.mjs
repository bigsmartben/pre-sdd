import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runScript } from './fixture.mjs';

export async function fixtureProject(root) {
  return parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
}

export async function readArtifact(root, stage, binding, format = 'yaml', actor = 'ACTOR-001') {
  const path = binding.internalModelSet
    ? resolve(root, stage.root, binding.internalModelSet.root, actor, binding.internalModelSet.member)
    : resolve(root, stage.root, binding.internalModel);
  const raw = await readFile(path, 'utf8');
  return { path, data: format === 'json' ? JSON.parse(raw) : parseYaml(raw) };
}

export async function writeArtifact(artifact, format = 'yaml') {
  await writeFile(
    artifact.path,
    format === 'json' ? JSON.stringify(artifact.data, null, 2) + '\n' : stringifyYaml(artifact.data),
  );
}

export function markReady(model) {
  model.metadata.status = 'ready';
  model.gaps = [];
  for (const gate of model.gates || []) gate.checked = true;
}

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

export async function completeProductFixture(root) {
  const initialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);
  markReady(capabilities.data);
  capabilities.data.intent = {
    productName: '示例产品',
    productConcept: '规格验证工具',
    problem: '产品规格中的结构与引用错误只能在交付后被发现',
    businessGoal: '减少不一致规格',
    successSignal: '严格门禁稳定通过',
  };
  capabilities.data.actors = [{
    id: 'ACTOR-001',
    name: '规格作者',
    goal: '交付一致的产品规格',
  }];
  capabilities.data.productScope = {
    included: ['创建结构化产品规格'],
    excluded: ['生成生产架构实现'],
  };
  capabilities.data.businessRules = [{
    id: 'BR-001',
    statement: '只有结构与引用全部有效的 Package 才能通过验证',
  }];
  capabilities.data.useCases = [{
    id: 'UC-001',
    name: '验证产品规格 Package',
    actor: 'ACTOR-001',
    goal: '在交付前确认产品规格可以被下游安全消费',
    value: '在交付前发现结构和引用问题',
    trigger: '规格作者请求验证当前 Package',
    preconditions: ['Package 已包含待验证的规格内容'],
    successOutcome: '显示可交付状态及对应证据',
    minimumGuarantee: '保留原始规格并显示可定位错误',
    uiApplicability: { mode: 'required', reason: null },
    mainScenario: [{
      id: 'UC-001-STEP-01',
      initiator: 'actor',
      action: '规格作者提交 Package 验证请求',
      outcome: '系统完成结构、引用和门禁检查并展示结果',
    }],
    alternateScenarios: [{
      id: 'UC-001-EXC-01',
      type: 'exception',
      name: '规格引用无效',
      startsAt: 'UC-001-STEP-01',
      condition: 'Package 中存在无法解析的引用',
      steps: [{
        id: 'UC-001-EXC-01-STEP-01',
        initiator: 'system',
        action: '系统停止交付判定',
        outcome: '规格作者看到失败状态和可定位错误，原始规格保持不变',
      }],
      outcome: 'Package 保持不可交付，等待规格作者修复引用',
    }],
    businessRules: ['BR-001'],
    relationships: [],
  }];
  capabilities.data.interactionStates = [
    { id: 'INT-STATE-001', name: '等待验证', type: 'entry', description: '规格作者可以提交验证请求', terminal: false },
    { id: 'INT-STATE-002', name: '验证通过', type: 'success', description: '系统显示可交付状态和证据', terminal: true },
    { id: 'INT-STATE-003', name: '验证失败', type: 'failure', description: '系统显示失败状态和可定位错误', terminal: true },
  ];
  capabilities.data.interactionFlows = [{
    id: 'IF-001',
    useCase: 'UC-001',
    name: '验证规格',
    entryState: 'INT-STATE-001',
    completionStates: ['INT-STATE-002', 'INT-STATE-003'],
    transitions: [{
      id: 'IF-001-TRANS-01', scenarioRef: 'main', useCaseStepRefs: ['UC-001-STEP-01'],
      from: 'INT-STATE-001', to: 'INT-STATE-002', guard: '结构与引用全部有效', branchLabel: '成功', failureResponse: null,
    }, {
      id: 'IF-001-TRANS-02', scenarioRef: 'UC-001-EXC-01', useCaseStepRefs: ['UC-001-EXC-01-STEP-01'],
      from: 'INT-STATE-001', to: 'INT-STATE-003', guard: '存在无法解析的引用', branchLabel: '失败',
      failureResponse: { retry: '修复引用后重新提交', recovery: '保留原始规格并定位错误', returnToState: 'INT-STATE-001' },
    }],
  }];
  capabilities.data.lowFiUiBlueprints = [{
    id: 'BLUEPRINT-001',
    actor: 'ACTOR-001',
    informationArchitecture: { entryScreen: 'LF-SCREEN-001', nodes: [{ screen: 'LF-SCREEN-001', parent: null }] },
    screens: [{
    id: 'LF-SCREEN-001',
    name: '规格检查页',
    purpose: '发起 Package 验证并展示可审阅结果',
    useCases: ['UC-001'],
    layoutTree: {
      type: 'vertical',
      children: [
        { type: 'region', region: 'LF-REGION-001' },
        {
          type: 'horizontal',
          children: [
            { type: 'region', region: 'LF-REGION-002' },
            { type: 'region', region: 'LF-REGION-003' },
          ],
        },
      ],
    },
    regions: [{
      id: 'LF-REGION-001',
      name: '页面标题',
      purpose: '标识当前页面和验证状态',
      content: ['规格检查', '当前验证状态'],
      controls: [],
    }, {
      id: 'LF-REGION-002',
      name: '验证工作区',
      purpose: '发起 Package 验证',
      content: ['Package 摘要', '验证动作'],
      controls: [{
        id: 'LF-CONTROL-001',
        type: 'action',
        label: '运行验证',
        purpose: '提交当前 Package 验证请求',
        action: 'validate-package',
        transitionRefs: ['IF-001-TRANS-01', 'IF-001-TRANS-02'],
      }],
    }, {
      id: 'LF-REGION-003',
      name: '验证结果',
      purpose: '展示验证状态、错误和证据',
      content: ['验证状态', '错误位置', '验证证据'],
      controls: [{
        id: 'LF-CONTROL-002',
        type: 'display',
        label: '验证结果',
        purpose: '展示验证状态、blocker 和证据',
        action: null,
        transitionRefs: [],
      }],
    }],
    }],
    statePresentations: [
      { interactionState: 'INT-STATE-001', screen: 'LF-SCREEN-001', suggestion: '显示验证入口与未运行提示' },
      { interactionState: 'INT-STATE-002', screen: 'LF-SCREEN-001', suggestion: '显示通过状态与证据' },
      { interactionState: 'INT-STATE-003', screen: 'LF-SCREEN-001', suggestion: '显示错误位置、恢复与重试入口' },
    ],
  }];

  const visualSpec = await readArtifact(root, stage, stage.artifacts['visual-spec']);
  markReady(visualSpec.data);
  const visualAsset = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#c8f36a"/></svg>\n';
  const visualAssetDirectory = resolve(root, stage.root, 'assets');
  await mkdir(visualAssetDirectory, { recursive: true });
  await writeFile(resolve(visualAssetDirectory, 'status.svg'), visualAsset);
  visualSpec.data.runtime = {
    platform: 'web', renderer: 'browser', colorScheme: 'light', locale: 'zh-CN', rootFontSizePx: 16,
  };
  visualSpec.data.viewports = [{ id: 'VIEWPORT-DESKTOP', name: '桌面网页', widthPx: 1440, heightPx: 900, deviceScaleFactor: 1 }];
  visualSpec.data.sources = [{
    id: 'VISUAL-SOURCE-001', kind: 'user-input', locator: 'fixture://visual-direction', version: '1.0.0', contentHash: sha256('fixture visual direction'),
  }];
  visualSpec.data.foundations = {
    spacing: [{ id: 'SPACE-0', valuePx: 0 }, { id: 'SPACE-16', valuePx: 16 }, { id: 'SPACE-24', valuePx: 24 }],
    typography: [{ id: 'TYPE-BODY', fontFamilies: ['Inter', 'sans-serif'], fontSizePx: 16, fontWeight: 400, lineHeightPx: 24, letterSpacingPx: 0, textTransform: 'none' }],
    paints: [
      { id: 'PAINT-BACKGROUND', kind: 'color', value: '#ffffff', opacity: 1 },
      { id: 'PAINT-TEXT', kind: 'color', value: '#111827', opacity: 1 },
      { id: 'PAINT-ACCENT', kind: 'color', value: '#c8f36a', opacity: 1 },
      { id: 'PAINT-BORDER', kind: 'color', value: '#d1d5db', opacity: 1 },
    ],
    effects: [],
  };
  visualSpec.data.layouts = [{
    id: 'LAYOUT-001', name: '规格检查页面', direction: 'column',
    width: { mode: 'fill', valuePx: null }, height: { mode: 'fill', valuePx: null },
    minWidthPx: 0, maxWidthPx: 1440, minHeightPx: 0, maxHeightPx: null,
    gapRef: 'SPACE-16', padding: { top: 'SPACE-24', right: 'SPACE-24', bottom: 'SPACE-24', left: 'SPACE-24' },
    alignItems: 'stretch', justifyContent: 'start', overflow: 'auto',
    children: [{ componentRef: 'VISUAL-COMPONENT-001', order: 0, grow: 0, shrink: 1, basisPx: null, alignSelf: 'stretch' }],
  }];
  visualSpec.data.pages = [{ id: 'PAGE-001', name: '规格检查', route: '/', useCaseRefs: ['UC-001'] }];
  visualSpec.data.renderings = ['INT-STATE-001', 'INT-STATE-002', 'INT-STATE-003'].map((stateId, index) => ({
    id: 'RENDERING-00' + (index + 1), pageRef: 'PAGE-001', viewportRef: 'VIEWPORT-DESKTOP', interactionStateRefs: [stateId],
    layoutRef: 'LAYOUT-001', componentRefs: ['VISUAL-COMPONENT-001'], backgroundPaintRef: 'PAINT-BACKGROUND',
  }));
  const visualStyle = {
    width: { mode: 'fill', valuePx: null }, height: { mode: 'hug', valuePx: null }, layoutRef: null,
    typographyRef: 'TYPE-BODY', fillPaintRef: 'PAINT-ACCENT', textPaintRef: 'PAINT-TEXT',
    border: { widthPx: 1, style: 'solid', paintRef: 'PAINT-BORDER', radiusPx: 8 }, effectRefs: [], opacity: 1,
  };
  visualSpec.data.components = [{
    id: 'VISUAL-COMPONENT-001', name: '验证状态卡片', role: '展示验证状态和操作结果', useCaseRefs: ['UC-001'],
    interactionStateRefs: ['INT-STATE-001', 'INT-STATE-002', 'INT-STATE-003'],
    variantAxes: [{ name: 'Mode', values: ['Default', 'Busy'] }],
    visualCases: ['INT-STATE-001', 'INT-STATE-002', 'INT-STATE-003'].flatMap((stateId, stateIndex) => (
      ['Default', 'Busy'].map((mode, variantIndex) => ({
        id: 'VISUAL-CASE-00' + (stateIndex * 2 + variantIndex + 1), name: stateId + ' ' + mode,
        interactionStateRef: stateId, variants: [{ name: 'Mode', value: mode }], visual: structuredClone(visualStyle),
      }))
    )),
  }];
  visualSpec.data.assets = [{
    id: 'VISUAL-ASSET-001', file: 'assets/status.svg', sourceRef: 'VISUAL-SOURCE-001', role: '状态图标', contentHash: sha256(visualAsset),
    usage: [{ renderingRef: 'RENDERING-001', componentRef: 'VISUAL-COMPONENT-001', visualCaseRef: 'VISUAL-CASE-001' }],
  }];

  const prototypeRoot = stage.areas['canonical-ui-prototypes'].root;
  const areaPath = resolve(root, stage.root, prototypeRoot, 'ACTOR-001');
  await cp(resolve(root, '.agents/skills/product-design/canonical-ui-prototype/template'), areaPath, { recursive: true });
  const sourceId = 'DESIGN-SOURCE-001';
  const sourceRoot = resolve(areaPath, 'design-sources', sourceId);
  const assetRoot = resolve(areaPath, 'public/assets', sourceId);
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(assetRoot, { recursive: true }),
  ]);
  const location = 'https://www.figma.com/design/example/psp-harness?node-id=1-2';
  const capturedAt = '2026-07-15T10:00:01Z';
  const sourceVersion = { kind: 'figma-file-version', value: 'fixture-version-20260715' };
  const designContextDocument = {
    version: '4.0.0',
    sourceId,
    nodeId: '1:2',
    capturedAt,
    sourceVersion,
    parameterCoverage: ['geometry', 'typography', 'paint', 'effects', 'components', 'assets'],
    frame: { x: 0, y: 0, width: 1440, height: 900 },
    layout: {
      mode: 'vertical',
      padding: { top: 24, right: 24, bottom: 24, left: 24 },
      itemSpacing: 16,
      alignment: 'stretch',
      constraints: ['left-right', 'top'],
    },
    typography: [{
      nodeId: '1:4',
      fontFamily: 'Inter',
      fontSize: 16,
      fontWeight: 600,
      lineHeight: 24,
      letterSpacing: 0,
      wrapping: 'word',
    }],
    paints: [],
    effects: [],
    visualNodeCatalog: [
      {
        nodeId: '1:3',
        parentNodeId: '1:2',
        visible: true,
        hasPaint: true,
        hasStroke: false,
        hasEffect: false,
        hasMask: false,
        hasRaster: false,
        isText: false,
        assetBoundaryNodeId: '1:3',
      },
      {
        nodeId: '1:5',
        parentNodeId: '1:3',
        visible: true,
        hasPaint: false,
        hasStroke: false,
        hasEffect: false,
        hasMask: false,
        hasRaster: true,
        isText: false,
        assetBoundaryNodeId: '1:3',
      },
    ],
    components: [
      {
        nodeId: '2:1',
        name: 'Prototype App Shell',
        kind: 'component-set',
        componentKey: 'fixture-prototype-app-shell',
        componentSetNodeId: '2:1',
        mainComponentNodeId: null,
        structureSignature: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        variantProperties: {},
      },
      {
        nodeId: '2:2',
        name: 'Mode=Default',
        kind: 'component',
        componentKey: 'fixture-prototype-app-shell-default',
        componentSetNodeId: '2:1',
        mainComponentNodeId: '2:2',
        structureSignature: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        variantProperties: { Mode: 'Default' },
      },
      {
        nodeId: '2:3',
        name: 'Mode=Busy',
        kind: 'component',
        componentKey: 'fixture-prototype-app-shell-busy',
        componentSetNodeId: '2:1',
        mainComponentNodeId: '2:3',
        structureSignature: 'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        variantProperties: { Mode: 'Busy' },
      },
      {
        nodeId: '1:2',
        name: 'Prototype App Shell Instance',
        kind: 'instance',
        componentKey: 'fixture-prototype-app-shell-default',
        componentSetNodeId: '2:1',
        mainComponentNodeId: '2:2',
        screenRootNodeId: '1:2',
        structureSignature: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        variantProperties: { Mode: 'Default' },
      },
    ],
    componentSetCatalog: [{
      componentSetNodeId: '2:1',
      axes: [{ name: 'Mode', values: ['Default', 'Busy'] }],
      definitionNodeIds: ['2:2', '2:3'],
    }],
    assets: [{
      nodeId: '1:3',
      assetBoundaryNodeId: '1:3',
      assetKind: 'icon',
      captureScope: 'artwork-subtree',
      containsDynamicContent: false,
      recommendedFormat: 'svg',
    }],
  };
  const variableDefinitions = JSON.stringify({ variables: [{ name: 'color/accent', value: '#c8f36a' }] }, null, 2) + '\n';
  const screenshot = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fffdf7"/><circle cx="5" cy="5" r="3" fill="#c8f36a"/></svg>\n';
  const asset = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#c8f36a"/><path d="M10 21l6 6 14-15" fill="none" stroke="#15210f" stroke-width="4"/></svg>\n';
  const assetFacts = {
    sourceNodeId: '1:3',
    assetBoundaryNodeId: '1:3',
    strategy: 'asset',
    assetKind: 'icon',
    captureScope: 'artwork-subtree',
    containsDynamicContent: false,
    format: 'svg',
    scale: 1,
    cropBounds: { x: 0, y: 0, width: 40, height: 40 },
    transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
    expectedDimensions: { width: 40, height: 40 },
    sha256: sha256(asset),
    downloadOperation: 'figma:export-node',
    consumerTargets: ['COMPONENT-001'],
    status: 'verified',
  };
  const scanInventory = {
    scannedAt: '2026-07-15T09:54:00Z',
    sourceVersion,
    rootNodeId: '1:2',
    nodes: [
      { kind: 'page', nodeId: '1:1', name: 'Fixture Page', visible: true },
      { kind: 'instance', nodeId: '1:2', name: 'Prototype App Shell Instance', visible: true, parentNodeId: '1:1' },
      { kind: 'component-set', nodeId: '2:1', name: 'Prototype App Shell', visible: true, parentNodeId: '1:1' },
      { kind: 'component', nodeId: '2:2', name: 'Mode=Default', visible: true, parentNodeId: '2:1' },
      { kind: 'component', nodeId: '2:3', name: 'Mode=Busy', visible: true, parentNodeId: '2:1' },
      { kind: 'group', nodeId: '1:3', name: 'Fixture source icon', visible: true, parentNodeId: '1:2' },
      { kind: 'image', nodeId: '1:5', name: 'Fixture source bitmap', visible: true, parentNodeId: '1:3' },
      { kind: 'visual', nodeId: '1:4', name: 'Unrelated artwork', visible: true, parentNodeId: '1:1' },
    ],
  };
  const pageCoverage = [{ expectedPageId: 'PAGE-FIXTURE', figmaPageNodeId: '1:1', status: 'PASS' }];
  const groupIntegrity = [{
    groupNodeId: '1:3',
    memberNodeIds: ['1:5'],
    containsVisualContent: true,
    assetBoundaryNodeId: '1:3',
    status: 'PASS',
  }];
  const imageGroupCoverage = [{
    imageNodeId: '1:5',
    ownerGroupNodeId: '1:3',
    expectedGroupNodeId: '1:3',
    status: 'PASS',
  }];
  const stateCoverage = [{
    screenId: 'SCREEN-001',
    stateId: 'INT-STATE-001',
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
  const figmaComponentContract = {
    name: 'FixtureStatus',
    properties: [
      { name: 'Mode', kind: 'variant', values: ['Default', 'Busy'] },
      { name: 'Message', kind: 'text', values: [] },
    ],
    variantAxes: [{ name: 'Mode', values: ['Default', 'Busy'] }],
    contentRegions: [{ name: 'Label', role: 'status-title' }],
    nestedComponentNodeIds: [],
    sizeBehavior: { width: 'fill', height: 'hug', wrap: 'content' },
  };
  const componentProposal = {
    id: 'COMPONENT-PROPOSAL-001',
    nodeIds: ['2:1', '2:2', '2:3', '1:2'],
    decision: 'shared-component',
    structureSignatures: [
      'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      'sha256:3333333333333333333333333333333333333333333333333333333333333333',
    ],
    componentBoundary: {
      kind: 'component-set',
      rootNodeId: '2:1',
      nestedComponentNodeIds: ['2:2', '2:3', '1:2'],
    },
    figmaComponentContract,
  };
  const screenBindings = [
    ...['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'].map((viewportId) => ({
      screenId: 'SCREEN-001',
      figmaRootNodeId: '1:2',
      viewportId,
      scenarioId: 'SCENARIO-001',
      stateIds: ['INT-STATE-001', 'COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS'],
    })),
    ...['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'].map((viewportId) => ({
      screenId: 'SCREEN-001',
      figmaRootNodeId: '1:2',
      viewportId,
      scenarioId: 'SCENARIO-002',
      stateIds: ['INT-STATE-001', 'COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'],
    })),
    ...['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'].map((viewportId) => ({
      screenId: 'SCREEN-001',
      figmaRootNodeId: '1:2',
      viewportId,
      scenarioId: 'SCENARIO-003',
      stateIds: ['INT-STATE-001', 'COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'],
    })),
  ];
  const scopeAudit = {
    id: 'SCOPE-AUDIT-001',
    sha256: 'sha256:' + '0'.repeat(64),
    scopeMode: 'file',
    sourceVersion,
    rootNodeId: '1:2',
    scanInventory,
    screenBindings,
    includedNodes: scanInventory.nodes
      .filter((node) => node.nodeId !== '1:4')
      .map(({ kind, nodeId, name }) => ({ kind, nodeId, name })),
    excludedNodes: [{ kind: 'visual', nodeId: '1:4', name: 'Unrelated artwork', reason: 'Not used by the approved scope.' }],
    pageCoverage,
    groupIntegrity,
    imageGroupCoverage,
    stateCoverage,
    variantCoverage,
    findings: [],
    writebackPlan: [],
    componentProposals: [componentProposal],
  };
  scopeAudit.sha256 = confirmationSha256(scopeAudit);
  const writebackApproval = {
    id: 'WRITEBACK-APPROVAL-001',
    sha256: 'sha256:' + '0'.repeat(64),
    confirmedBy: 'user:fixture-reviewer',
    confirmedAt: '2026-07-15T09:55:00Z',
    sourceVersion,
    scopeAuditId: scopeAudit.id,
    scopeAuditSha256: scopeAudit.sha256,
    operationIds: [],
    detachApprovals: [],
  };
  writebackApproval.sha256 = confirmationSha256(writebackApproval);
  const writebackReceipt = {
    id: 'WRITEBACK-RECEIPT-001',
    sha256: 'sha256:' + '0'.repeat(64),
    writebackApprovalId: writebackApproval.id,
    writebackApprovalSha256: writebackApproval.sha256,
    sourceVersionBefore: sourceVersion,
    sourceVersionAfter: sourceVersion,
    operationIds: [],
    beforeInventorySha256: 'sha256:' + '4'.repeat(64),
    afterInventorySha256: 'sha256:' + '4'.repeat(64),
    screenshotEvidenceItemIds: ['EVIDENCE-BEFORE-001', 'EVIDENCE-AFTER-001'],
    postWriteAudit: {
      scanInventory: { ...scanInventory, scannedAt: '2026-07-15T09:56:00Z' },
      pageCoverage,
      groupIntegrity,
      imageGroupCoverage,
      stateCoverage,
      variantCoverage,
      findings: [],
    },
    completedAt: '2026-07-15T09:57:00Z',
  };
  writebackReceipt.sha256 = confirmationSha256(writebackReceipt);
  const finalFigmaAcceptance = {
    id: 'FINAL-FIGMA-ACCEPTANCE-001',
    sha256: 'sha256:' + '0'.repeat(64),
    confirmedBy: 'user:fixture-reviewer',
    confirmedAt: '2026-07-15T09:58:00Z',
    sourceVersion,
    writebackReceiptId: writebackReceipt.id,
    writebackReceiptSha256: writebackReceipt.sha256,
    result: 'accepted',
  };
  finalFigmaAcceptance.sha256 = confirmationSha256(finalFigmaAcceptance);
  const capturePlan = {
    version: '3.0.0',
    sourceId,
    rootNodeId: '1:2',
    sourceVersion,
    scopeAudit,
    writebackApproval,
    writebackReceipt,
    finalFigmaAcceptance,
    frozenAt: '2026-07-15T09:59:00Z',
    formalCapture: {
      ordinal: 1,
      startedAt: '2026-07-15T10:00:00Z',
      completedAt: '2026-07-15T10:00:04Z',
      sourceVersionBefore: sourceVersion,
      sourceVersionAfter: sourceVersion,
    },
    candidateVisualNodes: [
      {
        nodeId: '1:3',
        name: 'Fixture source icon',
        strategy: 'asset',
        assetBoundaryNodeId: assetFacts.assetBoundaryNodeId,
        assetKind: assetFacts.assetKind,
        captureScope: assetFacts.captureScope,
        containsDynamicContent: assetFacts.containsDynamicContent,
        consumerTargets: assetFacts.consumerTargets,
        assetExport: {
          format: assetFacts.format,
          scale: assetFacts.scale,
          cropBounds: assetFacts.cropBounds,
          transparentPadding: assetFacts.transparentPadding,
          expectedDimensions: assetFacts.expectedDimensions,
          targetPath: 'public/assets/DESIGN-SOURCE-001/source.svg',
          downloadOperation: assetFacts.downloadOperation,
        },
      },
      {
        nodeId: '1:5',
        name: 'Fixture source bitmap',
        strategy: 'ignored',
        assetBoundaryNodeId: '1:3',
        reason: 'covered-by-asset-boundary:1:3',
      },
    ],
  };
  const capturePlanText = JSON.stringify(capturePlan, null, 2) + '\n';
  const rawDesignContext = JSON.stringify({
    provider: 'figma',
    operation: 'get_design_context',
    requestedNodeId: '1:2',
    sourceVersion,
    capturedAt,
    payload: { fixture: true, rootNodeId: '1:2' },
  }, null, 2) + '\n';
  const designContext = JSON.stringify({
    ...designContextDocument,
    rawCapture: {
      provider: 'figma',
      operation: 'get_design_context',
      requestedNodeId: '1:2',
      capturedAt,
      sourceVersion,
      capturePlanSha256: sha256(capturePlanText),
      path: 'design-sources/DESIGN-SOURCE-001/raw-design-context.json',
      sha256: sha256(rawDesignContext),
    },
  }, null, 2) + '\n';
  const ingestReceipt = {
    version: '2.0.0',
    sourceId,
    sourceVersion,
    capturePlan: {
      path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json',
      sha256: sha256(capturePlanText),
    },
    downloadOperation: assetFacts.downloadOperation,
    ingestedAt: '2026-07-15T10:00:03Z',
    assets: [{
      sourceNodeId: assetFacts.sourceNodeId,
      assetBoundaryNodeId: assetFacts.assetBoundaryNodeId,
      path: 'public/assets/DESIGN-SOURCE-001/source.svg',
      assetKind: assetFacts.assetKind,
      captureScope: assetFacts.captureScope,
      containsDynamicContent: assetFacts.containsDynamicContent,
      format: assetFacts.format,
      scale: assetFacts.scale,
      cropBounds: assetFacts.cropBounds,
      transparentPadding: assetFacts.transparentPadding,
      expectedDimensions: assetFacts.expectedDimensions,
      sha256: assetFacts.sha256,
      consumerTargets: assetFacts.consumerTargets,
      status: assetFacts.status,
    }],
    status: 'PASS',
  };
  const ingestReceiptText = JSON.stringify(ingestReceipt, null, 2) + '\n';
  const rawContextPath = resolve(sourceRoot, 'raw-design-context.json');
  const contextPath = resolve(sourceRoot, 'design-context.json');
  const variablesPath = resolve(sourceRoot, 'variable-definitions.json');
  const screenshotPath = resolve(sourceRoot, 'node-screenshot.svg');
  const assetPath = resolve(assetRoot, 'source.svg');
  await Promise.all([
    writeFile(rawContextPath, rawDesignContext),
    writeFile(contextPath, designContext),
    writeFile(variablesPath, variableDefinitions),
    writeFile(screenshotPath, screenshot),
    writeFile(assetPath, asset),
    writeFile(resolve(sourceRoot, 'capture-plan.json'), capturePlanText),
    writeFile(resolve(sourceRoot, 'ingest-receipt.json'), ingestReceiptText),
  ]);
  const evidence = {
    version: '6.0.0',
    sourceId,
    kind: 'figma',
    location,
    capturedAt,
    nodeId: '1:2',
    sourceVersion,
    items: [
      {
        id: 'EVIDENCE-RAW-CONTEXT-001',
        role: 'raw-design-context',
        path: 'design-sources/DESIGN-SOURCE-001/raw-design-context.json',
        sha256: sha256(rawDesignContext),
      },
      {
        id: 'EVIDENCE-CONTEXT-001',
        role: 'design-context',
        path: 'design-sources/DESIGN-SOURCE-001/design-context.json',
        sha256: sha256(designContext),
        schema: 'https://psp.dev/adapters/figma/design-context.schema.json',
      },
      {
        id: 'EVIDENCE-SCREENSHOT-001',
        role: 'screenshot',
        path: 'design-sources/DESIGN-SOURCE-001/node-screenshot.svg',
        sha256: sha256(screenshot),
        sourceNodeId: '1:2',
      },
      { id: 'EVIDENCE-VARIABLES-001', role: 'variable-definitions', path: 'design-sources/DESIGN-SOURCE-001/variable-definitions.json', sha256: sha256(variableDefinitions) },
      {
        id: 'EVIDENCE-CAPTURE-PLAN-001',
        role: 'capture-plan',
        path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json',
        sha256: sha256(capturePlanText),
        schema: 'https://psp.dev/skills/figma-workflow/capture-plan.schema.json',
      },
      {
        id: 'EVIDENCE-INGEST-RECEIPT-001',
        role: 'ingest-receipt',
        path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json',
        sha256: sha256(ingestReceiptText),
        schema: 'https://psp.dev/adapters/figma/ingest-receipt.schema.json',
      },
      {
        id: 'EVIDENCE-ASSET-001',
        role: 'asset',
        path: 'public/assets/DESIGN-SOURCE-001/source.svg',
        sha256: sha256(asset),
        sourceNodeId: '1:3',
        assetBoundaryNodeId: '1:3',
        assetKind: assetFacts.assetKind,
        captureScope: assetFacts.captureScope,
        containsDynamicContent: assetFacts.containsDynamicContent,
        strategy: assetFacts.strategy,
        format: assetFacts.format,
        scale: assetFacts.scale,
        cropBounds: assetFacts.cropBounds,
        transparentPadding: assetFacts.transparentPadding,
        expectedDimensions: assetFacts.expectedDimensions,
        downloadOperation: assetFacts.downloadOperation,
        consumerTargets: assetFacts.consumerTargets,
        status: assetFacts.status,
      },
    ],
  };
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(resolve(sourceRoot, 'evidence.json'), evidenceText);
  const approvedProposal = capturePlan.scopeAudit.componentProposals[0];
  const registration = {
    version: '3.0.0',
    sourceId,
    sourceVersion,
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: sha256(evidenceText),
    capturePlan: {
      path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json',
      sha256: sha256(capturePlanText),
    },
    designContext: {
      path: 'design-sources/DESIGN-SOURCE-001/design-context.json',
      sha256: sha256(designContext),
    },
    ingestReceipt: {
      path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json',
      sha256: sha256(ingestReceiptText),
    },
    componentHandshake: [{
      proposalId: approvedProposal.id,
      decision: approvedProposal.decision,
      finalNodeIds: approvedProposal.nodeIds,
      structureSignatures: approvedProposal.structureSignatures,
      figmaComponentContract: approvedProposal.figmaComponentContract,
      usageBindings: [{ instanceNodeId: '1:2', screenId: 'SCREEN-001' }],
      baselineEvidenceItemIds: ['EVIDENCE-SCREENSHOT-001'],
      figmaComponentNodeId: '2:1',
      variantDefinitionNodeIds: ['2:2', '2:3'],
      variantUsageInstanceNodeIds: ['1:2'],
    }],
    assets: [{
      path: 'public/assets/DESIGN-SOURCE-001/source.svg',
      sourceNodeId: assetFacts.sourceNodeId,
      assetBoundaryNodeId: assetFacts.assetBoundaryNodeId,
      assetKind: assetFacts.assetKind,
      captureScope: assetFacts.captureScope,
      containsDynamicContent: assetFacts.containsDynamicContent,
      strategy: assetFacts.strategy,
      format: assetFacts.format,
      scale: assetFacts.scale,
      cropBounds: assetFacts.cropBounds,
      transparentPadding: assetFacts.transparentPadding,
      expectedDimensions: assetFacts.expectedDimensions,
      sha256: assetFacts.sha256,
      downloadOperation: assetFacts.downloadOperation,
      consumerTargets: assetFacts.consumerTargets,
      status: assetFacts.status,
    }],
    gaps: [],
  };
  const registrationText = JSON.stringify(registration, null, 2) + '\n';
  await writeFile(resolve(sourceRoot, 'source-registration.json'), registrationText);
  const allStateIds = ['INT-STATE-001', 'INT-STATE-002', 'INT-STATE-003', 'COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'];
  const allViewportIds = ['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'];
  const stateMatrix = [];
  for (const [runtimeName, runtimeValueId] of [
    ['DEFAULT', 'AXIS-VALUE-RUNTIME-DEFAULT'],
    ['LOADING', 'AXIS-VALUE-RUNTIME-LOADING'],
    ['SUCCESS', 'AXIS-VALUE-RUNTIME-SUCCESS'],
    ['ERROR', 'AXIS-VALUE-RUNTIME-ERROR'],
  ]) {
    for (const [variantName, variantValueId] of [
      ['DEFAULT', 'AXIS-VALUE-MODE-DEFAULT'],
      ['BUSY', 'AXIS-VALUE-MODE-BUSY'],
    ]) {
      for (const [interactionName, interactionValueId] of [
        ['READY', 'AXIS-VALUE-INTERACTION-READY'],
        ['SUCCESS', 'AXIS-VALUE-INTERACTION-SUCCESS'],
        ['FAILURE', 'AXIS-VALUE-INTERACTION-FAILURE'],
      ]) {
        stateMatrix.push({
          id: 'STATE-MATRIX-' + runtimeName
            + (variantName === 'DEFAULT' ? '' : '-' + variantName)
            + (interactionName === 'READY' ? '' : '-INTERACTION-' + interactionName),
          componentContractId: 'COMPONENT-CONTRACT-001',
          values: {
            'STATE-AXIS-VARIANT': variantValueId,
            'STATE-AXIS-RUNTIME': runtimeValueId,
            'STATE-AXIS-INTERACTION': interactionValueId,
            'STATE-AXIS-CONTENT': 'AXIS-VALUE-CONTENT-DEFAULT',
            'STATE-AXIS-FLAG': 'AXIS-VALUE-FLAG-TRUE',
            'STATE-AXIS-LABEL': 'AXIS-VALUE-LABEL-DEFAULT',
          },
          classification: 'legal',
          renderInGallery: true,
        });
      }
    }
  }
  const canonical = {
    version: '12.0.0',
    actor: 'ACTOR-001',
    draft: {
      version: '1.0.0',
      inputs: {
        useCases: { version: capabilities.data.metadata.version, contentHash: sha256(stringifyYaml(capabilities.data)) },
        visualSpec: { version: visualSpec.data.metadata.version, contentHash: sha256(stringifyYaml(visualSpec.data)) },
      },
    },
    visualPolicy: {
      mode: 'guided',
      selectedBy: 'user-explicit',
      aspects: ['color'],
      coverage: [{
        sourceId,
        screenId: 'SCREEN-001',
        stateIds: allStateIds,
        viewportIds: allViewportIds,
        evidenceItemIds: ['EVIDENCE-SCREENSHOT-001', 'EVIDENCE-VARIABLES-001'],
      }],
    },
    reviewTools: {
      activation: {
        queryParameter: 'review',
        enabledValue: '1',
      },
      boundary: {
        classification: 'review-only',
        excludedProductScopes: ['requirements', 'features', 'pages', 'controls', 'downstream-implementation'],
        protectedProductFacts: ['use-cases', 'interaction-flows', 'visual-spec'],
      },
      tools: [
        { id: 'REVIEW-TOOL-INCONSISTENCY-ANNOTATOR', kind: 'inconsistency-annotator', delivery: 'built-in' },
        { id: 'REVIEW-TOOL-UI-CASE-SWITCHER', kind: 'ui-case-switcher', delivery: 'review-extension' },
        { id: 'REVIEW-TOOL-INTERACTION-BRANCH-DRIVER', kind: 'interaction-branch-driver', delivery: 'built-in' },
      ],
    },
    repairPolicy: {
      allowedImplementationPaths: [
        'index.html',
        'src/main.ts',
        'src/psp-app.ts',
        'src/product-router.ts',
        'src/state-gallery.ts',
        'src/matrix-mount.ts',
        'src/components/**/*.ts',
        'src/components/**/*.css',
        'src/pages/**/*.ts',
        'src/pages/**/*.css',
        'src/styles/**/*.css',
        'src/*.css',
      ],
    },
    designSources: [{
      id: sourceId,
      kind: 'figma',
      location,
      status: 'available',
      capturedAt,
      evidence: { path: 'design-sources/DESIGN-SOURCE-001/evidence.json', sha256: sha256(evidenceText) },
      registration: {
        path: 'design-sources/DESIGN-SOURCE-001/source-registration.json',
        sha256: sha256(registrationText),
      },
      coverage: [{
        screenId: 'SCREEN-001',
        stateIds: allStateIds,
        viewportIds: allViewportIds,
        evidenceItemIds: ['EVIDENCE-CONTEXT-001', 'EVIDENCE-SCREENSHOT-001'],
      }],
    }],
    assets: [{
      id: 'ASSET-001',
      path: 'public/assets/DESIGN-SOURCE-001/source.svg',
      kind: 'image',
      sourceIds: [sourceId],
      sourceNodeId: assetFacts.sourceNodeId,
      assetBoundaryNodeId: assetFacts.assetBoundaryNodeId,
      sourceVersion,
      strategy: assetFacts.strategy,
      format: assetFacts.format,
      scale: assetFacts.scale,
      cropBounds: assetFacts.cropBounds,
      transparentPadding: assetFacts.transparentPadding,
      expectedDimensions: assetFacts.expectedDimensions,
      sha256: assetFacts.sha256,
      downloadOperation: assetFacts.downloadOperation,
      consumerTargets: assetFacts.consumerTargets,
      status: assetFacts.status,
      alt: 'Fixture source',
    }],
    tokens: [{ id: 'TOKEN-COLOR-ACCENT', type: 'color', value: '#c8f36a', sourceIds: [sourceId], targetIds: ['CONTROL-001'], cssProperty: '--accent' }],
    routes: [{ id: 'ROUTE-001', path: '/', screenId: 'SCREEN-001' }],
    screens: [{ id: 'SCREEN-001', title: '规格验证', routeId: 'ROUTE-001', stateIds: ['INT-STATE-001', 'INT-STATE-002', 'INT-STATE-003'], componentIds: ['COMPONENT-001'] }],
    components: [{ id: 'COMPONENT-001', name: '验证状态', controlIds: ['CONTROL-001', 'CONTROL-002', 'CONTROL-003'], stateIds: ['COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'] }],
    componentInventory: [{
      id: 'COMPONENT-INVENTORY-001',
      sourceId,
      nodeIds: ['2:1', '2:2', '2:3', '1:2'],
      semanticRole: '展示规格验证状态并承载验证动作',
      structureSignatures: [
        'sha256:1111111111111111111111111111111111111111111111111111111111111111',
        'sha256:2222222222222222222222222222222222222222222222222222222222222222',
        'sha256:3333333333333333333333333333333333333333333333333333333333333333',
      ],
      decision: 'shared-component',
      rationale: 'Product Design 基于业务语义确认该组件为共享组件。',
      componentId: 'COMPONENT-001',
    }],
    componentMappings: [{
      id: 'COMPONENT-MAPPING-001',
      componentId: 'COMPONENT-001',
      sourceId,
      inventoryId: 'COMPONENT-INVENTORY-001',
      figmaComponentNodeId: '2:1',
      litTagName: 'psp-app',
      propertyMappings: [
        {
          kind: 'variant',
          figmaProperty: 'Mode',
          litProperty: 'mode',
          litAttribute: 'mode',
          values: [
            { figmaValue: 'Default', litValue: 'default' },
            { figmaValue: 'Busy', litValue: 'busy' },
          ],
        },
        {
          kind: 'text',
          figmaProperty: 'Message',
          litProperty: 'message',
          litAttribute: null,
          values: [],
        },
      ],
      slotMappings: [{ figmaProperty: 'Label', litSlot: 'label' }],
      eventIds: ['EVENT-001', 'EVENT-002', 'EVENT-003'],
    }],
    componentVariantDefinitions: [
      {
        id: 'COMPONENT-DEFINITION-DEFAULT',
        mappingId: 'COMPONENT-MAPPING-001',
        figmaComponentNodeId: '2:2',
        figmaVariantProperties: { Mode: 'Default' },
        litVariantAttributes: { mode: 'default' },
      },
      {
        id: 'COMPONENT-DEFINITION-BUSY',
        mappingId: 'COMPONENT-MAPPING-001',
        figmaComponentNodeId: '2:3',
        figmaVariantProperties: { Mode: 'Busy' },
        litVariantAttributes: { mode: 'busy' },
      },
    ],
    componentVariantCoverage: [
      {
        id: 'COMPONENT-VARIANT-DEFAULT',
        mappingId: 'COMPONENT-MAPPING-001',
        definitionId: 'COMPONENT-DEFINITION-DEFAULT',
        litSlotNames: [],
        usages: [{ instanceNodeId: '1:2', screenId: 'SCREEN-001' }],
      },
      {
        id: 'COMPONENT-VARIANT-BUSY',
        mappingId: 'COMPONENT-MAPPING-001',
        definitionId: 'COMPONENT-DEFINITION-BUSY',
        litSlotNames: [],
        usages: [],
      },
    ],
    componentContracts: [{
      id: 'COMPONENT-CONTRACT-001',
      componentId: 'COMPONENT-001',
      visualComponentId: 'VISUAL-COMPONENT-001',
      implementationRole: 'app-shell',
      mappingId: 'COMPONENT-MAPPING-001',
      figmaInstanceNodeIds: ['1:2'],
      litTagName: 'psp-app',
      slots: ['label'],
      properties: [
        { name: 'mode', type: 'string', required: false, defaultValue: 'default' },
        { name: 'message', type: 'string', required: false, defaultValue: '' },
        { name: 'previewState', type: 'string', required: false, defaultValue: 'COMPONENT-STATE-DEFAULT' },
        { name: 'previewInteractionState', type: 'string', required: false, defaultValue: 'INT-STATE-001' },
        { name: 'caseFlag', type: 'boolean', required: false, defaultValue: false },
      ],
      attributes: [
        { name: 'mode', propertyName: 'mode' },
        { name: 'data-case-flag', propertyName: 'caseFlag' },
      ],
      eventIds: ['EVENT-001', 'EVENT-002', 'EVENT-003'],
      stateAxisCoverage: [
        { kind: 'variant', status: 'modeled' },
        { kind: 'runtime-state', status: 'modeled' },
        { kind: 'interaction-state', status: 'modeled' },
        { kind: 'content-override', status: 'modeled' },
      ],
      defaultStateMatrixEntryId: 'STATE-MATRIX-DEFAULT',
      pageInstances: [{
        id: 'REVIEW-PRIMARY-INSTANCE',
        screenId: 'SCREEN-001',
        origin: 'figma',
        figmaInstanceNodeId: '1:2',
      }],
      implementationPaths: ['src/psp-app.ts'],
      testAssertions: [
        { kind: 'accessible-name', targetId: 'CONTROL-001' },
        { kind: 'focusable', targetId: 'CONTROL-001' },
        { kind: 'disabled', targetId: 'CONTROL-001', stateMatrixEntryId: 'STATE-MATRIX-LOADING', expected: true },
        { kind: 'aria', targetId: 'COMPONENT-STATE-LOADING', stateMatrixEntryId: 'STATE-MATRIX-LOADING', attribute: 'aria-live', expected: 'polite' },
      ],
    }],
    stateAxes: [
      {
        id: 'STATE-AXIS-VARIANT',
        componentContractId: 'COMPONENT-CONTRACT-001',
        kind: 'variant',
        name: 'Mode',
        renderBinding: { kind: 'mapped-variant' },
        values: [
          { id: 'AXIS-VALUE-MODE-DEFAULT', value: 'Default' },
          { id: 'AXIS-VALUE-MODE-BUSY', value: 'Busy' },
        ],
      },
      {
        id: 'STATE-AXIS-RUNTIME',
        componentContractId: 'COMPONENT-CONTRACT-001',
        kind: 'runtime-state',
        name: 'status',
        renderBinding: { kind: 'component-state', name: 'previewState' },
        values: [
          { id: 'AXIS-VALUE-RUNTIME-DEFAULT', value: 'default', stateId: 'COMPONENT-STATE-DEFAULT', renderValue: 'COMPONENT-STATE-DEFAULT' },
          { id: 'AXIS-VALUE-RUNTIME-LOADING', value: 'loading', stateId: 'COMPONENT-STATE-LOADING', renderValue: 'COMPONENT-STATE-LOADING' },
          { id: 'AXIS-VALUE-RUNTIME-SUCCESS', value: 'success', stateId: 'COMPONENT-STATE-SUCCESS', renderValue: 'COMPONENT-STATE-SUCCESS' },
          { id: 'AXIS-VALUE-RUNTIME-ERROR', value: 'error', stateId: 'COMPONENT-STATE-ERROR', renderValue: 'COMPONENT-STATE-ERROR' },
        ],
      },
      {
        id: 'STATE-AXIS-INTERACTION',
        componentContractId: 'COMPONENT-CONTRACT-001',
        kind: 'interaction-state',
        name: 'workflow',
        renderBinding: { kind: 'workflow-state', name: 'previewInteractionState' },
        values: [
          { id: 'AXIS-VALUE-INTERACTION-READY', value: 'ready', stateId: 'INT-STATE-001' },
          { id: 'AXIS-VALUE-INTERACTION-SUCCESS', value: 'success', stateId: 'INT-STATE-002' },
          { id: 'AXIS-VALUE-INTERACTION-FAILURE', value: 'failure', stateId: 'INT-STATE-003' },
        ],
      },
      {
        id: 'STATE-AXIS-CONTENT',
        componentContractId: 'COMPONENT-CONTRACT-001',
        kind: 'content-override',
        name: 'message',
        renderBinding: { kind: 'lit-property', name: 'message' },
        values: [{ id: 'AXIS-VALUE-CONTENT-DEFAULT', value: 'default', renderValue: 'Fixture component content' }],
      },
      {
        id: 'STATE-AXIS-FLAG',
        componentContractId: 'COMPONENT-CONTRACT-001',
        kind: 'content-override',
        name: 'data-case-flag',
        renderBinding: { kind: 'lit-attribute', name: 'data-case-flag' },
        values: [{ id: 'AXIS-VALUE-FLAG-TRUE', value: 'flagged', renderValue: true }],
      },
      {
        id: 'STATE-AXIS-LABEL',
        componentContractId: 'COMPONENT-CONTRACT-001',
        kind: 'content-override',
        name: 'label',
        renderBinding: { kind: 'slot-text', name: 'label' },
        values: [{ id: 'AXIS-VALUE-LABEL-DEFAULT', value: 'default', renderValue: '验证状态' }],
      },
    ],
    stateMatrix,
    uiViewModels: [
      { id: 'UI-VM-001', name: '默认页面', routeId: 'ROUTE-001', base: 'component-contract-defaults', overrides: [] },
      {
        id: 'UI-VM-002',
        name: '加载中的 Busy 页面',
        routeId: 'ROUTE-001',
        base: 'component-contract-defaults',
        overrides: [{ pageInstanceId: 'REVIEW-PRIMARY-INSTANCE', stateMatrixEntryId: 'STATE-MATRIX-LOADING-BUSY' }],
      },
      {
        id: 'UI-VM-003',
        name: '成功页面',
        routeId: 'ROUTE-001',
        base: 'component-contract-defaults',
        overrides: [{ pageInstanceId: 'REVIEW-PRIMARY-INSTANCE', stateMatrixEntryId: 'STATE-MATRIX-SUCCESS-INTERACTION-SUCCESS' }],
      },
      {
        id: 'UI-VM-004',
        name: '错误页面',
        routeId: 'ROUTE-001',
        base: 'component-contract-defaults',
        overrides: [{ pageInstanceId: 'REVIEW-PRIMARY-INSTANCE', stateMatrixEntryId: 'STATE-MATRIX-ERROR-INTERACTION-FAILURE' }],
      },
    ],
    uiCases: [
      { id: 'UI-CASE-001', name: '桌面与移动默认页', viewModelId: 'UI-VM-001', viewportIds: allViewportIds },
      { id: 'UI-CASE-002', name: '桌面加载页', viewModelId: 'UI-VM-002', viewportIds: ['VIEWPORT-DESKTOP'] },
      { id: 'UI-CASE-003', name: '桌面成功页', viewModelId: 'UI-VM-003', viewportIds: ['VIEWPORT-DESKTOP'] },
      { id: 'UI-CASE-004', name: '桌面错误页', viewModelId: 'UI-VM-004', viewportIds: ['VIEWPORT-DESKTOP'] },
    ],
    controls: [{ id: 'CONTROL-001', componentId: 'COMPONENT-001', label: '模拟成功' }, { id: 'CONTROL-002', componentId: 'COMPONENT-001', label: '模拟错误' }, { id: 'CONTROL-003', componentId: 'COMPONENT-001', label: '返回重试' }],
    states: [
      { id: 'INT-STATE-001', scope: 'workflow', ownerId: 'SCREEN-001', label: '等待验证' },
      { id: 'INT-STATE-002', scope: 'workflow', ownerId: 'SCREEN-001', label: '验证通过' },
      { id: 'INT-STATE-003', scope: 'workflow', ownerId: 'SCREEN-001', label: '验证失败' },
      { id: 'COMPONENT-STATE-DEFAULT', scope: 'component', ownerId: 'COMPONENT-001', label: '默认' },
      { id: 'COMPONENT-STATE-LOADING', scope: 'component', ownerId: 'COMPONENT-001', label: '加载' },
      { id: 'COMPONENT-STATE-SUCCESS', scope: 'component', ownerId: 'COMPONENT-001', label: '成功' },
      { id: 'COMPONENT-STATE-ERROR', scope: 'component', ownerId: 'COMPONENT-001', label: '错误' },
    ],
    events: [{ id: 'EVENT-001', name: 'submit-success', controlId: 'CONTROL-001' }, { id: 'EVENT-002', name: 'submit-error', controlId: 'CONTROL-002' }, { id: 'EVENT-003', name: 'return-retry', controlId: 'CONTROL-003' }],
    actions: [{ id: 'ACTION-001', name: 'request-success', eventId: 'EVENT-001', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS'] }, { id: 'ACTION-002', name: 'request-error', eventId: 'EVENT-002', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'] }, { id: 'ACTION-003', name: 'return-to-entry', eventId: 'EVENT-003', resultingStateIds: ['COMPONENT-STATE-DEFAULT'] }],
    scenarios: [
      { id: 'SCENARIO-001', useCaseId: 'UC-001', interactionFlowIds: ['IF-001'], transitionIds: ['IF-001-TRANS-01'], recoveryStateIds: [], routeId: 'ROUTE-001', initialStateIds: ['INT-STATE-001', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-001'], expectedStateIds: ['COMPONENT-STATE-SUCCESS', 'INT-STATE-002'], viewportIds: allViewportIds },
      { id: 'SCENARIO-002', useCaseId: 'UC-001', interactionFlowIds: ['IF-001'], transitionIds: ['IF-001-TRANS-02'], recoveryStateIds: [], routeId: 'ROUTE-001', initialStateIds: ['INT-STATE-001', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-002'], expectedStateIds: ['COMPONENT-STATE-ERROR', 'INT-STATE-003'], viewportIds: allViewportIds },
      { id: 'SCENARIO-003', useCaseId: 'UC-001', interactionFlowIds: ['IF-001'], transitionIds: ['IF-001-TRANS-02'], recoveryStateIds: ['INT-STATE-001'], routeId: 'ROUTE-001', initialStateIds: ['INT-STATE-001', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-002', 'EVENT-003'], expectedStateIds: ['COMPONENT-STATE-DEFAULT', 'INT-STATE-001'], viewportIds: allViewportIds },
    ],
    viewports: [{ id: 'VIEWPORT-MOBILE', width: 390, height: 844 }, { id: 'VIEWPORT-DESKTOP', width: 1440, height: 1000 }],
    renderAssertions: [
      {
        id: 'VISUAL-ROUTE-001',
        routeId: 'ROUTE-001',
        viewportIds: allViewportIds,
        checks: [
          { kind: 'document-no-horizontal-overflow' },
          { kind: 'element-visible', targetIds: ['SCREEN-001', 'COMPONENT-001', 'CONTROL-001', 'CONTROL-002'] },
          { kind: 'elements-no-overlap', targetIds: ['CONTROL-001', 'CONTROL-002'] },
          { kind: 'text-no-clipping', targetIds: ['CONTROL-001', 'CONTROL-002'] },
          { kind: 'computed-style', targetId: 'CONTROL-001', property: 'min-height', expected: '44px' },
        ],
      },
      { id: 'VISUAL-SCENARIO-001', routeId: 'ROUTE-001', scenarioId: 'SCENARIO-001', viewportIds: allViewportIds, checks: [{ kind: 'element-visible', targetIds: ['COMPONENT-STATE-SUCCESS'] }] },
      { id: 'VISUAL-SCENARIO-002', routeId: 'ROUTE-001', scenarioId: 'SCENARIO-002', viewportIds: allViewportIds, checks: [{ kind: 'element-visible', targetIds: ['COMPONENT-STATE-ERROR'] }] },
      { id: 'VISUAL-SCENARIO-003', routeId: 'ROUTE-001', scenarioId: 'SCENARIO-003', viewportIds: allViewportIds, checks: [{ kind: 'element-visible', targetIds: ['COMPONENT-STATE-DEFAULT', 'INT-STATE-001'] }] },
    ],
    sourceParityAssertions: [
      { id: 'PARITY-COLOR-MOBILE', sourceId, routeId: 'ROUTE-001', viewportId: 'VIEWPORT-MOBILE', aspects: ['color'], checks: [{ kind: 'computed-style', targetId: 'CONTROL-001', property: 'background-color', expected: 'rgb(200, 243, 106)' }] },
      { id: 'PARITY-COLOR-DESKTOP', sourceId, routeId: 'ROUTE-001', viewportId: 'VIEWPORT-DESKTOP', aspects: ['color'], checks: [{ kind: 'computed-style', targetId: 'CONTROL-001', property: 'background-color', expected: 'rgb(200, 243, 106)' }] },
    ],
    componentSourceParityAssertions: [{
      id: 'COMPONENT-PARITY-001',
      sourceId,
      componentContractId: 'COMPONENT-CONTRACT-001',
      pageInstanceId: 'REVIEW-PRIMARY-INSTANCE',
      stateMatrixEntryId: 'STATE-MATRIX-DEFAULT',
      viewportId: 'VIEWPORT-DESKTOP',
      baselineEvidenceItemId: 'EVIDENCE-SCREENSHOT-001',
      aspects: ['color'],
      checks: [
        { kind: 'screenshot-match' },
        { kind: 'computed-style', targetId: 'COMPONENT-001', property: 'display', expected: 'block' },
        { kind: 'computed-style', targetId: 'REVIEW-PRIMARY-INSTANCE', property: 'display', expected: 'block' },
      ],
    }],
    motions: [{ id: 'MOTION-001', targetId: 'COMPONENT-001', trigger: 'loading', durationMs: 160, reducedMotion: true }],
    accessibility: { standard: 'Web Content Accessibility Guidelines 2.2 AA', checks: ['automated-rules', 'keyboard-operation', 'visible-focus', 'accessible-name', 'target-size'] },
    traceability: [{ useCaseId: 'UC-001', interactionFlowIds: ['IF-001'], screenIds: ['SCREEN-001'], controlIds: ['CONTROL-001', 'CONTROL-002', 'CONTROL-003'], stateIds: ['INT-STATE-001', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR', 'COMPONENT-STATE-DEFAULT'] }],
    gaps: [],
  };
  await writeFile(resolve(areaPath, 'src/spec/canonical-ui.ts'), 'export const canonicalUi = ' + JSON.stringify(canonical, null, 2) + ' as const;\n');
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app
    .replaceAll('UC-NNN', 'UC-001')
    .replaceAll('INT-STATE-NNN', 'INT-STATE-001')
    .replace(
      '<h2><slot name="label">交互状态实验台</slot></h2>',
      '<h2><slot name="label">交互状态实验台</slot></h2>\n            <img src="/assets/DESIGN-SOURCE-001/source.svg" alt="Fixture source" width="40" height="40" />',
    ));

  await writeArtifact(capabilities);
  await writeArtifact(visualSpec);
  const render = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
}
