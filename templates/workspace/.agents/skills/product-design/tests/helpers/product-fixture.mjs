import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { runScript } from './fixture.mjs';

export async function fixtureProject(root) {
  return parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
}

export async function readArtifact(root, stage, binding, format = 'yaml') {
  const path = resolve(root, stage.root, binding.internalModel);
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
  for (const gate of model.gates) gate.checked = true;
}

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

export async function completeProductFixture(root) {
  const initialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const product = await readArtifact(root, stage, stage.artifacts['product-package']);
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);
  const interactions = await readArtifact(root, stage, stage.artifacts.interactions);

  markReady(product.data);
  product.data.overview = {
    productName: '示例产品',
    productGoal: '验证 Harness 严格门禁',
    targetUsers: '规格作者',
    coreValue: '提供确定性规格交付',
  };

  markReady(capabilities.data);
  capabilities.data.intent = {
    productConcept: '规格验证工具',
    problem: '产品规格中的结构与引用错误只能在交付后被发现',
    businessGoal: '减少不一致规格',
    successSignal: '严格门禁稳定通过',
  };
  capabilities.data.actors = [{
    id: 'ACTOR-001',
    name: '规格作者',
    goal: '交付一致的产品规格',
    description: '创建和维护产品设计 Package',
  }];
  capabilities.data.productScope = {
    included: ['创建结构化产品规格'],
    excluded: ['生成生产架构实现'],
  };
  capabilities.data.businessRules = [{
    id: 'BR-001',
    statement: '只有结构与引用全部有效的 Package 才能通过验证',
    rationale: '保证下游消费输入确定且可追溯',
    appliesTo: ['UC-001'],
  }];
  capabilities.data.useCases = [{
    id: 'UC-001',
    name: '验证产品规格 Package',
    actor: 'ACTOR-001',
    goal: '在交付前确认产品规格可以被下游安全消费',
    value: '在交付前发现结构和引用问题',
    trigger: '规格作者请求验证当前 Package',
    preconditions: ['Package 已包含待验证的规格内容'],
    postconditions: {
      success: ['显示可交付状态及对应证据'],
      failure: ['保留原始规格并显示可定位错误'],
    },
    mainScenario: [{
      id: 'UC-001-STEP-01',
      initiator: 'actor',
      action: '规格作者提交 Package 验证请求',
      systemResponse: '系统执行结构、引用和门禁检查',
      observableResult: '规格作者看到通过状态和验证证据',
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
        systemResponse: '系统返回引用错误位置和 blocker code',
        observableResult: '规格作者看到失败状态且原始规格未被修改',
      }],
      outcome: 'Package 保持不可交付，等待规格作者修复引用',
    }],
    businessRules: ['BR-001'],
    acceptanceCriteria: [{
      id: 'AC-001',
      scenario: 'main',
      given: 'Package 结构与引用均有效',
      when: '规格作者运行验证',
      then: '系统显示通过状态和验证证据',
    }, {
      id: 'AC-002',
      scenario: 'UC-001-EXC-01',
      given: 'Package 存在无效引用',
      when: '规格作者运行验证',
      then: '系统显示失败状态、错误位置和 blocker code',
    }],
    relationships: [],
  }];

  markReady(interactions.data);
  interactions.data.screens = [{
    id: 'SCREEN-001',
    name: '规格检查页',
    purpose: '发起 Package 验证并展示可审阅结果',
    useCases: ['UC-001'],
    regions: [{
      id: 'REGION-001',
      name: '验证工作区',
      purpose: '集中展示验证动作、状态和证据',
      content: ['验证状态', '错误位置', '验证证据'],
      controls: [{
        id: 'CONTROL-001',
        type: 'action',
        label: '运行验证',
        purpose: '提交当前 Package 验证请求',
        dataBinding: null,
        action: 'validate-package',
      }, {
        id: 'CONTROL-002',
        type: 'display',
        label: '验证结果',
        purpose: '展示验证状态、blocker 和证据',
        dataBinding: 'validationResult',
        action: null,
      }],
    }],
  }];
  interactions.data.interactionStates = [
    {
      id: 'WF-STATE-001',
      screen: 'SCREEN-001',
      type: 'default',
      condition: '尚未运行验证',
      presentation: '显示可执行验证动作和空结果区',
      availableControls: ['CONTROL-001'],
      terminal: false,
    },
    {
      id: 'WF-STATE-002',
      screen: 'SCREEN-001',
      type: 'success',
      condition: '所有结构、引用和门禁检查通过',
      presentation: '显示通过状态和验证证据',
      availableControls: ['CONTROL-001', 'CONTROL-002'],
      terminal: true,
    },
    {
      id: 'WF-STATE-003',
      screen: 'SCREEN-001',
      type: 'error',
      condition: '存在无法解析的引用',
      presentation: '显示失败状态、错误位置和 blocker code',
      availableControls: ['CONTROL-001', 'CONTROL-002'],
      terminal: true,
    },
  ];
  interactions.data.wireflows = [{
    id: 'WF-001',
    useCase: 'UC-001',
    name: '验证规格',
    userGoal: '获得确定性验证结果',
    coveredScenarios: ['main', 'UC-001-EXC-01'],
    entryScreen: 'SCREEN-001',
    completionStates: ['WF-STATE-002', 'WF-STATE-003'],
    steps: [{
      id: 'WF-001-STEP-01',
      scenario: 'main',
      actorAction: '规格作者选择运行验证',
      systemResponse: '执行检查并汇总通过证据',
      from: { screen: 'SCREEN-001', state: 'WF-STATE-001' },
      event: 'validate-package',
      control: 'CONTROL-001',
      guard: null,
      to: { screen: 'SCREEN-001', state: 'WF-STATE-002' },
      visibleFeedback: '结果区显示通过状态和证据',
    }, {
      id: 'WF-001-STEP-02',
      scenario: 'UC-001-EXC-01',
      actorAction: '规格作者选择运行验证',
      systemResponse: '检测到无效引用并停止交付判定',
      from: { screen: 'SCREEN-001', state: 'WF-STATE-001' },
      event: 'validate-package',
      control: 'CONTROL-001',
      guard: 'Package 中存在无法解析的引用',
      to: { screen: 'SCREEN-001', state: 'WF-STATE-003' },
      visibleFeedback: '结果区显示失败状态、错误位置和 blocker code',
    }],
  }];

  const prototypeRoot = stage.areas['canonical-ui-prototype'].root;
  const areaPath = resolve(root, stage.root, prototypeRoot);
  const sourceId = 'DESIGN-SOURCE-001';
  const sourceRoot = resolve(areaPath, 'design-sources', sourceId);
  const assetRoot = resolve(areaPath, 'public/assets', sourceId);
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(assetRoot, { recursive: true }),
  ]);
  const location = 'https://www.figma.com/design/example/psp-harness?node-id=1-2';
  const capturedAt = '2026-07-15T10:00:00Z';
  const designContext = JSON.stringify({ nodeId: '1:2', name: '规格检查页', layout: 'responsive' }, null, 2) + '\n';
  const variableDefinitions = JSON.stringify({ variables: [{ name: 'color/accent', value: '#c8f36a' }] }, null, 2) + '\n';
  const screenshot = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#fffdf7"/><circle cx="5" cy="5" r="3" fill="#c8f36a"/></svg>\n';
  const asset = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="8" fill="#c8f36a"/><path d="M10 21l6 6 14-15" fill="none" stroke="#15210f" stroke-width="4"/></svg>\n';
  const contextPath = resolve(sourceRoot, 'design-context.json');
  const variablesPath = resolve(sourceRoot, 'variable-definitions.json');
  const screenshotPath = resolve(sourceRoot, 'node-screenshot.svg');
  const assetPath = resolve(assetRoot, 'source.svg');
  await Promise.all([
    writeFile(contextPath, designContext),
    writeFile(variablesPath, variableDefinitions),
    writeFile(screenshotPath, screenshot),
    writeFile(assetPath, asset),
  ]);
  const evidence = {
    version: '2.0.0',
    sourceId,
    kind: 'figma',
    location,
    capturedAt,
    nodeId: '1:2',
    items: [
      { id: 'EVIDENCE-CONTEXT-001', role: 'design-context', path: 'design-sources/DESIGN-SOURCE-001/design-context.json', sha256: sha256(designContext) },
      { id: 'EVIDENCE-SCREENSHOT-001', role: 'screenshot', path: 'design-sources/DESIGN-SOURCE-001/node-screenshot.svg', sha256: sha256(screenshot) },
      { id: 'EVIDENCE-VARIABLES-001', role: 'variable-definitions', path: 'design-sources/DESIGN-SOURCE-001/variable-definitions.json', sha256: sha256(variableDefinitions) },
      { id: 'EVIDENCE-ASSET-001', role: 'asset', path: 'public/assets/DESIGN-SOURCE-001/source.svg', sha256: sha256(asset) },
    ],
  };
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(resolve(sourceRoot, 'evidence.json'), evidenceText);
  const allStateIds = ['WF-STATE-001', 'COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'];
  const allViewportIds = ['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'];
  const canonical = {
    version: '2.0.0',
    designSources: [{
      id: sourceId,
      kind: 'figma',
      location,
      status: 'available',
      capturedAt,
      evidence: { path: 'design-sources/DESIGN-SOURCE-001/evidence.json', sha256: sha256(evidenceText) },
      coverage: [{
        screenId: 'SCREEN-001',
        stateIds: allStateIds,
        viewportIds: allViewportIds,
        evidenceItemIds: ['EVIDENCE-CONTEXT-001', 'EVIDENCE-SCREENSHOT-001'],
      }],
    }],
    assets: [{ id: 'ASSET-001', path: 'public/assets/DESIGN-SOURCE-001/source.svg', kind: 'image', sourceIds: [sourceId], usageTargetIds: ['COMPONENT-001'], alt: 'Fixture source' }],
    tokens: [{ id: 'TOKEN-COLOR-ACCENT', type: 'color', value: '#c8f36a', sourceIds: [sourceId] }],
    routes: [{ id: 'ROUTE-001', path: '/', screenId: 'SCREEN-001' }],
    screens: [{ id: 'SCREEN-001', title: '规格验证', routeId: 'ROUTE-001', stateIds: ['WF-STATE-001'], componentIds: ['COMPONENT-001'] }],
    components: [{ id: 'COMPONENT-001', name: '验证状态', controlIds: ['CONTROL-001', 'CONTROL-002'], stateIds: ['COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'] }],
    controls: [{ id: 'CONTROL-001', componentId: 'COMPONENT-001', label: '模拟成功' }, { id: 'CONTROL-002', componentId: 'COMPONENT-001', label: '模拟错误' }],
    states: [
      { id: 'WF-STATE-001', scope: 'workflow', ownerId: 'SCREEN-001', label: '等待验证' },
      { id: 'COMPONENT-STATE-DEFAULT', scope: 'component', ownerId: 'COMPONENT-001', label: '默认' },
      { id: 'COMPONENT-STATE-LOADING', scope: 'component', ownerId: 'COMPONENT-001', label: '加载' },
      { id: 'COMPONENT-STATE-SUCCESS', scope: 'component', ownerId: 'COMPONENT-001', label: '成功' },
      { id: 'COMPONENT-STATE-ERROR', scope: 'component', ownerId: 'COMPONENT-001', label: '错误' },
    ],
    events: [{ id: 'EVENT-001', name: 'submit-success', controlId: 'CONTROL-001' }, { id: 'EVENT-002', name: 'submit-error', controlId: 'CONTROL-002' }],
    actions: [{ id: 'ACTION-001', name: 'request-success', eventId: 'EVENT-001', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS'] }, { id: 'ACTION-002', name: 'request-error', eventId: 'EVENT-002', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'] }],
    scenarios: [
      { id: 'SCENARIO-001', useCaseId: 'UC-001', wireflowIds: ['WF-001'], routeId: 'ROUTE-001', initialStateIds: ['WF-STATE-001', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-001'], expectedStateIds: ['COMPONENT-STATE-SUCCESS'], viewportIds: allViewportIds },
      { id: 'SCENARIO-002', useCaseId: 'UC-001', wireflowIds: ['WF-001'], routeId: 'ROUTE-001', initialStateIds: ['WF-STATE-001', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-002'], expectedStateIds: ['COMPONENT-STATE-ERROR'], viewportIds: allViewportIds },
    ],
    mockBehaviors: [{ id: 'MOCK-001', request: 'GET /api/spec-preview?mode=success', responseStateIds: ['COMPONENT-STATE-SUCCESS'] }],
    viewports: [{ id: 'VIEWPORT-MOBILE', width: 390, height: 844 }, { id: 'VIEWPORT-DESKTOP', width: 1440, height: 1000 }],
    visualAssertions: [
      {
        id: 'VISUAL-ROUTE-001',
        routeId: 'ROUTE-001',
        viewportIds: allViewportIds,
        sourceIds: [sourceId],
        checks: [
          { kind: 'document-no-horizontal-overflow' },
          { kind: 'element-visible', targetIds: ['SCREEN-001', 'COMPONENT-001', 'CONTROL-001', 'CONTROL-002'] },
          { kind: 'elements-no-overlap', targetIds: ['CONTROL-001', 'CONTROL-002'] },
          { kind: 'text-no-clipping', targetIds: ['CONTROL-001', 'CONTROL-002'] },
          { kind: 'computed-style', targetId: 'CONTROL-001', property: 'min-height', expected: '44px' },
        ],
      },
      { id: 'VISUAL-SCENARIO-001', routeId: 'ROUTE-001', scenarioId: 'SCENARIO-001', viewportIds: allViewportIds, sourceIds: [sourceId], checks: [{ kind: 'element-visible', targetIds: ['COMPONENT-STATE-SUCCESS'] }] },
      { id: 'VISUAL-SCENARIO-002', routeId: 'ROUTE-001', scenarioId: 'SCENARIO-002', viewportIds: allViewportIds, sourceIds: [sourceId], checks: [{ kind: 'element-visible', targetIds: ['COMPONENT-STATE-ERROR'] }] },
    ],
    motions: [{ id: 'MOTION-001', targetId: 'COMPONENT-001', trigger: 'loading', durationMs: 160, reducedMotion: true }],
    accessibility: { standard: 'Web Content Accessibility Guidelines 2.2 AA', checks: ['automated-rules', 'keyboard-operation', 'visible-focus', 'accessible-name', 'target-size'] },
    traceability: [{ useCaseId: 'UC-001', wireflowIds: ['WF-001'], screenIds: ['SCREEN-001'], controlIds: ['CONTROL-001', 'CONTROL-002'], stateIds: ['COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'] }],
    gaps: [],
  };
  await writeFile(resolve(areaPath, 'src/spec/canonical-ui.ts'), 'export const canonicalUi = ' + JSON.stringify(canonical, null, 2) + ' as const;\n');
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app
    .replaceAll('UC-NNN', 'UC-001')
    .replaceAll('WF-STATE-NNN', 'WF-STATE-001')
    .replace('<h2>交互状态实验台</h2>', '<h2>交互状态实验台</h2>\n            <img src="/assets/DESIGN-SOURCE-001/source.svg" alt="Fixture source" width="40" height="40" />'));

  await Promise.all([
    writeArtifact(product),
    writeArtifact(capabilities),
    writeArtifact(interactions),
  ]);
  const render = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
}
