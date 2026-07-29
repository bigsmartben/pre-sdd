import { LitElement, css, html } from 'lit';

type RuntimeOperation =
  | { kind: 'property'; name: string; value: unknown }
  | { kind: 'attribute'; name: string; value: unknown; valueType?: string }
  | { kind: 'slot'; name: string; value: string; axisId: string }
  | { kind: 'workflow-state'; axisId: string; stateId: string; name?: string };

type RuntimeComponent = {
  pageInstanceId: string;
  componentContractId: string;
  stateMatrixEntryId: string;
  selector: string;
  operations: RuntimeOperation[];
};

type RuntimeCase = {
  id: string;
  name: string;
  viewModelId: string;
  routeId: string;
  routePath: string;
  viewportIds: string[];
  components: RuntimeComponent[];
};

type Runtime = {
  actor: string;
  cases: RuntimeCase[];
};

type ReviewHost = {
  apiVersion: 'psp.review-extension/v1';
  document: Document;
  location: Location;
  emit(type: string, detail: unknown): void;
};

type Baseline = {
  element: HTMLElement & Record<string, unknown>;
  properties: Map<string, unknown>;
  attributes: Map<string, { present: boolean; value: string | null }>;
  slots: Map<string, Node[]>;
};

declare const __PSP_UI_CASE_RUNTIME__: Runtime;

const runtime = __PSP_UI_CASE_RUNTIME__;
const baselines = new Map<string, Baseline>();
let activeCaseId: string | null = null;
let disposed = false;
let tool: UiCaseReviewView | null = null;
let routePath = '';
let routeTimer: number | null = null;
let routeWindow: Window | null = null;

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function cloneValue<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  return structuredClone(value);
}

function queryPublicElement(root: Document | ShadowRoot, selector: string): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(selector);
  if (direct) return direct;
  for (const element of root.querySelectorAll<HTMLElement>('*')) {
    if (!element.shadowRoot) continue;
    const nested = queryPublicElement(element.shadowRoot, selector);
    if (nested) return nested;
  }
  return null;
}

function currentCases(host: ReviewHost): RuntimeCase[] {
  return runtime.cases.filter((item) => item.routePath === host.location.pathname);
}

function targetElement(host: ReviewHost, component: RuntimeComponent): HTMLElement & Record<string, unknown> {
  const element = queryPublicElement(host.document, component.selector) as (HTMLElement & Record<string, unknown>) | null;
  if (!element) fail('AIH_UI_CASE_TARGET_MISSING', `正式组件实例不存在：${component.pageInstanceId}`);
  if (element.getAttribute('data-component-contract-id') !== component.componentContractId) {
    fail('AIH_UI_CASE_TARGET_MISSING', `正式组件实例的 Contract 身份不匹配：${component.pageInstanceId}`);
  }
  return element;
}

function directSlotNodes(element: HTMLElement, name: string): Node[] {
  return [...element.childNodes].filter((node) => (
    node instanceof HTMLElement && node.slot === name
  ));
}

function rememberBaseline(component: RuntimeComponent, element: HTMLElement & Record<string, unknown>): void {
  const previous = baselines.get(component.pageInstanceId);
  const baseline = previous?.element === element
    ? previous
    : {
        element,
        properties: new Map<string, unknown>(),
        attributes: new Map<string, { present: boolean; value: string | null }>(),
        slots: new Map<string, Node[]>(),
      };
  for (const operation of component.operations) {
    if ((operation.kind === 'property' || (operation.kind === 'workflow-state' && operation.name))
      && !baseline.properties.has(operation.name!)) {
      baseline.properties.set(operation.name!, cloneValue(element[operation.name!]));
    }
    if (operation.kind === 'attribute' && !baseline.attributes.has(operation.name)) {
      baseline.attributes.set(operation.name, {
        present: element.hasAttribute(operation.name),
        value: element.getAttribute(operation.name),
      });
    }
    if (operation.kind === 'slot' && !baseline.slots.has(operation.name)) {
      baseline.slots.set(operation.name, directSlotNodes(element, operation.name).map((node) => node.cloneNode(true)));
    }
  }
  baselines.set(component.pageInstanceId, baseline);
}

async function settle(element: HTMLElement & Record<string, unknown>): Promise<void> {
  const updateComplete = element.updateComplete;
  if (updateComplete && typeof (updateComplete as Promise<unknown>).then === 'function') {
    await updateComplete;
  } else {
    await Promise.resolve();
  }
  const targetWindow = element.ownerDocument.defaultView;
  if (!targetWindow) return;
  await new Promise<void>((resolveReady) => targetWindow.requestAnimationFrame(() => (
    targetWindow.requestAnimationFrame(() => resolveReady())
  )));
}

