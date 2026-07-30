export type VisualItemId = string & { readonly __visualItemId: unique symbol };

export interface UiError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}
