import { LitElement, css, html } from 'lit';
import { selectMatchingBehavior } from './matcher.mjs';

type ProjectionSource =
  | { kind: 'state-matrix'; axisId: string; valueId: string }
  | { kind: 'fixture'; behaviorId: string; fixtureId: string; sourcePointer: string };

type RuntimeEffect = {
  targetInstanceId: string;
  componentContractId: string;
  stateMatrixEntryId: string;
  behaviorIds: string[];
  activation: {
    kind: 'request' | 'control-event' | 'input';
    controlId?: string;
    value?: string;
  };
  assignments: Array<{
    propertyName: string;
    value: unknown;
    sources: ProjectionSource[];
  }>;
  expectedStateIds: string[];
};

type RuntimeCase = {
  id: string;
  kind: 'business' | 'technical';
  label: string;
  routeId: string;
  scenarioId?: string;
  effects: RuntimeEffect[];
  isDefault: boolean;
  projectionDigest: string;
};

type Runtime = {
  actor: string;
  sourceDigests: { suite: string };
  routes: Array<{ id: string; path: string }>;
  fixtures: Array<{ id: string; payload: unknown }>;
  behaviors: Array<{
    id: string;
    request: {
      method: string;
      path: string;
      query?: Record<string, string>;
      headers?: Record<string, string>;
    };
    response: {
      fixtureId: string;
      status: number;
      headers?: Record<string, string>;
      delayMs?: number;
    };
  }>;
  cases: RuntimeCase[];
};

type ReviewHost = {
  apiVersion: 'psp.review-extension/v1';
  document: Document;
  location: Location;
  emit(type: string, detail: unknown): void;
};

type ReviewViewError = {
  code: string;
  message: string;
};

type CompletedRoute = {
  routeId: string;
  caseProjections: Array<{ caseId: string; projectionDigest: string }>;
  applyStatus: 'PASS';
  rollbackStatus: 'PASS';
};

type Baseline = {
  element: HTMLElement & Record<string, unknown>;
  values: Map<string, unknown>;
};

type ControlSnapshot = {
  element: HTMLElement;
  value?: string;
  textContent: string | null;
};

declare const __PSP_MOCKCASE_RUNTIME__: Runtime;

const REVIEW_VIEW_TAG = 'psp-mockcase-review';
const runtime = __PSP_MOCKCASE_RUNTIME__;
const sessionKey = `psp.mockcase.review.${runtime.actor}.${runtime.sourceDigests.suite}`;
let activeCaseIds: string[] = [];
let disposed = false;
let tool: MockcaseReviewView | null = null;
let extensionReady = false;
let pendingApplication: Promise<void> | null = null;
let lastApplicationError: ReviewViewError | null = null;
let currentRoutePath = '';
let routePollTimer: number | null = null;
let routeFrame: number | null = null;
let routeWindow: Window | null = null;
let routeNavigationListener: (() => void) | null = null;
const baselines = new Map<string, Baseline>();
const controlBaselines = new Map<HTMLElement, ControlSnapshot>();
let activeBehaviorIds = new Set<string>();
let originalFetch: typeof globalThis.fetch | null = null;
const reviewedCaseProjections = new Map<string, string>();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function errorDetail(error: unknown): ReviewViewError {
  return {
    code: error instanceof Error && 'code' in error
      ? String(error.code)
      : 'AIH_MOCKCASE_PLUGIN_FAILED',
    message: error instanceof Error ? error.message : 'MockCase 投影失败',
  };
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
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

function currentRoute(host: ReviewHost) {
  return runtime.routes.find((item) => item.path === host.location.pathname) ?? null;
}

function currentCases(host: ReviewHost): RuntimeCase[] {
  const routeId = currentRoute(host)?.id;
  return runtime.cases.filter((item) => item.routeId === routeId);
}

function matchingBehavior(input: RequestInfo | URL, init?: RequestInit): Runtime['behaviors'][number] | null {
  return selectMatchingBehavior(
    runtime.behaviors,
    activeBehaviorIds,
    input,
    init,
    globalThis.location.href,
  );
}

function responseFor(behavior: Runtime['behaviors'][number]): Response {
  const fixture = runtime.fixtures.find((item) => item.id === behavior.response.fixtureId);
  if (!fixture) fail('AIH_MOCKCASE_CONTRACT_INVALID', `Fixture 不存在：${behavior.response.fixtureId}`);
  return new Response(JSON.stringify(fixture.payload), {
    status: behavior.response.status,
    headers: { 'content-type': 'application/json', ...(behavior.response.headers ?? {}) },
  });
}

async function interceptedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const behavior = matchingBehavior(input, init);
  if (!behavior) {
    if (!originalFetch) fail('AIH_MOCKCASE_PLUGIN_FAILED', '原始 Fetch 未初始化。');
    return originalFetch(input, init);
  }
  if (behavior.response.delayMs) {
    await new Promise((resolve) => setTimeout(resolve, behavior.response.delayMs));
  }
  return responseFor(behavior);
}

