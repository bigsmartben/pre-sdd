import { LitElement, css, html } from 'lit';
import { traceability } from './spec/traceability';

type PreviewState = 'default' | 'loading' | 'success' | 'error';

export class PspApp extends LitElement {
  static properties = {
    previewState: { state: true },
    feedback: { state: true },
  };

  declare private previewState: PreviewState;
  declare private feedback: string;

  constructor() {
    super();
    this.previewState = 'default';
    this.feedback = '选择一种 Mock 行为，验证 Loading、Success 与 Error 状态。';
  }

  private async runMock(mode: 'success' | 'error'): Promise<void> {
    this.previewState = 'loading';
    this.feedback = '正在等待 Mock 响应…';

    try {
      const response = await fetch(`/api/spec-preview?mode=${mode}`);
      const data = (await response.json()) as { message: string };

      if (!response.ok) {
        throw new Error(data.message);
      }

      this.previewState = 'success';
      this.feedback = data.message;
    } catch (error: unknown) {
      this.previewState = 'error';
      this.feedback = error instanceof Error ? error.message : '发生未知错误。';
    }
  }

  protected render() {
    return html`
      <header class="topbar">
        <a class="brand" href="#main" aria-label="PSP HTML Mock 首页">
          <span class="brand-mark">PSP</span>
          <span>HTML Mock Workspace</span>
        </a>
        <span class="badge">Scaffold · Draft</span>
      </header>

      <main id="main">
        <section class="hero" aria-labelledby="hero-title">
          <p class="eyebrow">03 · HTML Mock</p>
          <h1 id="hero-title">把中保真 Wireflow 变成<br />可运行的体验证据。</h1>
          <p class="lead">
            这是产品无关的起始原型。替换本页内容时，必须让每个 UC 场景、Wireflow Screen 与可见状态都能实际操作和审阅。
          </p>
          <div class="pipeline" aria-label="产品设计交付流水线">
            <span>UC-NNN</span><b>→</b><span>WF-NNN</span><b>→</b><span>HTML-MOCK-NNN</span>
          </div>
        </section>

        <section class="grid" aria-label="HTML Mock 验证区">
          <article class="card trace-card">
            <p class="card-index">01 / TRACEABILITY</p>
            <h2>规格追溯</h2>
            ${traceability.length === 0
              ? html`<div class="empty-state">
                  <span class="empty-icon" aria-hidden="true">◇</span>
                  <p>尚未绑定具体产品规格</p>
                  <small>完成 UC.md 后，从 UC-NNN 开始建立映射。</small>
                </div>`
              : html`<ul>
                  ${traceability.map(
                    (link) => html`<li>
                      ${link.useCase} → ${link.wireflows.join(', ')} → ${link.htmlMocks.join(', ')}
                    </li>`,
                  )}
                </ul>`}
          </article>

          <article class="card state-card" data-html-mock="HTML-MOCK-NNN" data-screen="SCREEN-NNN">
            <p class="card-index">02 / STATE LAB</p>
            <h2>交互状态实验台</h2>
            <div class="status" data-state=${this.previewState} role="status" aria-live="polite">
              <span class="status-dot" aria-hidden="true"></span>
              <div>
                <strong>${this.previewState.toUpperCase()}</strong>
                <p>${this.feedback}</p>
              </div>
            </div>
            <div class="actions">
              <button
                class="primary"
                ?disabled=${this.previewState === 'loading'}
                @click=${() => this.runMock('success')}
              >
                模拟成功
              </button>
              <button
                ?disabled=${this.previewState === 'loading'}
                @click=${() => this.runMock('error')}
              >
                模拟错误
              </button>
            </div>
          </article>

          <article class="card gate-card">
            <p class="card-index">03 / DELIVERY GATE</p>
            <h2>进入 Specify 前</h2>
            <ul class="checklist">
              <li><span>1</span>每个 Wireflow Screen 有可定位 DOM</li>
              <li><span>2</span>主场景与显式分支均可实际触发</li>
              <li><span>3</span>Mock 行为产生规格声明的可见状态</li>
              <li><span>4</span>UC → WF → HTML Mock 追溯完整</li>
            </ul>
          </article>
        </section>
      </main>

      <footer>
        <span>Product Specification Pipeline</span>
        <span>Executable, traceable, verifiable.</span>
      </footer>
    `;
  }

