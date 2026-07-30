import type {
  Cancellation,
  PortResult,
  ServicePort,
} from '../../ui/ports/index.js';

export class FetchServiceAdapter<Input, Output> implements ServicePort<Input, Output> {
  constructor(
    private readonly endpoint: URL,
    private readonly decode: (value: unknown) => Output,
  ) {}

  async execute(input: Input, cancellation: Cancellation): Promise<PortResult<Output>> {
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        signal: cancellation.signal,
      });
      if (!response.ok) {
        return {
          ok: false,
          error: {
            code: `HTTP_${response.status}`,
            message: `服务返回 ${response.status}。`,
            retryable: response.status >= 500,
          },
        };
      }
      return { ok: true, value: this.decode(await response.json()) };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: cancellation.signal.aborted ? 'CANCELLED' : 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    }
  }
}