function routeHref(host: ReviewHost, path: string): string {
  const url = new URL(path, host.location.href);
  url.searchParams.set('review', '1');
  return url.href;
}

function readCompletedRoutes(host: ReviewHost): CompletedRoute[] {
  try {
    const text = host.document.defaultView?.sessionStorage.getItem(sessionKey);
    if (!text) return [];
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) =>
      item
      && typeof item.routeId === 'string'
      && Array.isArray(item.caseProjections)
      && item.applyStatus === 'PASS'
      && item.rollbackStatus === 'PASS');
  } catch {
    return [];
  }
}

function writeCompletedRoutes(host: ReviewHost, routes: CompletedRoute[]): void {
  host.document.defaultView?.sessionStorage.setItem(sessionKey, JSON.stringify(routes));
}

function clearCompletedRoutes(host: ReviewHost): void {
  host.document.defaultView?.sessionStorage.removeItem(sessionKey);
}

function targetElement(host: ReviewHost, effect: RuntimeEffect): HTMLElement & Record<string, unknown> {
  const selector = `[data-component-instance-id="${CSS.escape(effect.targetInstanceId)}"]`;
  const element = queryPublicElement(host.document, selector) as (HTMLElement & Record<string, unknown>) | null;
  if (!element) fail('AIH_MOCKCASE_TARGET_MISSING', `组件实例不存在：${effect.targetInstanceId}`);
  if (element.getAttribute('data-component-contract-id') !== effect.componentContractId) {
    fail('AIH_MOCKCASE_TARGET_MISSING', `组件实例的公开 Contract 身份不匹配：${effect.targetInstanceId}`);
  }
  return element;
}

function activationControl(host: ReviewHost, effect: RuntimeEffect): HTMLElement | null {
  if (!effect.activation.controlId) return null;
  const selector = `[data-control-id="${CSS.escape(effect.activation.controlId)}"]`;
  const target = targetElement(host, effect);
  const control = target.querySelector<HTMLElement>(selector)
    ?? (target.shadowRoot ? queryPublicElement(target.shadowRoot, selector) : null)
    ?? queryPublicElement(host.document, selector);
  if (!control) fail('AIH_MOCKCASE_TARGET_MISSING', `Control 不存在：${effect.activation.controlId}`);
  return control;
}

function snapshotControl(element: HTMLElement): ControlSnapshot {
  const value = element instanceof HTMLInputElement
    || element instanceof HTMLSelectElement
    || element instanceof HTMLTextAreaElement
    ? element.value
    : undefined;
  return { element, ...(value === undefined ? {} : { value }), textContent: element.textContent };
}

function rememberControlBaseline(element: HTMLElement): void {
  if (!controlBaselines.has(element)) controlBaselines.set(element, snapshotControl(element));
}

function restoreControl(snapshot: ControlSnapshot): void {
  if (
    snapshot.value !== undefined
    && (
      snapshot.element instanceof HTMLInputElement
      || snapshot.element instanceof HTMLSelectElement
      || snapshot.element instanceof HTMLTextAreaElement
    )
  ) {
    snapshot.element.value = snapshot.value;
  } else {
    snapshot.element.textContent = snapshot.textContent;
  }
}

function restoreControlBaselines(): void {
  for (const snapshot of [...controlBaselines.values()].reverse()) restoreControl(snapshot);
}

