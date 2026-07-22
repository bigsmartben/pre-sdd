import './psp-app';
import './state-gallery';
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
    try {
      const loadPlugin = import.meta.env.DEV && globalThis.__pspMockcasePluginLoaderForTest
        ? globalThis.__pspMockcasePluginLoaderForTest
        : () => import('./mockcase-switcher');
      await loadPlugin();
      if (document.querySelectorAll('mockcase-switcher').length === 0) {
        document.body.append(document.createElement('mockcase-switcher'));
      }
    } catch (error: unknown) {
      document.documentElement.setAttribute('data-mockcase-plugin-error', 'true');
      window.dispatchEvent(new CustomEvent('psp:mockcase-error', {
        detail: {
          transactionId: 'plugin-load',
          activeCaseIds: [],
          code: 'AIH_MOCKCASE_PLUGIN_FAILED',
          message: error instanceof Error ? error.message : 'MockCase Review Plugin 加载失败',
          effectResults: [],
        },
      }));
      console.error('MockCase Review Plugin 加载失败。', error);
    }
  }
}

void bootstrapReview();

declare global {
  var __pspMockcasePluginLoaderForTest: (() => Promise<unknown>) | undefined;
}
