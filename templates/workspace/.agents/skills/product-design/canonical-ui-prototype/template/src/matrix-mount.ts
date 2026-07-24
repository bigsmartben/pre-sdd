import { LitElement, css, html } from 'lit';
import { canonicalUi } from './spec/canonical-ui';

type StateAxisValue = {
  id: string;
  value: string;
  stateId?: string;
  renderValue?: unknown;
};

type StateAxis = {
  id: string;
  componentContractId: string;
  kind: 'variant' | 'runtime-state' | 'interaction-state' | 'content-override';
  name: string;
  renderBinding: {
    kind: 'mapped-variant' | 'component-state' | 'workflow-state' | 'lit-property' | 'lit-attribute' | 'slot-text';
    name?: string;
  };
  values: readonly StateAxisValue[];
};

type MatrixEntry = {
  id: string;
  componentContractId: string;
  values: Readonly<Record<string, string>>;
  classification: 'legal' | 'mutually-exclusive' | 'unreachable';
};

type ComponentContract = {
  id: string;
  componentId: string;
  mappingId?: string;
  litTagName: string;
  properties: ReadonlyArray<{
    name: string;
    type: 'string' | 'boolean' | 'number' | 'object';
  }>;
  attributes: ReadonlyArray<{
    name: string;
    propertyName: string;
  }>;
};

type ComponentMapping = {
  id: string;
  propertyMappings: ReadonlyArray<{
    kind: string;
    figmaProperty: string;
    litProperty: string | null;
    litAttribute: string | null;
    values: ReadonlyArray<{ figmaValue: string; litValue: string }>;
  }>;
};

const model = canonicalUi as unknown as {
  componentContracts: readonly ComponentContract[];
  componentMappings: readonly ComponentMapping[];
  stateAxes: readonly StateAxis[];
  stateMatrix: readonly MatrixEntry[];
};

function serialized(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function writeAttribute(
  host: HTMLElement & Record<string, unknown>,
  contract: ComponentContract,
  name: string,
  value: unknown,
): void {
  const attribute = contract.attributes.find((item) => item.name === name);
  const property = contract.properties.find((item) => item.name === attribute?.propertyName);
  if (property?.type === 'boolean') {
    if (value === true) host.setAttribute(name, '');
    else host.removeAttribute(name);
    return;
  }
  host.setAttribute(name, serialized(value));
}

export class PspMatrixMount extends LitElement {
  private readonly contractId = new URLSearchParams(window.location.search).get('__pspComponentContract');
  private readonly entryId = new URLSearchParams(window.location.search).get('__pspStateMatrix');
  private readonly contract = model.componentContracts.find((item) => item.id === this.contractId);
  private readonly entry = model.stateMatrix.find((item) => item.id === this.entryId);
  private readonly axes = model.stateAxes.filter((item) => item.componentContractId === this.contractId);

  protected firstUpdated(): void {
    const mount = this.renderRoot.querySelector<HTMLElement>('[data-matrix-host]');
    if (!mount || !this.contract || !this.entry || this.entry.classification !== 'legal') return;

    const host = document.createElement(this.contract.litTagName) as HTMLElement & Record<string, unknown>;
    host.setAttribute('data-component-id', this.contract.componentId);
    host.setAttribute('data-component-instance-id', `PREVIEW-${this.entry.id}`);
    host.setAttribute('data-component-contract-id', this.contract.id);
    host.setAttribute('data-state-matrix-id', this.entry.id);

    const mapping = model.componentMappings.find((item) => item.id === this.contract?.mappingId);
    for (const axis of this.axes) {
      const selected = axis.values.find((value) => value.id === this.entry?.values[axis.id]);
      if (!selected) continue;
      if (axis.renderBinding.kind === 'mapped-variant') {
        const property = mapping?.propertyMappings.find(
          (item) => item.kind === 'variant' && item.figmaProperty === axis.name,
        );
        const mapped = property?.values.find((item) => item.figmaValue === selected.value);
        if (property?.litAttribute && mapped) host.setAttribute(property.litAttribute, mapped.litValue);
      } else if (axis.renderBinding.kind === 'component-state' && axis.renderBinding.name) {
        host[axis.renderBinding.name] = selected.renderValue;
      } else if (axis.renderBinding.kind === 'lit-property' && axis.renderBinding.name) {
        host[axis.renderBinding.name] = selected.renderValue;
      } else if (axis.renderBinding.kind === 'lit-attribute' && axis.renderBinding.name) {
        writeAttribute(host, this.contract, axis.renderBinding.name, selected.renderValue);
      } else if (axis.renderBinding.kind === 'slot-text' && axis.renderBinding.name) {
        const slot = document.createElement('span');
        slot.slot = axis.renderBinding.name;
        slot.textContent = serialized(selected.renderValue);
        slot.setAttribute('data-content-axis-id', axis.id);
        host.append(slot);
      }
    }
    mount.replaceChildren(host);
  }

  protected render() {
    if (!this.contract || !this.entry || this.entry.componentContractId !== this.contract.id || this.entry.classification !== 'legal') {
      return html`<main data-component-preview-error>无效的 Component Contract 或 State Matrix Entry。</main>`;
    }
    const interactionAxes = this.axes.filter((axis) => axis.renderBinding.kind === 'workflow-state');
    return html`
      <main
        data-component-preview
        data-component-contract-id=${this.contract.id}
        data-state-matrix-id=${this.entry.id}
      >
        <div class="workflow-states" aria-label="Workflow State">
          ${interactionAxes.map((axis) => {
            const selected = axis.values.find((value) => value.id === this.entry?.values[axis.id]);
            return selected?.stateId
              ? html`<span data-state-axis-id=${axis.id} data-state-id=${selected.stateId}>${selected.value}</span>`
              : null;
          })}
        </div>
        <div data-matrix-host></div>
      </main>
    `;
  }

  static styles = css`
    :host {
      display: block;
      min-height: 100vh;
      background: white;
    }
    [data-component-preview] {
      display: grid;
      min-height: 100vh;
      align-content: start;
    }
    .workflow-states {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 8px;
      color: #405d13;
      background: #f3f0e7;
      font: 600 11px/1.3 ui-monospace, monospace;
    }
    [data-matrix-host] {
      min-width: 0;
    }
    [data-component-preview-error] {
      padding: 24px;
      color: #8b1f1f;
      font-family: system-ui, sans-serif;
    }
  `;
}

customElements.define('psp-matrix-mount', PspMatrixMount);

declare global {
  interface HTMLElementTagNameMap {
    'psp-matrix-mount': PspMatrixMount;
  }
}