function rememberBaseline(effect: RuntimeEffect, element: HTMLElement & Record<string, unknown>): void {
  const previous = baselines.get(effect.targetInstanceId);
  if (previous?.element === element) {
    for (const assignment of effect.assignments) {
      if (!previous.values.has(assignment.propertyName)) {
        previous.values.set(assignment.propertyName, cloneValue(element[assignment.propertyName]));
      }
    }
    return;
  }
  baselines.set(effect.targetInstanceId, {
    element,
    values: new Map(effect.assignments.map((assignment) => [
      assignment.propertyName,
      cloneValue(element[assignment.propertyName]),
    ])),
  });
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
  await new Promise<void>((resolve) => targetWindow.requestAnimationFrame(() =>
    targetWindow.requestAnimationFrame(() => resolve())));
}

async function restoreBaseline(targetInstanceId: string): Promise<void> {
  const baseline = baselines.get(targetInstanceId);
  if (!baseline) return;
  for (const [propertyName, value] of baseline.values) {
    baseline.element[propertyName] = cloneValue(value);
  }
  await settle(baseline.element);
}

async function activateEffect(host: ReviewHost, effect: RuntimeEffect): Promise<void> {
  const target = targetElement(host, effect);
  const control = activationControl(host, effect);
  if (control) rememberControlBaseline(control);
  if (effect.activation.kind === 'request') {
    for (const behaviorId of effect.behaviorIds) {
      const behavior = runtime.behaviors.find((item) => item.id === behaviorId);
      if (!behavior) fail('AIH_MOCKCASE_CONTRACT_INVALID', `Behavior 不存在：${behaviorId}`);
      const requestUrl = new URL(behavior.request.path, globalThis.location.origin);
      for (const [key, value] of Object.entries(behavior.request.query ?? {})) {
        requestUrl.searchParams.set(key, value);
      }
      const response = await globalThis.fetch(requestUrl, {
        method: behavior.request.method,
        headers: behavior.request.headers,
      });
      target.dispatchEvent(new CustomEvent('psp:review-network-response', {
        bubbles: true,
        composed: true,
        detail: { response: response.clone(), behaviorId },
      }));
    }
  } else if (effect.activation.kind === 'input') {
    if (
      control instanceof HTMLInputElement
      || control instanceof HTMLSelectElement
      || control instanceof HTMLTextAreaElement
    ) {
      control.value = effect.activation.value ?? '';
    } else if (control) {
      control.textContent = effect.activation.value ?? '';
    }
    control?.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    control?.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else {
    control?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
  }
}

function observedStateIds(element: HTMLElement): Set<string> {
  const values = new Set<string>();
  const visit = (root: HTMLElement | ShadowRoot): void => {
    if (root instanceof HTMLElement) {
      const stateId = root.getAttribute('data-state-id');
      if (stateId) values.add(stateId);
      for (const value of (root.getAttribute('data-component-state') ?? '').split(/\s+/)) {
        if (value) values.add(value);
      }
      if (root.shadowRoot) visit(root.shadowRoot);
    }
    for (const item of root.querySelectorAll<HTMLElement>('[data-state-id],[data-component-state]')) {
      const stateId = item.getAttribute('data-state-id');
      if (stateId) values.add(stateId);
      for (const value of (item.getAttribute('data-component-state') ?? '').split(/\s+/)) {
        if (value) values.add(value);
      }
      if (item.shadowRoot) visit(item.shadowRoot);
    }
  };
  visit(element);
  return values;
}

async function verifyExpectedStates(element: HTMLElement, expectedStateIds: string[]): Promise<void> {
  const expected = [...new Set(expectedStateIds)];
  if (expected.length === 0) return;
  const matches = () => {
    const observed = observedStateIds(element);
    return expected.every((id) => observed.has(id));
  };
  if (matches()) return;
  await new Promise<void>((resolve, reject) => {
    const observer = new MutationObserver(() => {
      if (!matches()) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(Object.assign(new Error(
        `Lit 投影未呈现预期状态：expected=${expected.join(',')}；`
        + `observed=${[...observedStateIds(element)].join(',')}`,
      ), { code: 'AIH_MOCKCASE_TIMEOUT' }));
    }, 4000);
    observer.observe(element, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-state-id', 'data-component-state'],
    });
    if (element.shadowRoot) {
      observer.observe(element.shadowRoot, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-state-id', 'data-component-state'],
      });
    }
  });
}

