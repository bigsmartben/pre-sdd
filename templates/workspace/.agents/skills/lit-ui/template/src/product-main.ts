import type { ProductComposition } from './ui/main.js';
import { startProductUi } from './ui/main.js';
import './adapters/real/browser-host-adapter.js';
import './adapters/real/fetch-service-adapter.js';

/**
 * Production composition must provide only real adapters. The project-specific
 * implementation calls this function after creating its real ProductComposition.
 */
export function startProduction(composition: ProductComposition): Promise<void> {
  return startProductUi(composition);
}
