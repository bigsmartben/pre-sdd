type Runtime = {
  actor: string;
  routes: Array<{ id: string; path: string }>;
  fixtures: Array<{ id: string; payload: unknown }>;
  behaviors: Array<{
    id: string;
    request: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string> };
    response: { fixtureId: string; status: number; headers?: Record<string, string>; delayMs?: number };
  }>;
  cases: Array<{
    id: string;
    label: string;
    routeId: string;
    isDefault: boolean;
    effects: Array<{
      targetInstanceId: string;
      behaviorIds: string[];
      activation: { kind: 'request' | 'control-event' | 'input'; controlId?: string; value?: string };
      expectedStateIds: string[];
    }>;
  }>;
};

type ReviewHost = {
  apiVersion: 'psp.review-extension/v1';
  document: Document;
  location: Location;
  emit(type: string, detail: unknown): void;
};

declare const __PSP_MOCKCASE_RUNTIME__: Runtime;

const runtime = __PSP_MOCKCASE_RUNTIME__;
const originalFetch = globalThis.fetch.bind(globalThis);
let activeBehaviorIds = new Set<string>();
let activeCaseIds: string[] = [];
let disposed = false;
let tool: HTMLElement | null = null;
let extensionReady = false;
let pendingUserApplication: Promise<void> | null = null;
let lastUserApplicationFailed = false;
let completeAction: HTMLButtonElement | null = null;
let caseActions: HTMLButtonElement[] = [];
const baselineStates = new Map<string, { stateId: string | null; componentState: string | null }>();

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function escape(value: string): string {
  return CSS.escape(value);
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

function currentCases(host: ReviewHost) {
  const routeId = runtime.routes.find((item) => item.path === host.location.pathname)?.id;
  return runtime.cases.filter((item) => item.routeId === routeId);
}

function matchingBehavior(input: RequestInfo | URL, init?: RequestInit): Runtime['behaviors'][number] | null {
  const request = new Request(input, init);
  const url = new URL(request.url, globalThis.location.href);
  const matches = runtime.behaviors.filter((item) => {
    if (!activeBehaviorIds.has(item.id) || item.request.method !== request.method || item.request.path !== url.pathname) return false;
    if (item.request.query && Object.entries(item.request.query).some(([key, value]) => url.searchParams.get(key) !== value)) return false;
    if (item.request.headers && Object.entries(item.request.headers).some(([key, value]) => request.headers.get(key) !== value)) return false;
    return true;
  });
  if (matches.length > 1) {
    fail('AIH_MOCKCASE_CONFLICT', `请求同时匹配多个 Behavior：${matches.map((item) => item.id).join(',')}`);
  }
  return matches[0] ?? null;
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
  if (!behavior) return originalFetch(input, init);
  if (behavior.response.delayMs) await new Promise((resolve) => setTimeout(resolve, behavior.response.delayMs));
  return responseFor(behavior);
}

function snapshot(element: HTMLElement) {
  return {
    element,
    stateId: element.getAttribute('data-state-id'),
    componentState: element.getAttribute('data-component-state'),
  };
}

function restore(item: ReturnType<typeof snapshot>) {
  if (item.stateId === null) item.element.removeAttribute('data-state-id');
  else item.element.setAttribute('data-state-id', item.stateId);
  if (item.componentState === null) item.element.removeAttribute('data-component-state');
  else item.element.setAttribute('data-component-state', item.componentState);
}

function targetElement(host: ReviewHost, targetInstanceId: string): HTMLElement {
  const element = queryPublicElement(host.document, `[data-component-instance-id="${escape(targetInstanceId)}"]`);
  if (!element) fail('AIH_MOCKCASE_TARGET_MISSING', `组件实例不存在：${targetInstanceId}`);
  return element;
}

function rememberBaseline(targetInstanceId: string, element: HTMLElement): void {
  if (baselineStates.has(targetInstanceId)) return;
  baselineStates.set(targetInstanceId, {
    stateId: element.getAttribute('data-state-id'),
    componentState: element.getAttribute('data-component-state'),
  });
}

function restoreBaseline(host: ReviewHost, targetInstanceId: string): void {
  const baseline = baselineStates.get(targetInstanceId);
  if (!baseline) return;
  restore({ element: targetElement(host, targetInstanceId), ...baseline });
}

async function waitForState(element: HTMLElement, expected: string[], timeoutMs = 4000): Promise<void> {
  if (expected.length === 0) return;
  const observedElements = new Set<HTMLElement>();
  let current: HTMLElement | null = element;
  while (current) {
    observedElements.add(current);
    const root = current.getRootNode();
    current = current.parentElement ?? (root instanceof ShadowRoot ? root.host as HTMLElement : null);
  }
  const observedValues = () => new Set([...observedElements].flatMap((item) => [
    item.getAttribute('data-state-id') ?? '',
    ...(item.getAttribute('data-component-state') ?? '').split(/\s+/),
  ]));
  const matches = () => {
    const values = observedValues();
    return expected.every((value) => values.has(value));
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
      const values = [...observedValues()].filter(Boolean).join(',');
      reject(Object.assign(new Error(
        `组件未在超时内进入预期状态：expected=${expected.join(',')}；`
        + `observed=${values}`,
      ), { code: 'AIH_MOCKCASE_TIMEOUT' }));
    }, timeoutMs);
    for (const item of observedElements) {
      observer.observe(item, { attributes: true, attributeFilter: ['data-state-id', 'data-component-state'] });
    }
  });
}