function selectedCases(host: ReviewHost, ids: readonly string[]): RuntimeCase[] {
  const available = currentCases(host);
  const selected = [...new Set(ids)].sort().map((id) => available.find((item) => item.id === id));
  if (selected.some((item) => !item)) fail('AIH_MOCKCASE_CONTRACT_INVALID', '包含未知或跨 Route 的 Case。');
  return selected as RuntimeCase[];
}

function assertNoConflict(cases: RuntimeCase[]): void {
  const values = new Map<string, string>();
  const requestMatchers = new Map<string, string>();
  for (const item of cases) {
    for (const effect of item.effects) {
      for (const assignment of effect.assignments) {
        const key = `${effect.targetInstanceId}/${assignment.propertyName}`;
        const value = JSON.stringify(assignment.value);
        const previous = values.get(key);
        if (previous !== undefined && previous !== value) {
          fail('AIH_MOCKCASE_PROJECTION_CONFLICT', `Case 公开属性投影冲突：${key}`);
        }
        values.set(key, value);
      }
      for (const behaviorId of effect.behaviorIds) {
        const behavior = runtime.behaviors.find((entry) => entry.id === behaviorId);
        if (!behavior) fail('AIH_MOCKCASE_CONTRACT_INVALID', `Behavior 不存在：${behaviorId}`);
        const matcher = JSON.stringify([
          behavior.request.method,
          behavior.request.path,
          Object.entries(behavior.request.query ?? {}).sort(),
          Object.entries(behavior.request.headers ?? {}).sort(),
        ]);
        const previous = requestMatchers.get(matcher);
        if (previous && previous !== behaviorId) {
          fail('AIH_MOCKCASE_CONFLICT', `Behavior Request Matcher 冲突：${previous} / ${behaviorId}`);
        }
        requestMatchers.set(matcher, behaviorId);
      }
    }
  }
}

async function apply(host: ReviewHost, ids: readonly string[]) {
  if (disposed) fail('AIH_MOCKCASE_PLUGIN_FAILED', 'Extension 已释放。');
  const previousCaseIds = [...activeCaseIds];
  const previousBehaviorIds = new Set(activeBehaviorIds);
  const propertySnapshots = new Map<string, Baseline>();
  const controlSnapshots = new Map<HTMLElement, ControlSnapshot>();
  try {
    const cases = selectedCases(host, ids);
    assertNoConflict(cases);
    const previousCases = selectedCases(host, previousCaseIds);
    for (const item of [...previousCases, ...cases]) {
      for (const effect of item.effects) {
        const element = targetElement(host, effect);
        const transaction = propertySnapshots.get(effect.targetInstanceId) ?? {
          element,
          values: new Map<string, unknown>(),
        };
        for (const assignment of effect.assignments) {
          if (!transaction.values.has(assignment.propertyName)) {
            transaction.values.set(assignment.propertyName, cloneValue(element[assignment.propertyName]));
          }
        }
        propertySnapshots.set(effect.targetInstanceId, transaction);
        const control = activationControl(host, effect);
        if (control && !controlSnapshots.has(control)) controlSnapshots.set(control, snapshotControl(control));
        rememberBaseline(effect, element);
      }
    }
    for (const targetInstanceId of new Set(previousCases.flatMap((item) =>
      item.effects.map((effect) => effect.targetInstanceId)))) {
      await restoreBaseline(targetInstanceId);
    }
    restoreControlBaselines();
    activeBehaviorIds = new Set(cases.flatMap((item) =>
      item.effects.flatMap((effect) => effect.behaviorIds)));
    for (const item of cases) {
      for (const effect of item.effects) {
        const element = targetElement(host, effect);
        for (const assignment of effect.assignments) {
          element[assignment.propertyName] = cloneValue(assignment.value);
        }
        await settle(element);
        await activateEffect(host, effect);
        await settle(element);
        await verifyExpectedStates(element, effect.expectedStateIds);
      }
    }
    activeCaseIds = cases.map((item) => item.id);
    for (const item of cases) reviewedCaseProjections.set(item.id, item.projectionDigest);
    host.emit('psp:mockcase-ready', {
      actor: runtime.actor,
      routeId: currentRoute(host)?.id ?? null,
      caseProjections: cases.map((item) => ({
        caseId: item.id,
        projectionDigest: item.projectionDigest,
      })),
    });
    updateReviewView(host);
    return { activeCaseIds: [...activeCaseIds] };
  } catch (error) {
    activeBehaviorIds = previousBehaviorIds;
    activeCaseIds = previousCaseIds;
    try {
      for (const snapshot of [...controlSnapshots.values()].reverse()) restoreControl(snapshot);
      for (const snapshot of [...propertySnapshots.values()].reverse()) {
        for (const [propertyName, value] of snapshot.values) {
          snapshot.element[propertyName] = cloneValue(value);
        }
        await settle(snapshot.element);
      }
    } catch {
      fail('AIH_MOCKCASE_ROLLBACK_FAILED', '失败事务未能恢复组件属性、输入内容或原激活集合。');
    }
    host.emit('psp:mockcase-error', errorDetail(error));
    throw error;
  }
}