async function restoreBaseline(instanceId: string): Promise<void> {
  const baseline = baselines.get(instanceId);
  if (!baseline) return;
  for (const [name, value] of baseline.properties) baseline.element[name] = cloneValue(value);
  for (const [name, value] of baseline.attributes) {
    if (value.present) baseline.element.setAttribute(name, value.value ?? '');
    else baseline.element.removeAttribute(name);
  }
  for (const [name, nodes] of baseline.slots) {
    for (const node of directSlotNodes(baseline.element, name)) node.remove();
    baseline.element.append(...nodes.map((node) => node.cloneNode(true)));
  }
  baseline.element.removeAttribute('data-ui-case-state-matrix-entry');
  await settle(baseline.element);
}

async function restoreAll(): Promise<void> {
  for (const instanceId of [...baselines.keys()].reverse()) await restoreBaseline(instanceId);
  activeCaseId = null;
}

function observedStateIds(element: HTMLElement): Set<string> {
  const values = new Set<string>();
  const visit = (root: HTMLElement | ShadowRoot): void => {
    if (root instanceof HTMLElement) {
      const stateId = root.getAttribute('data-state-id');
      if (stateId) values.add(stateId);
      for (const value of (root.getAttribute('data-component-state') || '').split(/\s+/)) {
        if (value) values.add(value);
      }
      if (root.shadowRoot) visit(root.shadowRoot);
    }
    for (const item of root.querySelectorAll<HTMLElement>('[data-state-id],[data-component-state]')) {
      const stateId = item.getAttribute('data-state-id');
      if (stateId) values.add(stateId);
      for (const value of (item.getAttribute('data-component-state') || '').split(/\s+/)) {
        if (value) values.add(value);
      }
      if (item.shadowRoot) visit(item.shadowRoot);
    }
  };
  visit(element);
  return values;
}

async function waitForState(element: HTMLElement, stateId: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (observedStateIds(element).has(stateId)) return;
    await new Promise((resolveReady) => setTimeout(resolveReady, 25));
  }
  fail('AIH_UI_CASE_TIMEOUT', `正式组件未呈现 State Matrix 声明的状态：${stateId}`);
}

function applyAttribute(element: HTMLElement, operation: Extract<RuntimeOperation, { kind: 'attribute' }>): void {
  if (operation.valueType === 'boolean') {
    if (operation.value === true) element.setAttribute(operation.name, '');
    else element.removeAttribute(operation.name);
    return;
  }
  const value = typeof operation.value === 'string'
    ? operation.value
    : JSON.stringify(operation.value);
  element.setAttribute(operation.name, value ?? 'null');
}

async function applyCase(host: ReviewHost, caseId: string): Promise<{ activeCaseId: string }> {
  if (disposed) fail('AIH_UI_CASE_PLUGIN_FAILED', 'UI Case Mock Extension 已释放。');
  const selected = currentCases(host).find((item) => item.id === caseId);
  if (!selected) fail('AIH_UI_CASE_CONTRACT_INVALID', `包含未知或跨 Route UI Case：${caseId}`);
  try {
    await restoreAll();
    for (const component of selected.components) {
      const element = targetElement(host, component);
      rememberBaseline(component, element);
      for (const operation of component.operations) {
        if (operation.kind === 'property') element[operation.name] = cloneValue(operation.value);
        else if (operation.kind === 'attribute') applyAttribute(element, operation);
        else if (operation.kind === 'slot') {
          for (const node of directSlotNodes(element, operation.name)) node.remove();
          const slot = host.document.createElement('span');
          slot.slot = operation.name;
          slot.textContent = operation.value;
          slot.setAttribute('data-ui-case-axis-id', operation.axisId);
          element.append(slot);
        } else if (operation.kind === 'workflow-state' && operation.name) {
          element[operation.name] = operation.stateId;
        }
      }
      element.setAttribute('data-ui-case-state-matrix-entry', component.stateMatrixEntryId);
      await settle(element);
      for (const operation of component.operations) {
        if (operation.kind === 'workflow-state') await waitForState(element, operation.stateId);
        if (operation.kind === 'property' && String(operation.value).startsWith('COMPONENT-STATE-')) {
          await waitForState(element, String(operation.value));
        }
      }
    }
    activeCaseId = selected.id;
    tool?.setActive(selected.id, null);
    host.emit('psp:ui-case-applied', {
      uiCaseId: selected.id,
      viewModelId: selected.viewModelId,
      routeId: selected.routeId,
    });
    return { activeCaseId: selected.id };
  } catch (error) {
    try {
      await restoreAll();
    } catch {
      fail('AIH_UI_CASE_ROLLBACK_FAILED', 'UI Case 投影失败后未能完整回滚。');
    }
    tool?.setActive(null, error instanceof Error ? error.message : 'UI Case 投影失败');
    throw error;
  }
}

class UiCaseReviewView extends LitElement {
  static properties = {
    cases: { attribute: false },
    active: { type: String, reflect: true },
    error: { type: String },
  };

