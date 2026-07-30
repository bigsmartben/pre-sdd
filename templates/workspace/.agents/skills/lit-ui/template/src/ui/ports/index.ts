import type { HostEventMap } from '../events/index.js';
import type { UiError } from '../models/index.js';

export interface Cancellation {
  readonly signal: AbortSignal;
}

export type PortResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: UiError };

export interface HostPort {
  emit<K extends keyof HostEventMap>(type: K, detail: HostEventMap[K]): void;
}

export interface ServicePort<Input, Output> {
  execute(input: Input, cancellation: Cancellation): Promise<PortResult<Output>>;
}

export interface UiPorts {
  readonly host: HostPort;
}