function canCompleteRoute(host: ReviewHost): boolean {
  const availableIds = new Set(currentCases(host).map((item) => item.id));
  return extensionReady
    && pendingApplication === null
    && lastApplicationError === null
    && availableIds.size > 0
    && [...availableIds].every((id) => reviewedCaseProjections.has(id));
}

function updateReviewView(host: ReviewHost): void {
  if (!tool) return;
  const currentIds = new Set(currentCases(host).map((item) => item.id));
  tool.routes = runtime.routes.map((route) => ({
    ...route,
    href: routeHref(host, route.path),
    cases: runtime.cases.filter((item) => item.routeId === route.id),
  }));
  tool.activeCaseIds = activeCaseIds.filter((id) => currentIds.has(id));
  tool.completedRouteIds = readCompletedRoutes(host).map((item) => item.routeId);
  tool.routePath = host.location.pathname;
  tool.ready = extensionReady;
  tool.busy = pendingApplication !== null;
  tool.error = lastApplicationError;
  tool.setAttribute('data-active-case-ids', tool.activeCaseIds.join(','));
}

function runApplication(host: ReviewHost, ids: readonly string[]): void {
  if (!extensionReady || pendingApplication) return;
  lastApplicationError = null;
  let operation: Promise<void>;
  operation = apply(host, ids)
    .then(() => {
      lastApplicationError = null;
    })
    .catch((error: unknown) => {
      lastApplicationError = errorDetail(error);
    })
    .finally(() => {
      if (pendingApplication === operation) pendingApplication = null;
      updateReviewView(host);
    });
  pendingApplication = operation;
  updateReviewView(host);
}

async function resetRouteState(clearReviewProgress = true): Promise<void> {
  try {
    for (const targetInstanceId of [...baselines.keys()].reverse()) {
      await restoreBaseline(targetInstanceId);
    }
    restoreControlBaselines();
  } catch {
    fail('AIH_MOCKCASE_ROLLBACK_FAILED', '未能恢复组件属性、Input/Select/Textarea value 或 textContent。');
  }
  baselines.clear();
  controlBaselines.clear();
  activeBehaviorIds = new Set();
  activeCaseIds = [];
  if (clearReviewProgress) reviewedCaseProjections.clear();
  lastApplicationError = null;
}

async function synchronizeRoute(host: ReviewHost): Promise<void> {
  if (disposed || host.location.pathname === currentRoutePath || pendingApplication) return;
  await resetRouteState();
  currentRoutePath = host.location.pathname;
  updateReviewView(host);
  const defaults = currentCases(host).filter((item) => item.isDefault).map((item) => item.id);
  if (defaults.length > 0) runApplication(host, defaults);
}

function scheduleRouteSynchronization(host: ReviewHost): void {
  if (disposed || host.location.pathname === currentRoutePath || routeFrame !== null) return;
  const targetWindow = host.document.defaultView;
  if (!targetWindow) return;
  routeFrame = targetWindow.requestAnimationFrame(() => {
    routeFrame = targetWindow.requestAnimationFrame(() => {
      routeFrame = null;
      void synchronizeRoute(host);
    });
  });
}

