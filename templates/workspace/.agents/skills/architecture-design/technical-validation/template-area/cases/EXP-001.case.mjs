export const experiment = {
  id: 'EXP-001',
  requiredEnvironment: ['THIRD_PARTY_API_URL'],
  async run({ env, fetch, timeoutSignal }) {
    const endpoint = new URL(env.THIRD_PARTY_API_URL);
    if (endpoint.protocol !== 'https:') {
      return {
        status: 'failed',
        summary: '三方 API 验证只允许 HTTPS endpoint。',
        evidence: ['protocol=' + endpoint.protocol],
      };
    }

    const headers = { accept: 'application/json' };
    if (env.THIRD_PARTY_API_TOKEN) headers.authorization = 'Bearer ' + env.THIRD_PARTY_API_TOKEN;
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: timeoutSignal(10_000),
    });
    await response.body?.cancel();
    const passed = response.status >= 200 && response.status < 300;
    return {
      status: passed ? 'passed' : 'failed',
      summary: passed ? 'Endpoint 可达且返回成功状态。' : 'Endpoint 返回非成功状态。',
      evidence: [
        'httpStatus=' + response.status,
        'contentType=' + (response.headers.get('content-type') || 'unknown'),
      ],
    };
  },
};
