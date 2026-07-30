import { LitElement, css, html } from 'lit';
import type { ReviewDriver, ReviewMark, ReviewTool } from './review-host.js';

export class InconsistencyAnnotator extends LitElement implements ReviewTool {
  static properties = { marks: { attribute: false } };
  marks: readonly ReviewMark[] = [];
  private driver?: ReviewDriver;

  connect(driver: ReviewDriver): void {
    this.driver = driver;
  }

  disconnect(): void {
    this.driver = undefined;
  }

  highlight(itemId: string): void {
    const target = this.driver?.locate(itemId);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  protected render() {
    return html`<aside aria-label="不一致标记">
      <h2>Review Tools</h2>
      ${this.marks.map((mark) => html`
        <button type="button" @click=${() => this.highlight(mark.itemId)}>
          ${mark.level} · ${mark.kind} · ${mark.itemId}: ${mark.note}
        </button>
      `)}
    </aside>`;
  }

  static styles = css`
    :host { position: fixed; right: 1rem; bottom: 1rem; z-index: 2147483647; }
    aside { max-width: 24rem; padding: 1rem; background: Canvas; color: CanvasText; border: 1px solid; }
    button { display: block; width: 100%; margin-block: .5rem; }
  `;
}

if (!customElements.get('psp-inconsistency-annotator')) {
  customElements.define('psp-inconsistency-annotator', InconsistencyAnnotator);
}