function startRouteObservation(host: ReviewHost): void {
  const targetWindow = host.document.defaultView;
  if (!targetWindow) return;
  routeWindow = targetWindow;
  routeNavigationListener = () => scheduleRouteSynchronization(host);
  targetWindow.addEventListener('popstate', routeNavigationListener);
  targetWindow.addEventListener('hashchange', routeNavigationListener);
  routePollTimer = targetWindow.setInterval(() => scheduleRouteSynchronization(host), 100);
}

function stopRouteObservation(): void {
  if (routeWindow && routeNavigationListener) {
    routeWindow.removeEventListener('popstate', routeNavigationListener);
    routeWindow.removeEventListener('hashchange', routeNavigationListener);
  }
  if (routeWindow && routePollTimer !== null) routeWindow.clearInterval(routePollTimer);
  if (routeWindow && routeFrame !== null) routeWindow.cancelAnimationFrame(routeFrame);
  routeWindow = null;
  routeNavigationListener = null;
  routePollTimer = null;
  routeFrame = null;
}

class MockcaseReviewView extends LitElement {
  static properties = {
    routes: { attribute: false },
    activeCaseIds: { attribute: false },
    completedRouteIds: { attribute: false },
    routePath: { type: String, attribute: 'route-path', reflect: true },
    ready: { type: Boolean, reflect: true },
    busy: { type: Boolean, reflect: true },
    error: { attribute: false },
  };

  declare routes: Array<Runtime['routes'][number] & { href: string; cases: RuntimeCase[] }>;
  declare activeCaseIds: string[];
  declare completedRouteIds: string[];
  declare routePath: string;
  declare ready: boolean;
  declare busy: boolean;
  declare error: ReviewViewError | null;

  onApply: ((ids: readonly string[]) => void) | null = null;
  onComplete: (() => void) | null = null;
  onCancel: (() => void) | null = null;

  constructor() {
    super();
    this.routes = [];
    this.activeCaseIds = [];
    this.completedRouteIds = [];
    this.routePath = '/';
    this.ready = false;
    this.busy = false;
    this.error = null;
  }

  private get completeDisabled(): boolean {
    return !this.ready || this.busy || this.error !== null || this.activeCaseIds.length === 0;
  }

  private statusTemplate() {
    if (this.error) {
      return html`<p class="status error" role="alert"><strong>${this.error.code}</strong><span>${this.error.message}</span></p>`;
    }
    if (!this.ready) return html`<p class="status" aria-live="polite">正在加载 MockCase…</p>`;
    if (this.busy) return html`<p class="status" aria-live="polite">正在应用 DataModel 投影…</p>`;
    const route = this.routes.find((item) => item.path === this.routePath);
    if (!route || route.cases.length === 0) {
      return html`<p class="status warning" aria-live="polite">当前路由没有可评审的 MockCase。</p>`;
    }
    return this.activeCaseIds.length > 0
      ? html`<p class="status success" aria-live="polite">公开属性已投影，Lit 已完成渲染。</p>`
      : html`<p class="status" aria-live="polite">请选择一个 MockCase。</p>`;
  }

