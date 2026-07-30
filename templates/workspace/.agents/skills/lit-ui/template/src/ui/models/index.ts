export type ConceptId = string & { readonly __conceptId: unique symbol };

export interface UiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
