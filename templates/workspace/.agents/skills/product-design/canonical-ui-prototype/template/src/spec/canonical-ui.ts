export const canonicalUi = {
  version: '9.0.0',
  actor: 'ACTOR-001',
  draft: {
    version: '0.1.0',
    inputs: {
      useCases: { version: '0.1.0', contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
      visualSpec: { version: '0.1.0', contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' },
    },
  },
  visualPolicy: {
    mode: 'unresolved',
    selectedBy: 'default-policy',
    aspects: [],
    coverage: [],
  },
  repairPolicy: {
    enabled: false,
    maxAttempts: 1,
    repairableBlockerCodes: ['AIH_VISUAL_SOURCE_PARITY_FAILED', 'AIH_VISUAL_STYLE_BINDING_FAILED'],
    allowedImplementationPaths: [
      'index.html',
      'src/main.ts',
      'src/psp-app.ts',
      'src/mock-api.ts',
      'src/components/**/*.ts',
      'src/components/**/*.css',
      'src/styles/**/*.css',
      'src/*.css',
    ],
  },
  designSources: [],
  assets: [],
  tokens: [],
  routes: [
    { id: 'ROUTE-001', path: '/', screenId: 'SCREEN-001' },
  ],
  screens: [
    {
      id: 'SCREEN-001',
      title: 'Canonical UI Prototype 起始页',
      routeId: 'ROUTE-001',
      stateIds: ['INT-STATE-NNN'],
      componentIds: ['COMPONENT-001'],
    },
  ],
  components: [
    {
      id: 'COMPONENT-001',
      name: '异步操作实验台',
      controlIds: ['CONTROL-001', 'CONTROL-002', 'CONTROL-003'],
      stateIds: ['COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'],
    },
  ],
  componentInventory: [],
  componentMappings: [],
  componentVariantCoverage: [],
  componentContracts: [],
  stateAxes: [],
  stateMatrix: [],
  controls: [
    { id: 'CONTROL-001', componentId: 'COMPONENT-001', label: '模拟成功' },
    { id: 'CONTROL-002', componentId: 'COMPONENT-001', label: '模拟错误' },
    { id: 'CONTROL-003', componentId: 'COMPONENT-001', label: '返回重试' },
  ],
  states: [
    { id: 'INT-STATE-NNN', scope: 'workflow', ownerId: 'SCREEN-001', label: '待替换的正式 Interaction State' },
    { id: 'COMPONENT-STATE-DEFAULT', scope: 'component', ownerId: 'COMPONENT-001', label: '默认' },
    { id: 'COMPONENT-STATE-LOADING', scope: 'component', ownerId: 'COMPONENT-001', label: '加载' },
    { id: 'COMPONENT-STATE-SUCCESS', scope: 'component', ownerId: 'COMPONENT-001', label: '成功' },
    { id: 'COMPONENT-STATE-ERROR', scope: 'component', ownerId: 'COMPONENT-001', label: '错误' },
  ],
  events: [
    { id: 'EVENT-001', name: 'submit-success', controlId: 'CONTROL-001' },
    { id: 'EVENT-002', name: 'submit-error', controlId: 'CONTROL-002' },
    { id: 'EVENT-003', name: 'return-retry', controlId: 'CONTROL-003' },
  ],
  actions: [
    { id: 'ACTION-001', name: 'request-success', eventId: 'EVENT-001', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS'] },
    { id: 'ACTION-002', name: 'request-error', eventId: 'EVENT-002', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'] },
    { id: 'ACTION-003', name: 'return-to-entry', eventId: 'EVENT-003', resultingStateIds: ['COMPONENT-STATE-DEFAULT'] },
  ],
  scenarios: [
    { id: 'SCENARIO-001', useCaseId: 'UC-NNN', interactionFlowIds: ['IF-NNN'], transitionIds: ['IF-NNN-TRANS-NN'], recoveryStateIds: [], routeId: 'ROUTE-001', initialStateIds: ['INT-STATE-NNN', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-001'], expectedStateIds: ['COMPONENT-STATE-SUCCESS'], viewportIds: [] },
    { id: 'SCENARIO-002', useCaseId: 'UC-NNN', interactionFlowIds: ['IF-NNN'], transitionIds: ['IF-NNN-TRANS-NN'], recoveryStateIds: [], routeId: 'ROUTE-001', initialStateIds: ['INT-STATE-NNN', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-002'], expectedStateIds: ['COMPONENT-STATE-ERROR'], viewportIds: [] },
  ],
  mockBehaviors: [
    { id: 'MOCK-001', request: 'GET /api/spec-preview?mode=success', responseStateIds: ['COMPONENT-STATE-SUCCESS'] },
    { id: 'MOCK-002', request: 'GET /api/spec-preview?mode=error', responseStateIds: ['COMPONENT-STATE-ERROR'] },
  ],
  mockCases: [],
  viewports: [],
  renderAssertions: [],
  sourceParityAssertions: [],
  motions: [
    { id: 'MOTION-001', targetId: 'COMPONENT-001', trigger: 'loading', durationMs: 160, reducedMotion: true },
  ],
  traceability: [
    { useCaseId: 'UC-NNN', interactionFlowIds: ['IF-NNN'], screenIds: ['SCREEN-001'], controlIds: ['CONTROL-001', 'CONTROL-002', 'CONTROL-003'], stateIds: ['INT-STATE-NNN', 'COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'] },
  ],
  gaps: [
    { id: 'GAP-001', description: '先让用户选择界面运行环境，再用实际产品事实替换所有 NNN 占位标识并补充设计来源。', owner: 'product-design' },
  ],
} as const;
