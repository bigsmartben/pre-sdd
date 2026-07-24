import { LitElement, html } from 'lit';
import { canonicalUi } from './spec/canonical-ui';
import './psp-app';

const model = canonicalUi as unknown as {
  routes: ReadonlyArray<{ id: string; path: string; screenId: string }>;
  screens: ReadonlyArray<{ id: string; componentIds: readonly string[] }>;
  componentContracts: ReadonlyArray<{
    id: string;
    componentId: string;
    implementationRole: 'app-shell' | 'feature-shell' | 'shared-component' | 'layout-primitive' | 'page-local';
    mappingId?: string;
    pageInstances: ReadonlyArray<{
      id: string;
      screenId: string;
      origin: 'figma' | 'local';
      figmaInstanceNodeId?: string;
    }>;
  }>;
  componentVariantDefinitions: ReadonlyArray<{
    id: string;
    mappingId: string;
    litVariantAttributes: Readonly<Record<string, string>>;
  }>;
  componentVariantCoverage: ReadonlyArray<{
    mappingId: string;
    definitionId: string;
    usages: ReadonlyArray<{ instanceNodeId: string; screenId: string }>;
  }>;
};

export class PspProductRouter extends LitElement {
  private readonly handleNavigation = (): void => this.requestUpdate();

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('popstate', this.handleNavigation);
  }

  disconnectedCallback(): void {
    window.removeEventListener('popstate', this.handleNavigation);
    super.disconnectedCallback();
  }

  navigate(path: string): void {
    window.history.pushState({}, '', path);
    this.requestUpdate();
  }

  protected updated(): void {
    const route = model.routes.find((item) => item.path === window.location.pathname);
    const screen = model.screens.find((item) => item.id === route?.screenId);
    const contract = model.componentContracts.find((item) => (
      item.implementationRole === 'app-shell'
      && screen?.componentIds.includes(item.componentId)
    ));
    const instance = contract?.pageInstances.find((item) => item.screenId === screen?.id);
    if (!contract?.mappingId || instance?.origin !== 'figma' || !instance.figmaInstanceNodeId) return;
    const coverage = model.componentVariantCoverage.find((item) => (
      item.mappingId === contract.mappingId
      && item.usages.some((usage) => (
        usage.instanceNodeId === instance.figmaInstanceNodeId
        && usage.screenId === instance.screenId
      ))
    ));
    const definition = model.componentVariantDefinitions.find((item) => (
      item.id === coverage?.definitionId && item.mappingId === contract.mappingId
    ));
    const host = this.renderRoot.querySelector<HTMLElement>(
      '[data-component-instance-id="' + instance.id + '"]',
    );
    if (!host || !definition) return;
    for (const [attribute, value] of Object.entries(definition.litVariantAttributes)) {
      host.setAttribute(attribute, value);
    }
  }

  protected render() {
    const route = model.routes.find((item) => item.path === window.location.pathname);
    if (!route) return html`<main data-route-not-found><h1>页面不存在</h1><a href="/">返回首页</a></main>`;
    const screen = model.screens.find((item) => item.id === route.screenId);
    const contract = model.componentContracts.find((item) => (
      item.implementationRole === 'app-shell'
      && screen?.componentIds.includes(item.componentId)
    ));
    const instance = contract?.pageInstances.find((item) => item.screenId === screen?.id);
    const componentId = contract?.componentId ?? 'COMPONENT-001';
    const instanceId = instance?.id ?? 'COMPONENT-INSTANCE-001';
    return instance && 'figmaInstanceNodeId' in instance
      ? html`
          <psp-app
            data-route-id=${route.id}
            data-component-id=${componentId}
            data-component-contract-id=${contract?.id ?? ''}
            data-component-instance-id=${instanceId}
            data-figma-instance-id=${instance.figmaInstanceNodeId}
          ></psp-app>
        `
      : html`
          <psp-app
            data-route-id=${route.id}
            data-component-id=${componentId}
            data-component-contract-id=${contract?.id ?? ''}
            data-component-instance-id=${instanceId}
          ></psp-app>
        `;
  }
}

customElements.define('psp-product-router', PspProductRouter);

declare global {
  interface HTMLElementTagNameMap {
    'psp-product-router': PspProductRouter;
  }
}
