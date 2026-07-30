import type { HostEventMap } from '../../ui/events/index.js';
import type { HostPort } from '../../ui/ports/index.js';

export class BrowserHostAdapter implements HostPort {
  constructor(private readonly target: EventTarget = globalThis) {}

  emit<K extends keyof HostEventMap>(type: K, detail: HostEventMap[K]): void {
    this.target.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
