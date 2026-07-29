export function selectMatchingBehavior(behaviors, activeBehaviorIds, input, init, baseUrl) {
  const request = new Request(input, init);
  const url = new URL(request.url, baseUrl);
  const active = new Set(activeBehaviorIds);
  const matches = behaviors.filter((item) => {
    if (!active.has(item.id)) return false;
    if (item.request.method !== request.method || item.request.path !== url.pathname) return false;
    if (item.request.query && Object.entries(item.request.query)
      .some(([key, value]) => url.searchParams.get(key) !== value)) return false;
    if (item.request.headers && Object.entries(item.request.headers)
      .some(([key, value]) => request.headers.get(key) !== value)) return false;
    return true;
  });
  if (matches.length > 1) {
    throw Object.assign(
      new Error(`请求同时匹配多个 Behavior：${matches.map((item) => item.id).join(',')}`),
      { code: 'AIH_MOCKCASE_CONFLICT' },
    );
  }
  return matches[0] ?? null;
}