  protected render() {
    const activeIds = new Set(this.activeCaseIds);
    const completedIds = new Set(this.completedRouteIds);
    return html`
      <aside class="panel" aria-label="MockCase Review Extension" aria-busy=${String(this.busy)}>
        <header>
          <div><p class="eyebrow">REVIEW EXTENSION</p><h2>MockCase</h2></div>
          <code title=${this.routePath}>${this.routePath}</code>
        </header>
        <nav class="routes" aria-label="MockCase Routes">
          ${this.routes.map((route) => html`
            <section class=${route.path === this.routePath ? 'route current' : 'route'}>
              <a href=${route.href} data-route-id=${route.id}>
                <span>${route.path}</span>
                ${completedIds.has(route.id) ? html`<small>DONE</small>` : ''}
              </a>
              ${route.path === this.routePath ? html`
                <div class="cases" role="group" aria-label="当前路由的 MockCase">
                  ${route.cases.map((item) => html`
                    <button
                      class=${activeIds.has(item.id) ? 'case active' : 'case'}
                      type="button"
                      data-case-id=${item.id}
                      aria-pressed=${String(activeIds.has(item.id))}
                      ?disabled=${this.busy || !this.ready}
                      @click=${() => this.onApply?.([item.id])}
                    >
                      <span>${item.label}</span>${item.isDefault ? html`<small>DEFAULT</small>` : ''}
                    </button>
                  `)}
                </div>
              ` : ''}
            </section>
          `)}
        </nav>
        ${this.statusTemplate()}
        <div class="actions">
          <button class="secondary" type="button" data-review-action="cancel" ?disabled=${this.busy || !this.ready} @click=${() => this.onCancel?.()}>取消</button>
          <button class="primary" type="button" data-review-action="complete" ?disabled=${this.completeDisabled} @click=${() => this.onComplete?.()}>完成当前路由</button>
        </div>
      </aside>
    `;
  }

  static styles = css`
    :host {
      all: initial;
      position: fixed;
      right: 12px;
      bottom: 12px;
      z-index: 2147483647;
      display: block;
      width: min(380px, calc(100vw - 24px));
      max-height: calc(100vh - 24px);
      contain: layout style paint;
      isolation: isolate;
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    .panel {
      max-height: calc(100vh - 24px);
      overflow: auto;
      padding: 14px;
      border: 1px solid #d9dde5;
      border-radius: 16px;
      color: #1f2430;
      background: rgba(255, 255, 255, .98);
      box-shadow: 0 18px 60px rgba(20, 24, 32, .24);
      font-size: 13px;
      line-height: 1.45;
    }
    header, .route > a, .case, .actions { display: flex; align-items: center; }
    header { justify-content: space-between; gap: 12px; margin-bottom: 12px; }
    .eyebrow { margin: 0 0 2px; color: #697386; font-size: 10px; font-weight: 800; letter-spacing: .1em; }
    h2 { margin: 0; font-size: 18px; }
    code { max-width: 46%; overflow: hidden; padding: 4px 7px; border-radius: 999px; background: #f1f3f7; font: 600 10px/1.3 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .routes, .cases { display: grid; gap: 7px; }
    .route { border: 1px solid #e1e5ec; border-radius: 11px; overflow: hidden; }
    .route.current { border-color: #9cb8ef; }
    .route > a { justify-content: space-between; padding: 8px 10px; color: #303746; background: #f6f7f9; font-weight: 750; text-decoration: none; }
    .cases { padding: 8px; }
    button { min-height: 38px; border: 1px solid transparent; border-radius: 10px; font: inherit; font-weight: 700; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .48; }
    .case { justify-content: space-between; gap: 10px; width: 100%; padding: 8px 10px; color: #303746; background: #fff; text-align: left; }
    .case.active { border-color: #3269d8; color: #174aa9; background: #eaf1ff; }
    small { color: #697386; font-size: 9px; letter-spacing: .06em; }
    .status { display: grid; gap: 3px; min-height: 20px; margin: 11px 0; color: #5f697b; font-size: 11px; }
    .status.error { padding: 8px 9px; border-radius: 9px; color: #9b1c1c; background: #fff0f0; }
    .status.warning { color: #8a5400; }
    .status.success { color: #24613b; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .secondary { border-color: #d8dde6; color: #414a5b; background: #fff; }
    .primary { color: #fff; background: #245fce; }
    @media (max-width: 480px) {
      :host { right: 8px; bottom: 8px; width: calc(100vw - 16px); }
    }
  `;
}

