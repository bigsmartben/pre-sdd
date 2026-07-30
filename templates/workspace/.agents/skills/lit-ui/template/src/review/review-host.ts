export interface ProductObservation {
  readonly itemId: string;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface ReviewDriver {
  locate(itemId: string): Element | null;
  observe(itemId: string): ProductObservation | null;
  dispatch(itemId: string, event: Event): boolean;
}

export interface ReviewMark {
  readonly markId: string;
  readonly itemId: string;
  readonly level: 'L1' | 'L2';
  readonly testCaseId: string | null;
  readonly pathStepId: string | null;
  readonly kind: 'interaction' | 'visual' | 'position-size' | 'text';
  readonly note: string;
}

export interface ReviewTool {
  connect(driver: ReviewDriver): void;
  disconnect(): void;
}
