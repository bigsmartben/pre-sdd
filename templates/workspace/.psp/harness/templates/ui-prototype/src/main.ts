import './psp-app';

async function enableMocking(): Promise<void> {
  if (!import.meta.env.DEV) {
    return;
  }

  const { worker } = await import('./mocks/browser');
  await worker.start({
    onUnhandledRequest: 'bypass',
  });
}

enableMocking().catch((error: unknown) => {
  console.error('MSW 启动失败，原型仍将继续渲染。', error);
});

