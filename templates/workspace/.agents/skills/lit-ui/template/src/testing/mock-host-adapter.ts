import type { HostEventMap } from '../ui/events/index.js';
import type { HostPort } from '../ui/ports/index.js';

export class MockHostAdapter implements HostPort {
  readonly events: Array<{ type: keyof HostEventMap; detail: HostEventMap[keyof HostEventMap] }> = [];

  emit<K extends keyof HostEventMap>(type: K, detail: HostEventMap[K]): void {
    this.events.push({ type, detail });
  }
}
