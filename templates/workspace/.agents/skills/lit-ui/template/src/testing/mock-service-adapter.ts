import type {
  Cancellation,
  PortResult,
  ServicePort,
} from '../ui/ports/index.js';

export interface ServiceFixture<Input, Output> {
  readonly matches: (input: Input) => boolean;
  readonly result: PortResult<Output>;
}

export class MockServiceAdapter<Input, Output> implements ServicePort<Input, Output> {
  constructor(private readonly fixtures: readonly ServiceFixture<Input, Output>[]) {}

  async execute(input: Input, cancellation: Cancellation): Promise<PortResult<Output>> {
    if (cancellation.signal.aborted) {
      return { ok: false, error: { code: 'CANCELLED', message: '操作已取消。', retryable: true } };
    }
    const fixture = this.fixtures.find((item) => item.matches(input));
    return fixture
      ? structuredClone(fixture.result)
      : { ok: false, error: { code: 'MOCK_FIXTURE_MISSING', message: '没有匹配的 Fixture。', retryable: false } };
  }
}
