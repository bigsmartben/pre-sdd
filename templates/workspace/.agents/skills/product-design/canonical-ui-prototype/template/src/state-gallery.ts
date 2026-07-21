import { LitElement, css, html } from 'lit';
import { canonicalUi } from './spec/canonical-ui';

type MatrixEntry = {
  id: string;
  componentContractId: string;
  values: Readonly<Record<string, string>>;
  classification: 'legal' | 'mutually-exclusive' | 'unreachable';
  renderInGallery: boolean;
};

type StateAxis = {
  id: string;
  componentContractId: string;
  kind: 'variant' | 'runtime-state' | 'interaction-state' | 'content-override';
  name: string;
  values: ReadonlyArray<{ id: string; value: string; stateId?: string }>;
};

type ComponentContract = {
  id: string;
  componentId: string;
  litTagName: string;
};

const model = canonicalUi as unknown as {
  componentContracts: readonly ComponentContract[];
  stateAxes: readonly StateAxis[];
  stateMatrix: readonly MatrixEntry[];
};

function previewUrl(entry: MatrixEntry): string {
  const query = new URLSearchParams({
    __pspComponentContract: entry.componentContractId,
    __pspStateMatrix: entry.id,
    annotate: '0',
    mockcase: '0',
  });
  return `/?${query.toString()}`;
}

export class PspStateGallery extends LitElement {
  protected render() {
    const entries = model.stateMatrix.filter((entry) => entry.classification === 'legal' && entry.renderInGallery);
    return html`
      <header>
        <p>PSP · COMPONENT REVIEW</p>
        <h1>State Gallery</h1>
        <span>由 Component Contract 与 State Matrix 生成；非法、互斥或不可达组合不会渲染。</span>
      </header>
      <main data-state-gallery>
        ${entries.length === 0
          ? html`<p class="empty">当前草稿尚未声明可渲染的组件状态组合。</p>`
          : entries.map((entry) => {
              const contract = model.componentContracts.find((item) => item.id === entry.componentContractId);
              const axes = model.stateAxes.filter((axis) => axis.componentContractId === entry.componentContractId);
              return html`
                <article
                  data-component-contract-id=${entry.componentContractId}
                  data-state-matrix-id=${entry.id}
                  data-state-classification=${entry.classification}
                >
                  <div class="meta">
                    <p>${contract?.componentId ?? entry.componentContractId} · &lt;${contract?.litTagName ?? 'unresolved'}&gt;</p>
                    <h2>${entry.id}</h2>
                    <dl>
                      ${axes.map((axis) => {
                        const selected = axis.values.find((value) => value.id === entry.values[axis.id]);
                        return html`<div data-state-axis-kind=${axis.kind}><dt>${axis.kind}</dt><dd>${axis.name} = ${selected?.value ?? 'unresolved'}</dd></div>`;
                      })}
                    </dl>
                  </div>
                  <iframe title=${`${contract?.componentId ?? entry.componentContractId} ${entry.id}`} src=${previewUrl(entry)} loading="eager"></iframe>
                </article>
              `;
            })}
      </main>
    `;
  }

  static styles = css`
    :host { display: block; min-height: 100vh; padding: 40px; color: #182019; background: #f3f0e7; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    header, main { width: min(1440px, 100%); margin-inline: auto; }
    header { padding-bottom: 28px; border-bottom: 1px solid #d7d2c4; }
    header p { margin: 0 0 10px; color: #405d13; font: 700 12px/1 ui-monospace, monospace; letter-spacing: .12em; }
    h1 { margin: 0 0 12px; font-size: clamp(42px, 7vw, 76px); letter-spacing: -.055em; }
    header span { color: #697269; }
    main { display: grid; gap: 24px; padding-block: 32px; }
    article { display: grid; grid-template-columns: minmax(280px, .6fr) minmax(520px, 1.4fr); overflow: hidden; border: 1px solid #d7d2c4; border-radius: 20px; background: #fffdf7; }
    .meta { padding: 24px; border-right: 1px solid #d7d2c4; }
    .meta > p { color: #405d13; font: 700 11px/1.4 ui-monospace, monospace; }
    h2 { margin: 12px 0 24px; font-size: 24px; }
    dl, dl div { display: grid; gap: 8px; }
    dl div { grid-template-columns: 130px 1fr; padding-top: 10px; border-top: 1px solid #e8e4d8; }
    dt { color: #697269; font: 700 10px/1.4 ui-monospace, monospace; text-transform: uppercase; }
    dd { margin: 0; font-size: 13px; }
    iframe { width: 100%; min-height: 560px; border: 0; background: white; }
    .empty { padding: 40px; border: 1px dashed #bab5a7; border-radius: 16px; text-align: center; }
    @media (max-width: 900px) {
      :host { padding: 20px; }
      article { grid-template-columns: 1fr; }
      .meta { border-right: 0; border-bottom: 1px solid #d7d2c4; }
      iframe { min-height: 680px; }
    }
  `;
}

customElements.define('psp-state-gallery', PspStateGallery);

declare global {
  interface HTMLElementTagNameMap {
    'psp-state-gallery': PspStateGallery;
  }
}