function createTool(host: ReviewHost): MockcaseReviewView {
  const registry = host.document.defaultView?.customElements ?? globalThis.customElements;
  if (!registry.get(REVIEW_VIEW_TAG)) registry.define(REVIEW_VIEW_TAG, MockcaseReviewView);
  const element = host.document.createElement(REVIEW_VIEW_TAG) as MockcaseReviewView;
  element.setAttribute('data-review-tool', 'mockcase');
  element.onApply = (ids) => runApplication(host, ids);
  element.onComplete = () => void (async () => {
    const route = currentRoute(host);
    if (!route || !canCompleteRoute(host)) return;
    const selected = currentCases(host).filter((item) => reviewedCaseProjections.has(item.id));
    await resetRouteState(false);
    const completed = readCompletedRoutes(host).filter((item) => item.routeId !== route.id);
    completed.push({
      routeId: route.id,
      caseProjections: selected.map((item) => ({
        caseId: item.id,
        projectionDigest: item.projectionDigest,
      })).sort((left, right) => left.caseId.localeCompare(right.caseId)),
      applyStatus: 'PASS',
      rollbackStatus: 'PASS',
    });
    reviewedCaseProjections.clear();
    completed.sort((left, right) => left.routeId.localeCompare(right.routeId));
    writeCompletedRoutes(host, completed);
    const requiredRouteIds = runtime.routes
      .filter((item) => runtime.cases.some((candidate) => candidate.routeId === item.id))
      .map((item) => item.id)
      .sort();
    const completedRouteIds = completed.map((item) => item.routeId).sort();
    const allRoutesComplete = requiredRouteIds.every((id) => completedRouteIds.includes(id));
    host.emit('psp:mockcase-review-complete', {
      actor: runtime.actor,
      routeId: route.id,
      caseProjections: completed.find((item) => item.routeId === route.id)?.caseProjections ?? [],
      completedRoutes: completed,
      completedRouteIds,
      allRoutesComplete,
    });
    if (allRoutesComplete) clearCompletedRoutes(host);
    updateReviewView(host);
  })().catch((error: unknown) => {
    lastApplicationError = errorDetail(error);
    host.emit('psp:mockcase-error', lastApplicationError);
    updateReviewView(host);
  });
  element.onCancel = () => void (async () => {
    if (!extensionReady || pendingApplication) return;
    await resetRouteState();
    clearCompletedRoutes(host);
    host.emit('psp:mockcase-review-cancel', {
      actor: runtime.actor,
      routeId: currentRoute(host)?.id ?? null,
    });
  })().catch((error: unknown) => {
    lastApplicationError = errorDetail(error);
    host.emit('psp:mockcase-error', lastApplicationError);
    updateReviewView(host);
  });
  host.document.body.append(element);
  tool = element;
  updateReviewView(host);
  return element;
}

const extension = {
  async activate(host: ReviewHost) {
    if (host.apiVersion !== 'psp.review-extension/v1') fail('AIH_MOCKCASE_PLUGIN_FAILED', 'Review Host API 不兼容。');
    disposed = false;
    extensionReady = false;
    lastApplicationError = null;
    currentRoutePath = host.location.pathname;
    originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = interceptedFetch;

    async function dispose(clearSession = false) {
      if (disposed) return;
      disposed = true;
      stopRouteObservation();
      await resetRouteState();
      if (originalFetch) globalThis.fetch = originalFetch;
      originalFetch = null;
      if (clearSession) clearCompletedRoutes(host);
      extensionReady = false;
      pendingApplication = null;
      lastApplicationError = null;
      currentRoutePath = '';
      tool?.remove();
      tool = null;
      delete (globalThis as typeof globalThis & { __pspMockcaseRuntimeApi?: unknown }).__pspMockcaseRuntimeApi;
    }

    try {
      tool = createTool(host);
      const defaults = currentCases(host).filter((item) => item.isDefault).map((item) => item.id);
      if (defaults.length > 0) await apply(host, defaults);
      const api = Object.freeze({
        actor: runtime.actor,
        get caseIds() {
          return Object.freeze(currentCases(host).map((item) => item.id));
        },
        apply: (ids: readonly string[]) => apply(host, ids),
        reset: () => resetRouteState(false),
        dispose: () => dispose(true),
      });
      Object.defineProperty(globalThis, '__pspMockcaseRuntimeApi', { value: api, configurable: true });
      extensionReady = true;
      startRouteObservation(host);
      updateReviewView(host);
      host.emit('psp:mockcase-extension-ready', { actor: runtime.actor, caseIds: api.caseIds });
      return { dispose: () => void dispose(false) };
    } catch (error) {
      await dispose(true);
      throw error;
    }
  },
};

export default extension;
