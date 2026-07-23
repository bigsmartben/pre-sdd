import { LitElement, html } from 'lit';
import { canonicalUi } from './spec/canonical-ui';
import './psp-app';

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

  protected render() {
    const route = canonicalUi.routes.find((item) => item.path === window.location.pathname);
    return route
      ? html`<psp-app data-route-id=${route.id}></psp-app>`
      : html`<main data-route-not-found><h1>页面不存在</h1><a href="/">返回首页</a></main>`;
  }
}

customElements.define('psp-product-router', PspProductRouter);

declare global {
  interface HTMLElementTagNameMap {
    'psp-product-router': PspProductRouter;
  }
}
