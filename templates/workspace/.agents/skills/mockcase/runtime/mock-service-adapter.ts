import type {
  Cancellation,
  PortResult,
  ServicePort,
} from '../../lit-ui/template/src/ui/ports/index.js';

export interface MockFixture<Input, Output> {
  readonly input: Input;
  readonly result: PortResult<Output>;
}

export class MockServiceAdapter<Input, Output> implements ServicePort<Input, Output> {
  constructor(private readonly fixtures: readonly MockFixture<Input, Output>[]) {}

  async execute(input: Input, cancellation: Cancellation): Promise<PortResult<Output>> {
    if (cancellation.signal.aborted) {
      return { ok: false, error: { code: 'CANCELLED', message: '操作已取消。', retryable: true } };
    }
    const fixture = this.fixtures.find((item) => JSON.stringify(item.input) === JSON.stringify(input));
    if (!fixture) {
      return { ok: false, error: { code: 'MOCK_FIXTURE_MISSING', message: '没有匹配的 Mock Fixture。', retryable: false } };
    }
    return structuredClone(fixture.result);
  }
}
