import type { Cancellation, PortResult, ServicePort } from '../ui/ports/index.js';

export interface PortContractExample<Input, Output> {
  readonly input: Input;
  readonly verify: (result: PortResult<Output>) => void;
}

export async function verifyAdapterContract<Input, Output>(
  adapters: readonly ServicePort<Input, Output>[],
  example: PortContractExample<Input, Output>,
): Promise<void> {
  const cancellation: Cancellation = { signal: new AbortController().signal };
  for (const adapter of adapters) {
    const result = await adapter.execute(example.input, cancellation);
    example.verify(result);
  }
}
