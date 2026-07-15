export const canonicalUi = {
  version: '2.0.0',
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
      stateIds: ['WF-STATE-NNN'],
      componentIds: ['COMPONENT-001'],
    },
  ],
  components: [
    {
      id: 'COMPONENT-001',
      name: '异步操作实验台',
      controlIds: ['CONTROL-001', 'CONTROL-002'],
      stateIds: ['COMPONENT-STATE-DEFAULT', 'COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'],
    },
  ],
  controls: [
    { id: 'CONTROL-001', componentId: 'COMPONENT-001', label: '模拟成功' },
    { id: 'CONTROL-002', componentId: 'COMPONENT-001', label: '模拟错误' },
  ],
  states: [
    { id: 'WF-STATE-NNN', scope: 'workflow', ownerId: 'SCREEN-001', label: '待替换的 Wireflow 状态' },
    { id: 'COMPONENT-STATE-DEFAULT', scope: 'component', ownerId: 'COMPONENT-001', label: '默认' },
    { id: 'COMPONENT-STATE-LOADING', scope: 'component', ownerId: 'COMPONENT-001', label: '加载' },
    { id: 'COMPONENT-STATE-SUCCESS', scope: 'component', ownerId: 'COMPONENT-001', label: '成功' },
    { id: 'COMPONENT-STATE-ERROR', scope: 'component', ownerId: 'COMPONENT-001', label: '错误' },
  ],
  events: [
    { id: 'EVENT-001', name: 'submit-success', controlId: 'CONTROL-001' },
    { id: 'EVENT-002', name: 'submit-error', controlId: 'CONTROL-002' },
  ],
  actions: [
    { id: 'ACTION-001', name: 'request-success', eventId: 'EVENT-001', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS'] },
    { id: 'ACTION-002', name: 'request-error', eventId: 'EVENT-002', resultingStateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'] },
  ],
  scenarios: [
    { id: 'SCENARIO-001', useCaseId: 'UC-NNN', wireflowIds: ['WF-STATE-NNN'], routeId: 'ROUTE-001', initialStateIds: ['WF-STATE-NNN', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-001'], expectedStateIds: ['COMPONENT-STATE-SUCCESS'], viewportIds: ['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'] },
    { id: 'SCENARIO-002', useCaseId: 'UC-NNN', wireflowIds: ['WF-STATE-NNN'], routeId: 'ROUTE-001', initialStateIds: ['WF-STATE-NNN', 'COMPONENT-STATE-DEFAULT'], eventIds: ['EVENT-002'], expectedStateIds: ['COMPONENT-STATE-ERROR'], viewportIds: ['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP'] },
  ],
  mockBehaviors: [
    { id: 'MOCK-001', request: 'GET /api/spec-preview?mode=success', responseStateIds: ['COMPONENT-STATE-SUCCESS'] },
    { id: 'MOCK-002', request: 'GET /api/spec-preview?mode=error', responseStateIds: ['COMPONENT-STATE-ERROR'] },
  ],
  viewports: [
    { id: 'VIEWPORT-MOBILE', width: 390, height: 844 },
    { id: 'VIEWPORT-DESKTOP', width: 1440, height: 1000 },
  ],
  visualAssertions: [],
  motions: [
    { id: 'MOTION-001', targetId: 'COMPONENT-001', trigger: 'loading', durationMs: 160, reducedMotion: true },
  ],
  accessibility: {
    standard: 'Web Content Accessibility Guidelines 2.2 AA',
    checks: ['automated-rules', 'keyboard-operation', 'visible-focus', 'accessible-name', 'target-size'],
  },
  traceability: [
    { useCaseId: 'UC-NNN', wireflowIds: ['WF-STATE-NNN'], screenIds: ['SCREEN-001'], controlIds: ['CONTROL-001', 'CONTROL-002'], stateIds: ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS', 'COMPONENT-STATE-ERROR'] },
  ],
  gaps: [
    { id: 'GAP-001', description: '用实际产品事实替换所有 NNN 占位标识并补充设计来源。', owner: 'product-design' },
  ],
} as const;
