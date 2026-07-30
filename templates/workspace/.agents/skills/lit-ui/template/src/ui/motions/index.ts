export interface ProductMotion {
  readonly trigger: string;
  readonly targetId: string;
  readonly durationMs: number;
  readonly interruptible: boolean;
  readonly reducedMotion: 'remove-transform' | 'disable' | 'shorten';
}

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
