import type { TemplateResult } from 'lit';

export interface ProductPage {
  readonly visualItemId: string;
  render(): TemplateResult;
}
