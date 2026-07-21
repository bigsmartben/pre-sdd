import { LitElement, css, html } from 'lit';
import { canonicalUi } from './spec/canonical-ui';

type MockCase = {
  id: string;
  label: string;
  routeId: string;
  screenId: string;
  isDefault: boolean;
};

const model = canonicalUi as unknown as {
  routes: ReadonlyArray<{ id: string; path: string; screenId: string }>;
  screens: ReadonlyArray<{ id: string; title: string }>;
  mockCases: readonly MockCase[];
};

export class MockcaseSwitcher extends LitElement {
  static properties = {
    selectedCaseId: { state: true },
    pending: { state: true },
    status: { state: true },
  };

  declare private selectedCaseId: string;
  declare private pending: boolean;
  declare private status: string;
  private timeoutId: number | undefined;

  constructor() {
    super();
    this.selectedCaseId = '';
    this.pending = false;
    this.status = '等待页面状态就绪';
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('data-review-tool', 'mockcase-switcher');
    window.addEventListener('psp:mockcase-ready', this.handleReady as EventListener);
    window.addEventListener('psp:mockcase-error', this.handleError as EventListener);
    window.requestAnimationFrame(() => this.restoreFromUrl());
  }

  disconnectedCallback(): void {
    window.removeEventListener('psp:mockcase-ready', this.handleReady as EventListener);
    window.removeEventListener('psp:mockcase-error', this.handleError as EventListener);
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId);
    super.disconnectedCallback();
  }

  private routeCases(): readonly MockCase[] {
    const route = model.routes.find((item) => item.path === window.location.pathname);
    return route ? model.mockCases.filter((item) => item.routeId === route.id && item.screenId === route.screenId) : [];
  }

  private restoreFromUrl(): void {
    const cases = this.routeCases();
    const deepLink = new URLSearchParams(window.location.search).get('psp-case');
    const initial = cases.find((item) => item.id === deepLink) ?? cases.find((item) => item.isDefault);
    if (initial) this.requestCase(initial.id, false);
  }

  private requestCase(caseId: string, updateUrl = true): void {
    if (!this.routeCases().some((item) => item.id === caseId)) return;
    this.pending = true;
    this.status = `正在切换到 ${caseId}`;
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId);
    this.timeoutId = window.setTimeout(() => {
      this.pending = false;
      this.status = `切换超时：${caseId}`;
      this.dispatchEvent(new CustomEvent('psp:mockcase-timeout', { detail: { caseId }, bubbles: true, composed: true }));
    }, 3000);
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('psp-case', caseId);
      window.history.replaceState({}, '', url);
    }
    window.dispatchEvent(new CustomEvent('psp:mockcase-request', { detail: { caseId } }));
  }

  private readonly handleReady = (event: CustomEvent<{ caseId: string }>): void => {
    if (!this.routeCases().some((item) => item.id === event.detail.caseId)) return;
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId);
    this.selectedCaseId = event.detail.caseId;
    this.pending = false;
    this.status = `已就绪：${event.detail.caseId}`;
  };

  private readonly handleError = (event: CustomEvent<{ caseId: string; message: string }>): void => {
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId);
    this.pending = false;
    this.status = `切换失败：${event.detail.caseId} · ${event.detail.message}`;
  };

  protected render() {
    const cases = this.routeCases();
    const screen = model.screens.find((item) => item.id === cases[0]?.screenId);
    return html`
      <details open>
        <summary>Mock Cases</summary>
        <label for="mockcase-select">${screen?.title ?? '当前页面'}</label>
        <select
          id="mockcase-select"
          aria-label="选择 Mock Case"
          .value=${this.selectedCaseId}
          ?disabled=${this.pending}
          @change=${(event: Event) => this.requestCase((event.target as HTMLSelectElement).value)}
        >
          ${cases.map((item) => html`<option value=${item.id}>${item.label}${item.isDefault ? ' · Default' : ''}</option>`)}
        </select>
        <output role="status" aria-live="polite">${this.status}</output>
      </details>
    `;
  }

  static styles = css`
    :host { position: fixed; z-index: 2147483645; right: 20px; bottom: 20px; width: min(320px, calc(100vw - 24px)); color: #182019; font: 14px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
    details { padding: 12px; border: 1px solid #182019; border-radius: 14px; background: #fffdf7; box-shadow: 0 16px 44px rgba(24, 32, 25, .2); }
    summary { cursor: pointer; font-weight: 800; }
    label, output { display: block; margin-top: 10px; color: #697269; font-size: 12px; }
    select { width: 100%; min-height: 44px; margin-top: 6px; padding-inline: 10px; border: 1px solid #8b938b; border-radius: 8px; color: inherit; background: white; font: inherit; }
    select:focus-visible, summary:focus-visible { outline: 3px solid #678e25; outline-offset: 2px; }
    @media (max-width: 520px) { :host { right: 12px; bottom: 12px; } }
  `;
}

customElements.define('mockcase-switcher', MockcaseSwitcher);

declare global {
  interface HTMLElementTagNameMap {
    'mockcase-switcher': MockcaseSwitcher;
  }
}
