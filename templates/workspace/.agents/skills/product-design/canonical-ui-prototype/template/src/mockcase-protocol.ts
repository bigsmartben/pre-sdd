export type MockCaseActivation = {
  kind: 'request' | 'control-event' | 'input';
  controlId?: string;
};

export type MockCaseEffect = {
  targetInstanceId: string;
  mockBehaviorIds: readonly string[];
  activation: MockCaseActivation;
  expectedStateMatrixEntryId: string;
};

export type MockCase = {
  id: string;
  kind: 'business' | 'technical';
  label: string;
  routeId: string;
  scenarioId?: string;
  effects: readonly MockCaseEffect[];
  isDefault: boolean;
};

export type MockCaseStatus = 'idle' | 'applying' | 'ready' | 'error' | 'conflict';

export type MockCaseRequestDetail = {
  transactionId: string;
  activeCaseIds: readonly string[];
};

export type MockCaseEffectResult = {
  caseId: string;
  targetInstanceId: string;
  expectedStateMatrixEntryId: string;
  status: 'ready' | 'error';
  actualStateIds: readonly string[];
  message?: string;
};

export type MockCaseReadyDetail = MockCaseRequestDetail & {
  effectResults: readonly MockCaseEffectResult[];
};

export type MockCaseErrorDetail = MockCaseRequestDetail & {
  code: string;
  message: string;
  effectResults: readonly MockCaseEffectResult[];
};

export function sortedCaseIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right));
}
