import type { TemplateResult } from 'lit';

export interface ProductPage {
  readonly conceptId: string;
  render(): TemplateResult;
}