  static styles = css`
    :host {
      --ink: #182019;
      --muted: #697269;
      --paper: #f3f0e7;
      --surface: #fffdf7;
      --line: #d7d2c4;
      --accent: #c8f36a;
      --accent-strong: #405d13;
      display: block;
      min-height: 100vh;
      color: var(--ink);
      background:
        linear-gradient(rgba(24, 32, 25, 0.045) 1px, transparent 1px),
        linear-gradient(90deg, rgba(24, 32, 25, 0.045) 1px, transparent 1px),
        var(--paper);
      background-size: 32px 32px;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * { box-sizing: border-box; }

    .topbar, main, footer {
      width: min(1180px, calc(100% - 40px));
      margin-inline: auto;
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 24px 0;
      border-bottom: 1px solid var(--line);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      color: inherit;
      text-decoration: none;
      font-weight: 700;
      letter-spacing: -0.02em;
    }

    .brand-mark {
      display: grid;
      place-items: center;
      width: 44px;
      height: 28px;
      color: #102000;
      background: var(--accent);
      border: 1px solid var(--ink);
      border-radius: 999px;
      font-size: 12px;
      letter-spacing: 0.08em;
    }

    .badge {
      padding: 7px 10px;
      color: var(--muted);
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255, 253, 247, 0.65);
      font: 600 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    main { padding: 72px 0 48px; }
    .hero { max-width: 850px; }

    .eyebrow, .card-index {
      margin: 0 0 16px;
      color: var(--accent-strong);
      font: 700 12px/1.3 ui-monospace, SFMono-Regular, Consolas, monospace;
      letter-spacing: 0.12em;
    }

    h1 {
      max-width: 800px;
      margin: 0;
      font-size: clamp(48px, 8vw, 92px);
      line-height: 0.96;
      letter-spacing: -0.065em;
    }

    .lead {
      max-width: 650px;
      margin: 30px 0;
      color: var(--muted);
      font-size: clamp(17px, 2vw, 21px);
      line-height: 1.7;
    }

    .pipeline {
      display: inline-flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--surface);
    }

    .pipeline span {
      padding: 9px 12px;
      border-radius: 7px;
      background: #e8e4d8;
      font: 700 12px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    .pipeline span:last-child { background: var(--accent); }
    .pipeline b { color: var(--muted); }

    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 18px;
      margin-top: 72px;
    }

    .card {
      min-height: 320px;
      padding: 28px;
      border: 1px solid var(--line);
      border-radius: 20px;
      background: rgba(255, 253, 247, 0.92);
      box-shadow: 0 18px 50px rgba(33, 39, 29, 0.05);
    }

    .card h2 {
      margin: 0 0 26px;
      font-size: 27px;
      letter-spacing: -0.035em;
    }

    .trace-card, .state-card { grid-column: span 6; }
    .gate-card { grid-column: 3 / span 8; min-height: auto; }

    .empty-state {
      display: grid;
      place-items: center;
      min-height: 190px;
      padding: 24px;
      text-align: center;
      border: 1px dashed #bab5a7;
      border-radius: 14px;
      background: #f8f5ec;
    }

    .empty-state p { margin: 12px 0 5px; font-weight: 700; }
    .empty-state small { color: var(--muted); line-height: 1.5; }
    .empty-icon { color: var(--accent-strong); font-size: 30px; }

    .status {
      display: flex;
      gap: 14px;
      min-height: 118px;
      padding: 20px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #f8f5ec;
    }

    .status-dot {
      flex: 0 0 auto;
      width: 12px;
      height: 12px;
      margin-top: 3px;
      border-radius: 50%;
      background: #8b938b;
      box-shadow: 0 0 0 5px rgba(139, 147, 139, 0.14);
    }

    [data-state="loading"] .status-dot { background: #d19a24; animation: pulse 1s infinite; }
    [data-state="success"] .status-dot { background: #539321; }
    [data-state="error"] .status-dot { background: #bc4439; }

    .status strong {
      font: 700 12px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
      letter-spacing: 0.08em;
    }

    .status p { margin: 9px 0 0; color: var(--muted); line-height: 1.5; }

    .actions { display: flex; gap: 10px; margin-top: 16px; }
    button {
      min-height: 44px;
      padding: 0 18px;
      border: 1px solid var(--ink);
      border-radius: 10px;
      color: var(--ink);
      background: transparent;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button.primary { background: var(--accent); }
    button:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 5px 0 var(--ink); }
    button:focus-visible { outline: 3px solid #678e25; outline-offset: 3px; }
    button:disabled { cursor: wait; opacity: 0.55; }

    .checklist { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .checklist li {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 15px 0;
      border-top: 1px solid var(--line);
      font-weight: 650;
    }
    .checklist span {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: #e8e4d8;
      font: 700 11px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
    }

    footer {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      padding: 24px 0 36px;
      color: var(--muted);
      border-top: 1px solid var(--line);
      font-size: 12px;
    }

    @keyframes pulse { 50% { opacity: 0.35; transform: scale(0.75); } }

    @media (max-width: 760px) {
      .topbar, main, footer { width: min(100% - 24px, 1180px); }
      .topbar { align-items: flex-start; gap: 16px; }
      .brand { align-items: flex-start; }
      .badge { display: none; }
      main { padding-top: 48px; }
      .grid { margin-top: 48px; }
      .trace-card, .state-card, .gate-card { grid-column: 1 / -1; }
      .card { padding: 22px; }
      footer { flex-direction: column; }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
    }
  `;
}

customElements.define('psp-app', PspApp);

declare global {
  interface HTMLElementTagNameMap {
    'psp-app': PspApp;
  }
}
