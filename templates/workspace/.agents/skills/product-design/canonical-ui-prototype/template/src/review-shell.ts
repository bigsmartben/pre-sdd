import { canonicalUi } from './spec/canonical-ui';

async function enableMocking(): Promise<void> {
  if (!import.meta.env.DEV) return;
  const { worker } = await import('./mocks/browser');
  await worker.start({ onUnhandledRequest: 'bypass' });
}

export interface ReviewExtensionDescriptor {
  id: string;
  apiVersion: 'psp.review-extension/v1';
  moduleUrl: string;
  integrity: `sha256:${string}`;
  configUrl?: string;
  configIntegrity?: `sha256:${string}`;
}

export interface ReviewHost {
  readonly apiVersion: 'psp.review-extension/v1';
  readonly document: Document;
  readonly location: Location;
  emit(type: string, detail: unknown): void;
}

export interface ReviewExtension {
  activate(host: ReviewHost): Promise<{ dispose(): void }>;
}

async function digest(bytes: ArrayBuffer): Promise<string> {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${[...new Uint8Array(value)].map((item) => item.toString(16).padStart(2, '0')).join('')}`;
}

async function verifiedBytes(url: string, integrity: string): Promise<ArrayBuffer> {
  const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  if (!response.ok) throw new Error(`Review Extension 请求失败：${response.status}`);
  const bytes = await response.arrayBuffer();
  if (await digest(bytes) !== integrity) throw new Error('Review Extension 完整性摘要不匹配。');
  return bytes;
}

async function activateExtensions(): Promise<void> {
  const descriptors = globalThis.__PSP_REVIEW_EXTENSIONS__;
  if (!descriptors || descriptors.length === 0) return;
  const seen = new Set<string>();
  const disposers: Array<() => void> = [];
  const host: ReviewHost = Object.freeze({
    apiVersion: 'psp.review-extension/v1',
    document,
    location: window.location,
    emit: (type: string, detail: unknown) => window.dispatchEvent(new CustomEvent(type, { detail })),
  });
  try {
    for (const descriptor of descriptors) {
      if (seen.has(descriptor.id)) throw new Error(`Review Extension ID 重复：${descriptor.id}`);
      seen.add(descriptor.id);
      if (descriptor.apiVersion !== host.apiVersion) throw new Error(`Review Extension API 不兼容：${descriptor.id}`);
      const bytes = await verifiedBytes(descriptor.moduleUrl, descriptor.integrity);
      const moduleUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
      try {
        const loaded = await import(/* @vite-ignore */ moduleUrl) as { default?: ReviewExtension; extension?: ReviewExtension };
        const extension = loaded.default ?? loaded.extension;
        if (!extension || typeof extension.activate !== 'function') throw new Error(`Review Extension 导出无效：${descriptor.id}`);
        const activated = await extension.activate(host);
        disposers.push(() => activated.dispose());
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
    }
  } catch (error) {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose();
      } catch {
        // Cleanup is best-effort; the original activation error remains authoritative.
      }
    }
    throw error;
  }
  window.addEventListener('pagehide', () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  }, { once: true });
}

function reviewEnabled(query: URLSearchParams): boolean {
  const policy = canonicalUi.reviewTools.activation;
  return query.get(policy.queryParameter) === policy.enabledValue;
}

async function activateBuiltInTools(): Promise<void> {
  await Promise.all([
    import('./inconsistency-annotator'),
    import('./interaction-branch-driver'),
  ]);
}

export async function bootstrapReviewShell(): Promise<void> {
  try {
    await enableMocking();
  } catch (error: unknown) {
    console.error('MSW 启动失败，原型仍将继续渲染。', error);
  }
  const query = new URLSearchParams(window.location.search);
  const enabled = reviewEnabled(query);
  if (query.has('__pspComponentContract') || query.has('__pspStateMatrix')) {
    if (!query.has('__pspComponentContract') || !query.has('__pspStateMatrix')) {
      document.querySelector('psp-product-router')?.replaceWith(
        Object.assign(document.createElement('main'), { textContent: 'Component Preview 参数不完整。' }),
      );
    } else {
      await import('./matrix-mount');
      document.querySelector('psp-product-router')?.replaceWith(document.createElement('psp-matrix-mount'));
    }
  } else if (enabled && window.location.pathname === '/__review/components') {
    await import('./state-gallery');
    document.querySelector('psp-product-router')?.replaceWith(document.createElement('psp-state-gallery'));
  }
  if (!enabled) return;
  await activateBuiltInTools();
  try {
    await activateExtensions();
  } catch (error: unknown) {
    document.documentElement.setAttribute('data-review-extension-error', 'true');
    window.dispatchEvent(new CustomEvent('psp:review-extension-error', {
      detail: { message: error instanceof Error ? error.message : 'Review Extension 加载失败' },
    }));
    console.error('Review Extension 加载失败。', error);
  }
}

declare global {
  var __PSP_REVIEW_EXTENSIONS__: readonly Readonly<ReviewExtensionDescriptor>[] | undefined;
}
