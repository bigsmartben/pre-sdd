export interface HostEventMap {
  'ui-ready': { readonly route: string };
  'ui-error': { readonly code: string; readonly message: string };
}

export function hostEvent<K extends keyof HostEventMap>(
  type: K,
  detail: HostEventMap[K],
): CustomEvent<HostEventMap[K]> {
  return new CustomEvent(type, { detail, bubbles: true, composed: true });
}