function selectedCases(host: ReviewHost, ids: readonly string[]) {
  const available = currentCases(host);
  const selected = [...new Set(ids)].sort().map((id) => available.find((item) => item.id === id));
  if (selected.some((item) => !item)) fail('AIH_MOCKCASE_CONTRACT_INVALID', '包含未知或跨 Route 的 Case。');
  return selected as typeof available;
}

function assertNoConflict(cases: ReturnType<typeof currentCases>): void {
  const targetStates = new Map<string, string>();
  const requestMatchers = new Map<string, string>();
  for (const item of cases) for (const effect of item.effects) {
    const state = effect.expectedStateIds.join('|');
    const previous = targetStates.get(effect.targetInstanceId);
    if (previous && previous !== state) fail('AIH_MOCKCASE_CONFLICT', `Case 目标状态冲突：${effect.targetInstanceId}`);
    targetStates.set(effect.targetInstanceId, state);
    for (const behaviorId of effect.behaviorIds) {
      const behavior = runtime.behaviors.find((entry) => entry.id === behaviorId);
      if (!behavior) fail('AIH_MOCKCASE_CONTRACT_INVALID', `Behavior 不存在：${behaviorId}`);
      const matcher = JSON.stringify([
        behavior.request.method,
        behavior.request.path,
        Object.entries(behavior.request.query ?? {}).sort(),
        Object.entries(behavior.request.headers ?? {}).sort(),
      ]);
      const conflictingBehavior = requestMatchers.get(matcher);
      if (conflictingBehavior && conflictingBehavior !== behaviorId) {
        fail('AIH_MOCKCASE_CONFLICT', `Behavior Request Matcher 冲突：${conflictingBehavior} / ${behaviorId}`);
      }
      requestMatchers.set(matcher, behaviorId);
    }
  }
}

async function activateEffect(host: ReviewHost, effect: Runtime['cases'][number]['effects'][number]): Promise<void> {
  const target = targetElement(host, effect.targetInstanceId);
  const control = effect.activation.controlId
    ? target.querySelector<HTMLElement>(`[data-control-id="${escape(effect.activation.controlId)}"]`)
      ?? queryPublicElement(host.document, `[data-control-id="${escape(effect.activation.controlId)}"]`)
    : null;
  if (effect.activation.controlId && !control) fail('AIH_MOCKCASE_TARGET_MISSING', `Control 不存在：${effect.activation.controlId}`);
  if (effect.activation.kind === 'request') {
    for (const behaviorId of effect.behaviorIds) {
      const behavior = runtime.behaviors.find((item) => item.id === behaviorId);
      if (!behavior) fail('AIH_MOCKCASE_CONTRACT_INVALID', `Behavior 不存在：${behaviorId}`);
      const requestUrl = new URL(behavior.request.path, globalThis.location.origin);
      for (const [key, value] of Object.entries(behavior.request.query ?? {})) requestUrl.searchParams.set(key, value);
      const response = await globalThis.fetch(requestUrl, {
        method: behavior.request.method,
        headers: behavior.request.headers,
      });
      target.dispatchEvent(new CustomEvent('psp:review-network-response', {
        bubbles: true,
        composed: true,
        detail: { response: response.clone() },
      }));
    }
  } else if (effect.activation.kind === 'input') {
    if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement) {
      control.value = effect.activation.value ?? '';
    } else if (control) {
      control.textContent = effect.activation.value ?? '';
    }
    control?.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    control?.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  } else if (control) {
    control.click();
  }
  await waitForState(target, effect.expectedStateIds);
}

async function apply(host: ReviewHost, ids: readonly string[]) {
  if (disposed) fail('AIH_MOCKCASE_PLUGIN_FAILED', 'Extension 已释放。');
  const cases = selectedCases(host, ids);
  assertNoConflict(cases);
  const previousBehaviors = activeBehaviorIds;
  const previousCases = activeCaseIds;
  const previousCaseItems = selectedCases(host, previousCases);
  const targetIds = [...new Set([...previousCaseItems, ...cases].flatMap((item) =>
    item.effects.map((effect) => effect.targetInstanceId)))];
  const snapshots = targetIds.map((targetInstanceId) => {
    const element = targetElement(host, targetInstanceId);
    rememberBaseline(targetInstanceId, element);
    return snapshot(element);
  });
  activeBehaviorIds = new Set(cases.flatMap((item) => item.effects.flatMap((effect) => effect.behaviorIds)));
  try {
    for (const item of previousCaseItems) {
      for (const effect of item.effects) restoreBaseline(host, effect.targetInstanceId);
    }
    for (const item of cases) for (const effect of item.effects) await activateEffect(host, effect);
    activeCaseIds = cases.map((item) => item.id);
    host.emit('psp:mockcase-ready', { actor: runtime.actor, activeCaseIds });
    tool?.setAttribute('data-active-case-ids', activeCaseIds.join(','));
    return { activeCaseIds: [...activeCaseIds] };
  } catch (error) {
    activeBehaviorIds = previousBehaviors;
    activeCaseIds = previousCases;
    try {
      for (const item of snapshots.reverse()) restore(item);
    } catch {
      fail('AIH_MOCKCASE_ROLLBACK_FAILED', '失败事务未能恢复组件公开状态。');
    }
    host.emit('psp:mockcase-error', {
      code: error instanceof Error && 'code' in error ? String(error.code) : 'AIH_MOCKCASE_PLUGIN_FAILED',
      message: error instanceof Error ? error.message : 'MockCase 事务失败',
    });
    throw error;
  }
}

