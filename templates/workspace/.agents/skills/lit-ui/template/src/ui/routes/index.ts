import type { ProductPage } from '../pages/index.js';

export interface ProductRoute {
  readonly path: string;
  readonly createPage: (parameters: Readonly<Record<string, string>>) => ProductPage;
  readonly guard?: (parameters: Readonly<Record<string, string>>) => boolean | Promise<boolean>;
}

export interface ProductRouteMatch {
  readonly route: ProductRoute;
  readonly parameters: Readonly<Record<string, string>>;
}

export function matchRoute(routes: readonly ProductRoute[], pathname: string): ProductRouteMatch | undefined {
  const actual = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    const pattern = route.path.split('/').filter(Boolean);
    if (pattern.length !== actual.length) continue;
    const parameters: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const expected = pattern[index];
      if (expected.startsWith(':')) parameters[expected.slice(1)] = decodeURIComponent(actual[index]);
      else if (expected !== actual[index]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, parameters: Object.freeze(parameters) };
  }
  return undefined;
}
