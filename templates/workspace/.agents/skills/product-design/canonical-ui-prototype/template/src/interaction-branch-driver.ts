import { LitElement, css, html } from 'lit';
import { canonicalUi } from './spec/canonical-ui';

type ReviewScenario = {
  id: string;
  routeId: string;
  eventIds: readonly string[];
  expectedStateIds: readonly string[];
};

type ReviewEvent = {
  id: string;
  controlId: string;
};

const model = canonicalUi as unknown as {
  routes: ReadonlyArray<{ id: string; path: string }>;
  scenarios: readonly ReviewScenario[];
  events: readonly ReviewEvent[];
  actions: ReadonlyArray<{ id: string; eventId: string; resultingStateIds: readonly string[] }>;
};

function roots(): Array<Document | ShadowRoot> {
  const found: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < found.length; index += 1) {
    for (const element of found[index].querySelectorAll<HTMLElement>('*')) {
      if (element.shadowRoot) found.push(element.shadowRoot);
    }
  }
  return found;
}

function findElement(selector: string): HTMLElement | null {
  for (const root of roots()) {
    const element = root.querySelector<HTMLElement>(selector);
    if (element) return element;
  }
  return null;
}

function visibleState(stateId: string): boolean {
  const selector = `[data-state-id="${CSS.escape(stateId)}"],[data-component-state="${CSS.escape(stateId)}"]`;
  return roots().some((root) => [...root.querySelectorAll<HTMLElement>(selector)]
    .some((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true'));
}

async function waitForStates(stateIds: readonly string[], timeoutMs = 5000): Promise<void> {
  const startedAt = performance.now();
  while (!stateIds.every(visibleState)) {
    if (performance.now() - startedAt >= timeoutMs) {
      throw new Error(`未在 ${timeoutMs}ms 内到达声明状态：${stateIds.join(', ')}`);
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 40));
  }
}

export class PspInteractionBranchDriver extends LitElement {
  static properties = {
    runningScenarioId: { state: true },
    message: { state: true },
  };

  declare private runningScenarioId: string;
  declare private message: string;

  constructor() {
    super();
    this.runningScenarioId = '';
    this.message = '选择当前页面的交互分支。';
  }

  private get scenarios(): readonly ReviewScenario[] {
    const route = model.routes.find((item) => item.path === window.location.pathname);
    return model.scenarios.filter((scenario) => scenario.routeId === route?.id);
  }

  private async runScenario(scenario: ReviewScenario): Promise<void> {
    if (this.runningScenarioId) return;
    this.runningScenarioId = scenario.id;
    this.message = `正在驱动 ${scenario.id}…`;
    try {
      for (const eventId of scenario.eventIds) {
        const event = model.events.find((item) => item.id === eventId);
        if (!event) throw new Error(`场景引用未知事件：${eventId}`);
        const control = findElement(
          `[data-control-id="${CSS.escape(event.controlId)}"][data-event-id="${CSS.escape(event.id)}"]`,
        );
        if (!(control instanceof HTMLElement)) throw new Error(`页面缺少事件控件：${event.id}`);
        control.click();
        const actions = model.actions.filter((item) => item.eventId === event.id);
        if (actions.length !== 1) throw new Error(`事件必须且只能对应一个动作：${event.id}`);
        const finalActionState = actions[0].resultingStateIds.at(-1);
        if (!finalActionState) throw new Error(`动作缺少结果状态：${actions[0].id}`);
        await waitForStates([finalActionState]);
      }
      await waitForStates(scenario.expectedStateIds);
      this.message = `${scenario.id} 已达到声明的最终状态。`;
      this.dispatchEvent(new CustomEvent('psp:interaction-branch-complete', {
        bubbles: true,
        composed: true,
        detail: { scenarioId: scenario.id, expectedStateIds: [...scenario.expectedStateIds] },
      }));
    } catch (error: unknown) {
      this.message = error instanceof Error ? error.message : '交互分支驱动失败。';
    } finally {
      this.runningScenarioId = '';
    }
  }

  protected render() {
    const scenarios = this.scenarios;
    return html`
      <aside aria-label="交互分支驱动器">
        <header>
          <p>REVIEW TOOL</p>
          <h2>交互分支</h2>
        </header>
        <div class="scenarios">
          ${scenarios.length === 0
            ? html`<span class="empty">当前页面没有声明 Scenario。</span>`
            : scenarios.map((scenario) => html`
                <button
                  type="button"
                  data-scenario-id=${scenario.id}
                  ?disabled=${Boolean(this.runningScenarioId)}
                  @click=${() => this.runScenario(scenario)}
                >${scenario.id}</button>
              `)}
        </div>
        <p class="status" role="status" aria-live="polite">${this.message}</p>
      </aside>
    `;
  }

  static styles = css`
    :host {
      all: initial;
      position: fixed;
      left: 12px;
      bottom: 12px;
      z-index: 2147483000;
      display: block;
      width: min(320px, calc(100vw - 24px));
      color-scheme: light;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    *, *::before, *::after { box-sizing: border-box; }
    aside {
      padding: 14px;
      border: 1px solid #d9dde5;
      border-radius: 16px;
      color: #1f2430;
      background: rgba(255, 255, 255, .98);
      box-shadow: 0 18px 60px rgba(20, 24, 32, .2);
      font-size: 13px;
    }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    header p { margin: 0; color: #697386; font-size: 10px; font-weight: 800; letter-spacing: .1em; }
    h2 { margin: 0; font-size: 16px; }
    .scenarios { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 12px; }
    button {
      min-height: 34px;
      padding: 0 10px;
      border: 1px solid #b8c1d1;
      border-radius: 9px;
      color: #1f2430;
      background: #f6f8fb;
      font: inherit;
      font-weight: 750;
      cursor: pointer;
    }
    button:disabled { cursor: wait; opacity: .52; }
    button:focus-visible { outline: 3px solid #7aa2ff; outline-offset: 2px; }
    .empty { color: #697386; }
    .status { margin: 10px 0 0; color: #4b5568; line-height: 1.4; }
  `;
}

customElements.define('psp-interaction-branch-driver', PspInteractionBranchDriver);
const interactionBranchDriver = document.createElement('psp-interaction-branch-driver');
interactionBranchDriver.setAttribute('data-review-tool', 'interaction-branch-driver');
document.body.append(interactionBranchDriver);

declare global {
  interface HTMLElementTagNameMap {
    'psp-interaction-branch-driver': PspInteractionBranchDriver;
  }
}
