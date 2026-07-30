import { render } from 'lit';
import type { ProductRoute } from './routes/index.js';
import type { UiPorts } from './ports/index.js';
import { matchRoute } from './routes/index.js';

export interface ProductComposition {
  readonly routes: readonly ProductRoute[];
  readonly ports: UiPorts;
}

export async function startProductUi(
  composition: ProductComposition,
  mount: HTMLElement = document.querySelector<HTMLElement>('#app') ?? document.body,
): Promise<void> {
  const match = matchRoute(composition.routes, globalThis.location?.pathname ?? '/');
  if (!match || (match.route.guard && !(await match.route.guard(match.parameters)))) {
    composition.ports.host.emit('ui-error', { code: 'ROUTE_NOT_AVAILABLE', message: '页面不可用。' });
    return;
  }
  const page = match.route.createPage(match.parameters);
  render(page.render(), mount);
  composition.ports.host.emit('ui-ready', { route: match.route.path });
}
