import { delay, http, HttpResponse } from 'msw';

export const handlers = [
  http.get('/api/spec-preview', async ({ request }) => {
    await delay(450);

    const mode = new URL(request.url).searchParams.get('mode');
    const behaviorId = mode === 'error' ? 'MOCK-002' : 'MOCK-001';
    if (Array.isArray(globalThis.__pspMockBehaviorIds) && !globalThis.__pspMockBehaviorIds.includes(behaviorId)) {
      return HttpResponse.json(
        { message: `Mock Behavior 未安装：${behaviorId}` },
        { status: 409 },
      );
    }
    if (mode === 'error') {
      return HttpResponse.json(
        { message: '这是由 MSW 生成的可恢复错误状态。' },
        { status: 503 },
      );
    }

    return HttpResponse.json({
      message: 'Mock 契约已响应，Success 状态可被验证。',
    });
  }),
];
