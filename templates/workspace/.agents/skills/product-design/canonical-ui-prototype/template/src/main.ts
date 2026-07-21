import './psp-app';
import './state-gallery';
import './mockcase-switcher';
import './inconsistency-annotator';

async function enableMocking(): Promise<void> {
  if (!import.meta.env.DEV) {
    return;
  }

  const { worker } = await import('./mocks/browser');
  await worker.start({
    onUnhandledRequest: 'bypass',
  });
}

async function bootstrapReview(): Promise<void> {
  try {
    await enableMocking();
  } catch (error: unknown) {
    console.error('MSW 启动失败，原型仍将继续渲染。', error);
  }
  if (window.location.pathname === '/__review/components') {
    document.querySelector('psp-app')?.replaceWith(document.createElement('psp-state-gallery'));
  } else if (new URLSearchParams(window.location.search).get('mockcase') !== '0') {
    document.body.append(document.createElement('mockcase-switcher'));
  }
}

void bootstrapReview();
