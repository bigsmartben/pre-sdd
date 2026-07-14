import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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

export async function completeProductFixture(root) {
  const initialization = runScript('.psp/harness/scripts/init-product.mjs', root, ['--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const product = await readArtifact(root, stage, stage.artifacts['product-package']);
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);
  const interactions = await readArtifact(root, stage, stage.artifacts.interactions);
  const ui = await readArtifact(root, stage, stage.artifacts['ui-spec']);
  const catalog = await readArtifact(root, stage, stage.artifacts['component-catalog']);
  const trace = await readArtifact(root, stage, stage.artifacts.traceability, 'json');

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

  markReady(catalog.data);
  const prototypeRoot = stage.areas['html-mock'].root;
  catalog.data.components = [{
    id: 'COMPONENT-001',
    htmlMocks: ['HTML-MOCK-001'],
    responsibility: '展示验证状态',
    inputs: ['validationState'],
    outputs: ['validate'],
    states: ['default', 'success', 'error'],
    variants: ['default'],
    accessibility: ['使用语义状态文本'],
    prototype: prototypeRoot + '/src/psp-app.ts',
  }];

  markReady(ui.data);
  const localizedAsset = prototypeRoot + '/public/figma-wordmark.svg';
  const localizedAssetContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Figma source fixture</title><rect width="10" height="10" fill="#c8f36a"/></svg>\n';
  await writeFile(resolve(root, stage.root, localizedAsset), localizedAssetContent);
  ui.data.designSources = [{
    id: 'DESIGN-SOURCE-001',
    type: 'figma',
    location: 'https://www.figma.com/design/example/psp-harness',
    nodeId: '1:1',
    scope: '规格验证界面及验证状态',
    status: 'available',
    evidence: {
      path: localizedAsset,
      sha256: createHash('sha256').update(localizedAssetContent).digest('hex'),
      capturedAt: '2026-01-01T00:00:00Z',
    },
  }];
  ui.data.assetBindings = [{
    id: 'ASSET-BINDING-001',
    kind: 'logo',
    source: 'DESIGN-SOURCE-001',
    sourceNode: '1:2',
    localPath: localizedAsset,
    htmlMocks: ['HTML-MOCK-001'],
    usages: [{
      htmlMock: 'HTML-MOCK-001',
      scenario: null,
      entry: prototypeRoot + '/src/psp-app.ts',
      reference: '/figma-wordmark.svg',
      selector: '[data-asset-binding="ASSET-BINDING-001"]',
    }],
    status: 'localized',
  }];
  ui.data.htmlMocks = [{
    id: 'HTML-MOCK-001',
    name: '规格验证界面',
    useCases: ['UC-001'],
    wireflows: ['WF-001'],
    designSources: ['DESIGN-SOURCE-001'],
    entry: prototypeRoot + '/src/psp-app.ts',
    route: '/',
    screens: [{
      screen: 'SCREEN-001',
      selector: '[data-screen="SCREEN-001"]',
      purpose: '实现规格检查页及其全部可见状态',
    }],
    components: ['COMPONENT-001'],
  }];
  ui.data.interactionScenarios = [{
    id: 'HTML-SCENARIO-001',
    htmlMock: 'HTML-MOCK-001',
    wireflow: 'WF-001',
    ucScenario: 'main',
    name: '规格验证通过',
    startRoute: '/',
    steps: [{
      id: 'HTML-STEP-001',
      action: 'click',
      target: '[data-control="CONTROL-001"]',
      input: null,
      expectedScreen: 'SCREEN-001',
      expectedState: 'WF-STATE-002',
      expectedFeedback: '显示通过状态和验证证据',
    }],
  }, {
    id: 'HTML-SCENARIO-002',
    htmlMock: 'HTML-MOCK-001',
    wireflow: 'WF-001',
    ucScenario: 'UC-001-EXC-01',
    name: '规格引用无效',
    startRoute: '/?fixture=invalid-reference',
    steps: [{
      id: 'HTML-STEP-002',
      action: 'click',
      target: '[data-control="CONTROL-001"]',
      input: null,
      expectedScreen: 'SCREEN-001',
      expectedState: 'WF-STATE-003',
      expectedFeedback: '显示失败状态、错误位置和 blocker code',
    }],
  }];
  ui.data.visualRules = [{
    id: 'VISUAL-RULE-001',
    scope: '验证状态',
    specification: '状态使用语义 Token',
    intent: '保持结果可辨识',
    sourceRefs: ['DESIGN-SOURCE-001'],
  }];
  ui.data.mockBehaviors = [{
    id: 'MOCK-BEHAVIOR-001',
    scenario: 'HTML-SCENARIO-002',
    trigger: 'validate-package',
    fixture: 'invalid-reference',
    latencyMs: 0,
    resultState: 'WF-STATE-003',
  }];
  ui.data.viewports = [{
    id: 'VIEWPORT-001',
    name: 'Mobile',
    width: 390,
    height: 844,
    required: true,
  }, {
    id: 'VIEWPORT-002',
    name: 'Desktop',
    width: 1280,
    height: 800,
    required: true,
  }];
  ui.data.accessibility = [{
    id: 'A11Y-001',
    requirement: '状态变化通过文本与语义区域通知',
    verification: '使用键盘触发验证并确认 role=status 可读出结果',
  }];

  trace.data.links = [{
    useCase: 'UC-001',
    wireflows: ['WF-001'],
    htmlMocks: ['HTML-MOCK-001'],
  }];

  const prototypeEntry = resolve(root, stage.root, prototypeRoot, 'src/psp-app.ts');
  await writeFile(
    prototypeEntry,
    `import { LitElement, css, html } from 'lit';

export class ProductFixtureApp extends LitElement {
  static properties = {
    stateId: { state: true },
    feedback: { state: true },
  };

  declare private stateId: string;
  declare private feedback: string;

  constructor() {
    super();
    this.stateId = 'WF-STATE-001';
    this.feedback = '等待运行验证';
  }

  private validatePackage(): void {
    const invalid = new URLSearchParams(window.location.search).get('fixture') === 'invalid-reference';
    this.stateId = invalid ? 'WF-STATE-003' : 'WF-STATE-002';
    this.feedback = invalid
      ? '显示失败状态、错误位置和 blocker code'
      : '显示通过状态和验证证据';
  }

  protected render() {
    return html\`
      <main data-screen="SCREEN-001">
        <img data-asset-binding="ASSET-BINDING-001" src="/figma-wordmark.svg" alt="Fixture logo" />
        <section data-state-id=\${this.stateId} role="status">\${this.feedback}</section>
        <button data-control="CONTROL-001" @click=\${this.validatePackage}>运行验证</button>
      </main>
    \`;
  }

  static styles = css\`
    :host { display: block; min-height: 100vh; }
    main { width: min(100% - 24px, 960px); margin: 0 auto; padding: 24px; box-sizing: border-box; }
    img { width: 40px; height: 40px; }
    section { margin: 24px 0; }
    button { min-height: 44px; }
  \`;
}

export const htmlMockTraceMarkers = ['HTML-MOCK-001', 'SCREEN-001', 'HTML-SCENARIO-001', 'HTML-SCENARIO-002'];
customElements.define('psp-app', ProductFixtureApp);

declare global {
  interface HTMLElementTagNameMap {
    'psp-app': ProductFixtureApp;
  }
}
`,
  );

  await Promise.all([
    writeArtifact(product),
    writeArtifact(capabilities),
    writeArtifact(interactions),
    writeArtifact(ui),
    writeArtifact(catalog),
    writeArtifact(trace, 'json'),
  ]);
  const render = runScript('.psp/harness/scripts/render-artifacts.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
}