  declare cases: RuntimeCase[];
  declare active: string;
  declare error: string;
  onApply: ((id: string) => void) | null = null;
  onComplete: (() => void) | null = null;
  onCancel: (() => void) | null = null;

  constructor() {
    super();
    this.cases = [];
    this.active = '';
    this.error = '';
  }

  setActive(id: string | null, error: string | null): void {
    this.active = id || '';
    this.error = error || '';
  }

  protected render() {
    return html`
      <aside aria-label="UI Case Mock">
        <header><small>REVIEW TOOL</small><strong>UI Case Mock</strong></header>
        <div class="cases">
          ${this.cases.map((item) => html`
            <button
              type="button"
              data-ui-case-id=${item.id}
              aria-pressed=${String(this.active === item.id)}
              @click=${() => this.onApply?.(item.id)}
            >${item.name}<small>${item.id}</small></button>
          `)}
        </div>
        ${this.error ? html`<p role="alert">${this.error}</p>` : ''}
        <footer>
          <button type="button" @click=${() => this.onCancel?.()}>取消</button>
          <button type="button" ?disabled=${!this.active} @click=${() => this.onComplete?.()}>结束评审</button>
        </footer>
      </aside>
    `;
  }

  static styles = css`
    :host { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; width: min(360px, calc(100vw - 32px)); font: 13px/1.4 system-ui, sans-serif; color: #172016; }
    aside { overflow: hidden; border: 1px solid #79806f; border-radius: 12px; background: #fffef8; box-shadow: 0 16px 48px #0003; }
    header, footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px; }
    header small, button small { display: block; color: #66705e; font-size: 10px; letter-spacing: .08em; }
    .cases { display: grid; gap: 6px; max-height: 42vh; overflow: auto; padding: 0 12px 12px; }
    button { cursor: pointer; border: 1px solid #c8cdbf; border-radius: 8px; padding: 8px 10px; background: white; color: inherit; text-align: left; }
    button[aria-pressed="true"] { border-color: #405d13; background: #edf7d6; }
    footer { border-top: 1px solid #dfe3d8; }
    footer button:last-child { background: #405d13; color: white; }
    p { margin: 0 12px 12px; color: #8b1f1f; }
  `;
}

if (!customElements.get('psp-ui-case-review')) customElements.define('psp-ui-case-review', UiCaseReviewView);

export const extension = {
  async activate(host: ReviewHost) {
    if (host.apiVersion !== 'psp.review-extension/v1') fail('AIH_UI_CASE_PLUGIN_FAILED', 'Review Host API 不兼容。');
    if (disposed) fail('AIH_UI_CASE_PLUGIN_FAILED', 'UI Case Mock Extension 不得重复激活。');
    routePath = host.location.pathname;
    tool = host.document.createElement('psp-ui-case-review') as UiCaseReviewView;
    tool.setAttribute('data-review-tool', 'ui-case-mock');
    tool.cases = currentCases(host);
    tool.onApply = (id) => { void applyCase(host, id); };
    tool.onComplete = () => host.emit('psp:ui-case-review-complete', {
      routePath: host.location.pathname,
      uiCaseId: activeCaseId,
    });
    tool.onCancel = () => host.emit('psp:ui-case-review-cancel', { routePath: host.location.pathname });
    host.document.body.append(tool);

    routeWindow = host.document.defaultView;
    if (routeWindow) {
      routeTimer = routeWindow.setInterval(() => {
        if (routePath === host.location.pathname) return;
        void restoreAll().finally(() => {
          baselines.clear();
          routePath = host.location.pathname;
          if (tool) {
            tool.cases = currentCases(host);
            tool.setActive(null, null);
          }
        });
      }, 100);
    }

    const api = Object.freeze({
      get caseIds() { return currentCases(host).map((item) => item.id); },
      apply: (id: string | readonly string[]) => {
        const ids = typeof id === 'string' ? [id] : [...id];
        if (ids.length !== 1) fail('AIH_UI_CASE_PROJECTION_CONFLICT', '每次只能投影一个 UI Case。');
        return applyCase(host, ids[0]);
      },
      dispose: async () => {
        await restoreAll();
        baselines.clear();
        if (routeWindow && routeTimer !== null) routeWindow.clearInterval(routeTimer);
        routeTimer = null;
        routeWindow = null;
        tool?.remove();
        tool = null;
        disposed = true;
        delete globalThis.__pspUiCaseRuntimeApi;
      },
    });
    Object.defineProperty(globalThis, '__pspUiCaseRuntimeApi', {
      value: api,
      configurable: true,
      writable: false,
    });
    return { dispose: () => { void api.dispose(); } };
  },
};

export default extension;

declare global {
  var __pspUiCaseRuntimeApi: {
    readonly caseIds: string[];
    apply(id: string | readonly string[]): Promise<{ activeCaseId: string }>;
    dispose(): Promise<void>;
  } | undefined;
}