function updateReviewActions(): void {
  const busy = pendingUserApplication !== null;
  for (const button of caseActions) button.disabled = busy || !extensionReady;
  if (completeAction) completeAction.disabled = busy || !extensionReady || lastUserApplicationFailed;
}

function runUserApplication(host: ReviewHost, ids: readonly string[]): void {
  if (!extensionReady || pendingUserApplication) return;
  lastUserApplicationFailed = false;
  let operation: Promise<void>;
  operation = apply(host, ids)
    .then(() => {
      lastUserApplicationFailed = false;
    })
    .catch(() => {
      lastUserApplicationFailed = true;
    })
    .finally(() => {
      if (pendingUserApplication === operation) pendingUserApplication = null;
      updateReviewActions();
    });
  pendingUserApplication = operation;
  updateReviewActions();
}

function createTool(host: ReviewHost): HTMLElement {
  const element = host.document.createElement('aside');
  element.setAttribute('data-review-tool', 'mockcase');
  element.setAttribute('aria-label', 'MockCase Review Extension');
  element.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;padding:10px;background:#fff;border:1px solid #777;border-radius:8px;font:12px sans-serif';
  const cases = currentCases(host);
  const title = host.document.createElement('strong');
  title.textContent = 'MockCase';
  element.append(title);
  for (const item of cases) {
    const button = host.document.createElement('button');
    button.type = 'button';
    button.textContent = item.label;
    button.dataset.caseId = item.id;
    button.style.display = 'block';
    button.addEventListener('click', () => runUserApplication(host, [item.id]));
    caseActions.push(button);
    element.append(button);
  }
  const actions = host.document.createElement('div');
  actions.style.cssText = 'display:flex;gap:6px;margin-top:10px';
  const complete = host.document.createElement('button');
  complete.type = 'button';
  complete.textContent = '完成评审';
  complete.dataset.reviewAction = 'complete';
  complete.addEventListener('click', () => {
    if (!extensionReady || pendingUserApplication || lastUserApplicationFailed) return;
    host.emit('psp:mockcase-review-complete', { actor: runtime.actor, activeCaseIds: [...activeCaseIds] });
  });
  completeAction = complete;
  const cancel = host.document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.dataset.reviewAction = 'cancel';
  cancel.addEventListener('click', () => {
    host.emit('psp:mockcase-review-cancel', { actor: runtime.actor, activeCaseIds: [...activeCaseIds] });
  });
  actions.append(complete, cancel);
  element.append(actions);
  host.document.body.append(element);
  updateReviewActions();
  return element;
}

const extension = {
  async activate(host: ReviewHost) {
    if (host.apiVersion !== 'psp.review-extension/v1') fail('AIH_MOCKCASE_PLUGIN_FAILED', 'Review Host API 不兼容。');
    function dispose() {
      if (disposed) return;
      disposed = true;
      globalThis.fetch = originalFetch;
      for (const targetInstanceId of baselineStates.keys()) {
        try {
          restoreBaseline(host, targetInstanceId);
        } catch {
          // Detached targets are already outside the active Review surface.
        }
      }
      baselineStates.clear();
      activeBehaviorIds = new Set();
      activeCaseIds = [];
      extensionReady = false;
      pendingUserApplication = null;
      lastUserApplicationFailed = false;
      completeAction = null;
      caseActions = [];
      tool?.remove();
      tool = null;
      delete (globalThis as typeof globalThis & { __pspMockcaseRuntimeApi?: unknown }).__pspMockcaseRuntimeApi;
    }
    globalThis.fetch = interceptedFetch;
    try {
      tool = createTool(host);
      const defaults = currentCases(host).filter((item) => item.isDefault).map((item) => item.id);
      if (defaults.length > 0) await apply(host, defaults);
      const api = Object.freeze({
        actor: runtime.actor,
        caseIds: Object.freeze(currentCases(host).map((item) => item.id)),
        apply: (ids: readonly string[]) => apply(host, ids),
        dispose: () => dispose(),
      });
      Object.defineProperty(globalThis, '__pspMockcaseRuntimeApi', { value: api, configurable: true });
      extensionReady = true;
      updateReviewActions();
      host.emit('psp:mockcase-extension-ready', { actor: runtime.actor, caseIds: api.caseIds });
      return { dispose };
    } catch (error) {
      dispose();
      throw error;
    }
  },
};

export default extension;
