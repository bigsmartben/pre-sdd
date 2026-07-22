import { LitElement, css, html, nothing } from 'lit';
import { canonicalUi } from './spec/canonical-ui';
import type {
  MockCase,
  MockCaseErrorDetail,
  MockCaseReadyDetail,
  MockCaseStatus,
} from './mockcase-protocol';
import { sortedCaseIds } from './mockcase-protocol';

type Scenario = { id: string; useCaseId: string; routeId: string };

const model = canonicalUi as unknown as {
  routes: ReadonlyArray<{ id: string; path: string }>;
  scenarios: readonly Scenario[];
  mockCases: readonly MockCase[];
};

function transactionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `mockcase-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function conflicts(left: MockCase, right: MockCase): boolean {
  return left.effects.some((leftEffect) => right.effects.some((rightEffect) => (
    leftEffect.targetInstanceId === rightEffect.targetInstanceId
    && leftEffect.expectedStateMatrixEntryId !== rightEffect.expectedStateMatrixEntryId
  )));
}

export class MockcaseSwitcher extends LitElement {
  static properties = {
    activeCaseIds: { state: true },
    caseStatuses: { state: true },
    status: { state: true },
    replacement: { state: true },
  };

  declare private activeCaseIds: readonly string[];
  declare private caseStatuses: Readonly<Record<string, MockCaseStatus>>;
  declare private status: string;
  declare private replacement: { incoming: string; conflicts: readonly string[] } | null;
  private pendingTransactionId = '';
  private pendingCaseId = '';
  private timeoutId: number | undefined;

  constructor() {
    super();
    this.activeCaseIds = [];
    this.caseStatuses = {};
    this.status = '等待选择业务结果';
    this.replacement = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('data-review-tool', 'mockcase-review-plugin');
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

  private currentRouteId(): string | undefined {
    return model.routes.find((item) => item.path === window.location.pathname)?.id;
  }

  private routeCases(): readonly MockCase[] {
    const routeId = this.currentRouteId();
    return model.mockCases.filter((item) => item.routeId === routeId);
  }

  private restoreFromUrl(): void {
    const cases = this.routeCases();
    const query = new URLSearchParams(window.location.search);
    const multiValue = query.get('psp-cases');
    const legacyValue = query.get('psp-case');
    const requested = multiValue
      ? multiValue.split(',').filter(Boolean)
      : legacyValue ? [legacyValue] : cases.filter((item) => item.isDefault).map((item) => item.id);
    const allowed = new Set(cases.map((item) => item.id));
    const desired = sortedCaseIds(requested.filter((id) => allowed.has(id)));
    if (desired.length > 0) this.requestSet(desired, desired[0]);
  }

  private pairConflicts(ids: readonly string[]): Array<[MockCase, MockCase]> {
    const cases = ids.map((id) => this.routeCases().find((item) => item.id === id)).filter((item): item is MockCase => Boolean(item));
    const result: Array<[MockCase, MockCase]> = [];
    for (let left = 0; left < cases.length; left += 1) {
      for (let right = left + 1; right < cases.length; right += 1) {
        if (conflicts(cases[left], cases[right])) result.push([cases[left], cases[right]]);
      }
    }
    return result;
  }

  private requestSet(ids: readonly string[], changedCaseId: string): void {
    if (this.pendingTransactionId) {
      this.status = '上一笔 MockCase 事务仍在执行，请等待完成。';
      return;
    }
    const desired = sortedCaseIds(ids);
    const invalid = desired.find((id) => !this.routeCases().some((item) => item.id === id));
    if (invalid) {
      this.status = `未知或跨路由的 Case：${invalid}`;
      return;
    }
    const conflictPairs = this.pairConflicts(desired);
    if (conflictPairs.length > 0) {
      const involved = new Set(conflictPairs.flatMap((pair) => pair.map((item) => item.id)));
      this.caseStatuses = { ...this.caseStatuses, ...Object.fromEntries([...involved].map((id) => [id, 'conflict'])) };
      this.status = `组件实例冲突：${[...involved].join(' ↔ ')}`;
      return;
    }
    this.pendingTransactionId = transactionId();
    this.pendingCaseId = changedCaseId;
    this.replacement = null;
    this.caseStatuses = { ...this.caseStatuses, [changedCaseId]: 'applying' };
    this.status = `正在应用：${changedCaseId}`;
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId);
    this.timeoutId = window.setTimeout(() => {
      this.caseStatuses = { ...this.caseStatuses, [changedCaseId]: 'error' };
      this.status = `运行超时：${changedCaseId}`;
      window.dispatchEvent(new CustomEvent('psp:mockcase-timeout', {
        detail: { transactionId: this.pendingTransactionId, activeCaseIds: desired },
      }));
      this.pendingTransactionId = '';
    }, 4000);
    window.dispatchEvent(new CustomEvent('psp:mockcase-request', {
      detail: { transactionId: this.pendingTransactionId, activeCaseIds: desired },
    }));
  }

  private toggleCase(caseId: string, checked: boolean): void {
    const incoming = this.routeCases().find((item) => item.id === caseId);
    if (!incoming) return;
    if (!checked) {
      this.requestSet(this.activeCaseIds.filter((id) => id !== caseId), caseId);
      return;
    }
    const conflictIds = this.activeCaseIds.filter((id) => {
      const active = this.routeCases().find((item) => item.id === id);
      return active ? conflicts(incoming, active) : false;
    });
    if (conflictIds.length > 0) {
      this.replacement = { incoming: caseId, conflicts: conflictIds };
      this.caseStatuses = { ...this.caseStatuses, [caseId]: 'conflict' };
      this.status = `${caseId} 与 ${conflictIds.join(', ')} 冲突；当前选择保持不变。`;
      return;
    }
    this.requestSet([...this.activeCaseIds, caseId], caseId);
  }

  private replaceConflicts(): void {
    if (!this.replacement) return;
    const desired = this.activeCaseIds.filter((id) => !this.replacement?.conflicts.includes(id));
    this.requestSet([...desired, this.replacement.incoming], this.replacement.incoming);
  }

  private readonly handleReady = (event: CustomEvent<MockCaseReadyDetail>): void => {
    if (event.detail.transactionId !== this.pendingTransactionId) return;
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId);
    this.activeCaseIds = sortedCaseIds(event.detail.activeCaseIds);
    const active = new Set(this.activeCaseIds);
    this.caseStatuses = Object.fromEntries(this.routeCases().map((item) => [item.id, active.has(item.id) ? 'ready' : 'idle']));
    this.status = this.activeCaseIds.length > 0 ? `READY：${this.activeCaseIds.join(', ')}` : '已撤销全部 Case 影响';
    this.pendingTransactionId = '';
    this.writeUrl();
  };

  private readonly handleError = (event: CustomEvent<MockCaseErrorDetail>): void => {
    if (event.detail.transactionId !== this.pendingTransactionId) return;
    if (this.timeoutId !== undefined) window.clearTimeout(this.timeoutId);
    this.caseStatuses = { ...this.caseStatuses, [this.pendingCaseId]: event.detail.code === 'AIH_MOCKCASE_CONFLICT' ? 'conflict' : 'error' };
    this.status = `${event.detail.code}：${event.detail.message}`;
    this.pendingTransactionId = '';
  };

  private writeUrl(): void {
    const url = new URL(window.location.href);
    url.searchParams.delete('psp-case');
    if (this.activeCaseIds.length > 0) url.searchParams.set('psp-cases', sortedCaseIds(this.activeCaseIds).join(','));
    else url.searchParams.delete('psp-cases');
    window.history.replaceState({}, '', url);
  }

  private restoreDefaults(): void {
    const defaults = this.routeCases().filter((item) => item.isDefault).map((item) => item.id);
    this.requestSet(defaults, defaults[0] ?? this.activeCaseIds[0] ?? 'reset');
  }

  private async copyLink(): Promise<void> {
    try {
      await navigator.clipboard.writeText(window.location.href);
      this.status = '已复制可恢复当前 Case 集合的链接';
    } catch {
      this.status = '复制失败；请从地址栏复制当前链接';
    }
  }

  private renderCase(item: MockCase) {
    const state = this.caseStatuses[item.id] ?? 'idle';
    return html`
      <li data-mockcase-id=${item.id} data-mockcase-status=${state}>
        <label>
          <input
            type="checkbox"
            .checked=${this.activeCaseIds.includes(item.id)}
            ?disabled=${Boolean(this.pendingTransactionId) || state === 'applying'}
            @change=${(event: Event) => this.toggleCase(item.id, (event.target as HTMLInputElement).checked)}
          />
          <span>${item.label}${item.isDefault ? ' · Default' : ''}</span>
          <output>${state}</output>
        </label>
        <ul class="effects">
          ${item.effects.map((effect) => html`<li>${effect.targetInstanceId} → ${effect.expectedStateMatrixEntryId}</li>`)}
        </ul>
        ${this.replacement?.incoming === item.id
          ? html`<button class="replace" @click=${this.replaceConflicts}>替换冲突 Case</button>`
          : nothing}
      </li>
    `;
  }

  protected render() {
    const cases = this.routeCases();
    const routeId = this.currentRouteId();
    const scenarios = model.scenarios.filter((item) => item.routeId === routeId);
    const useCaseIds = [...new Set(scenarios.map((item) => item.useCaseId))].sort();
    const technical = cases.filter((item) => item.kind === 'technical');
    return html`
      <details open>
        <summary>Use Case Mock · ${window.location.pathname}</summary>
        <div class="tree" role="tree" aria-label="当前页面 MockCase 用例树">
          ${useCaseIds.map((useCaseId) => html`
            <section role="group">
              <h3>${useCaseId}</h3>
              ${scenarios.filter((item) => item.useCaseId === useCaseId).map((scenario) => html`
                <div class="scenario" role="group">
                  <h4>${scenario.id}</h4>
                  <ul>${cases.filter((item) => item.scenarioId === scenario.id).map((item) => this.renderCase(item))}</ul>
                </div>
              `)}
            </section>
          `)}
          ${technical.length > 0 ? html`<section role="group"><h3>Technical</h3><ul>${technical.map((item) => this.renderCase(item))}</ul></section>` : nothing}
          ${cases.length === 0 ? html`<p class="empty">当前 Route 尚无 MockCase。</p>` : nothing}
        </div>
        <output class="status" role="status" aria-live="polite">${this.status}</output>
        <div class="actions"><button @click=${this.restoreDefaults}>恢复默认</button><button @click=${this.copyLink}>复制链接</button></div>
      </details>
    `;
  }

  static styles = css`
    :host { position: fixed; z-index: 2147482900; right: 20px; bottom: 20px; width: min(390px, calc(100vw - 24px)); max-height: min(720px, calc(100vh - 24px)); color: #182019; font: 13px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    details { max-height: inherit; overflow: auto; padding: 14px; border: 1px solid #182019; border-radius: 14px; background: #fffdf7; box-shadow: 0 16px 44px rgba(24, 32, 25, .2); }
    summary { cursor: pointer; font-weight: 800; }
    .tree { display: grid; gap: 10px; margin-top: 12px; }
    section, .scenario { padding-left: 10px; border-left: 2px solid #d7d2c4; }
    h3, h4 { margin: 8px 0; font-size: 13px; }
    h4 { color: #697269; font: 700 11px/1.3 ui-monospace, monospace; }
    ul { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }
    li[data-mockcase-id] { padding: 8px; border: 1px solid #e1ddd2; border-radius: 9px; background: white; }
    label { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 8px; cursor: pointer; }
    label output { color: #697269; font: 700 10px/1 ui-monospace, monospace; text-transform: uppercase; }
    [data-mockcase-status="ready"] { border-color: #539321; }
    [data-mockcase-status="error"], [data-mockcase-status="conflict"] { border-color: #bc4439; }
    .effects { display: grid; gap: 2px; margin: 6px 0 0 26px; color: #697269; font: 10px/1.4 ui-monospace, monospace; }
    .effects li { overflow-wrap: anywhere; }
    .status { display: block; margin-top: 12px; color: #697269; font-size: 11px; }
    .actions { display: flex; gap: 8px; margin-top: 10px; }
    button { min-height: 34px; padding: 0 10px; border: 1px solid #182019; border-radius: 8px; color: inherit; background: #fffdf7; font: inherit; font-weight: 700; cursor: pointer; }
    .replace { margin: 8px 0 0 26px; border-color: #bc4439; }
    input:focus-visible, button:focus-visible, summary:focus-visible { outline: 3px solid #678e25; outline-offset: 2px; }
    .empty { color: #697269; }
    @media (max-width: 520px) { :host { right: 12px; bottom: 12px; } }
  `;
}

customElements.define('mockcase-switcher', MockcaseSwitcher);

declare global {
  interface HTMLElementTagNameMap {
    'mockcase-switcher': MockcaseSwitcher;
  }
}
