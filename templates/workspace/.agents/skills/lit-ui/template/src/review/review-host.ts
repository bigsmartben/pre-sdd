export interface ProductObservation {
  readonly conceptId: string;
  readonly state: Readonly<Record<string, unknown>>;
}

export interface ReviewDriver {
  locate(conceptId: string): Element | null;
  observe(conceptId: string): ProductObservation | null;
  dispatch(conceptId: string, event: Event): boolean;
}

export interface ReviewMark {
  readonly markId: string;
  readonly conceptId: string;
  readonly kind: 'interaction' | 'visual' | 'position-size' | 'text';
  readonly note: string;
}

export interface ReviewTool {
  connect(driver: ReviewDriver): void;
  disconnect(): void;
}
