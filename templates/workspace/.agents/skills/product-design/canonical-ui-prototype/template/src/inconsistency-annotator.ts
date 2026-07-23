type IssueType = 'position-size' | 'text' | 'interaction' | 'visual';
type FeedbackCategory = 'behavior' | 'visual-input' | 'implementation';
type FeedbackRoute = 'use-cases' | 'visual-spec' | 'canonical-ui-prototype';

type Point = {
  x: number;
  y: number;
};

type SelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type Marker = {
  id: number;
  pageKey: string;
  pageX: number;
  pageY: number;
  width: number;
  height: number;
  target: string;
  type?: IssueType;
};

type Html2Canvas = (
  element: HTMLElement,
  options: {
    allowTaint: boolean;
    backgroundColor: string;
    height: number;
    ignoreElements: (element: Element) => boolean;
    logging: boolean;
    scale: number;
    scrollX: number;
    scrollY: number;
    useCORS: boolean;
    width: number;
    windowHeight: number;
    windowWidth: number;
    x: number;
    y: number;
  },
) => Promise<HTMLCanvasElement>;

const ISSUE_LABELS: Record<IssueType, string> = {
  'position-size': '位置／尺寸',
  text: '文字错误',
  interaction: '交互错误',
  visual: '看起来不一样',
};

const FEEDBACK_ROUTING: Record<IssueType, { category: FeedbackCategory; routedTo: FeedbackRoute; label: string }> = {
  interaction: { category: 'behavior', routedTo: 'use-cases', label: '行为问题 → UC' },
  visual: { category: 'visual-input', routedTo: 'visual-spec', label: '视觉输入问题 → Visual Spec' },
  'position-size': { category: 'implementation', routedTo: 'canonical-ui-prototype', label: '实现偏差 → UI HTML' },
  text: { category: 'implementation', routedTo: 'canonical-ui-prototype', label: '实现偏差 → UI HTML' },
};

const MINIMUM_SELECTION_SIZE = 8;

class InconsistencyAnnotator extends HTMLElement {
  private markers: Marker[] = [];
  private nextMarkerId = 1;
  private selecting = false;
  private activeMarkerId?: number;
  private dragStart?: Point;
  private captureLayer?: HTMLElement;
  private draftBox?: HTMLElement;
  private markerLayer?: HTMLElement;
  private typePicker?: HTMLElement;
  private startButton?: HTMLButtonElement;
  private copyButton?: HTMLButtonElement;
  private downloadButton?: HTMLButtonElement;
  private statusNode?: HTMLElement;
  private currentPageKey = '';
  private pageObserver?: MutationObserver;
  private pageRefreshQueued = false;

  private readonly schedulePageRefresh = (): void => {
    if (this.pageRefreshQueued) return;
    this.pageRefreshQueued = true;
    queueMicrotask(() => {
      this.pageRefreshQueued = false;
      this.refreshPageScope();
    });
  };

  private readonly beginSelection = (): void => {
    if (!this.captureLayer || !this.startButton) return;
    this.selecting = true;
    this.activeMarkerId = undefined;
    this.typePicker?.classList.remove('is-active');
    this.captureLayer.classList.add('is-active');
    this.startButton.textContent = '正在框选…';
    document.documentElement.classList.add('ia-is-selecting');
    this.setStatus('拖动鼠标框选问题区域；按 Esc 可取消。');
    window.addEventListener('keydown', this.handleEscape);
  };

  private readonly handleEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.finishSelectionMode();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (!this.selecting || !this.captureLayer) return;
    this.captureLayer.setPointerCapture(event.pointerId);
    this.dragStart = { x: event.clientX, y: event.clientY };
    this.updateDraftBox(this.dragStart, this.dragStart);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (!this.dragStart) return;
    this.updateDraftBox(this.dragStart, { x: event.clientX, y: event.clientY });
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (!this.dragStart || !this.captureLayer) return;
    const rect = this.normalizedRect(this.dragStart, { x: event.clientX, y: event.clientY });
    this.captureLayer.releasePointerCapture(event.pointerId);
    this.dragStart = undefined;
    this.hideDraftBox();

    if (rect.width < MINIMUM_SELECTION_SIZE || rect.height < MINIMUM_SELECTION_SIZE) {
      this.setStatus('框选范围太小，请重新拖动框选。');
      return;
    }

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const marker: Marker = {
      id: this.nextMarkerId,
      pageKey: this.currentPageKey,
      pageX: rect.left + window.scrollX,
      pageY: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
      target: this.describeTarget(centerX, centerY),
    };
    this.nextMarkerId += 1;
    this.markers.push(marker);
    this.activeMarkerId = marker.id;
    this.finishSelectionMode();
    this.renderMarkers();
    this.openTypePicker(marker);
  };

  private readonly cancelDraft = (): void => {
    this.dragStart = undefined;
    this.hideDraftBox();
  };

  private readonly chooseIssueType = (event: Event): void => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-issue-type]')
      : null;
    const issueType = target?.dataset.issueType as IssueType | undefined;
    const marker = this.markers.find((item) => item.id === this.activeMarkerId);
    if (!issueType || !marker) return;

    marker.type = issueType;
    this.activeMarkerId = undefined;
    this.typePicker?.classList.remove('is-active');
    this.renderMarkers();
    this.refreshControls();
    this.setStatus(`已标记 #${marker.id} ${ISSUE_LABELS[issueType]}，可以继续框选或复制。`);
  };

  private readonly undoLastMarker = (): void => {
    let markerIndex = -1;
    for (let index = this.markers.length - 1; index >= 0; index -= 1) {
      if (this.markers[index].pageKey === this.currentPageKey) {
        markerIndex = index;
        break;
      }
    }
    if (markerIndex < 0) return;
    const [marker] = this.markers.splice(markerIndex, 1);
    if (marker.id === this.activeMarkerId) {
      this.activeMarkerId = undefined;
      this.typePicker?.classList.remove('is-active');
    }
    this.renderMarkers();
    this.refreshControls();
    this.setStatus('已撤销上一个标记。');
  };

  private readonly clearMarkers = (): void => {
    this.markers = this.markers.filter((marker) => marker.pageKey !== this.currentPageKey);
    this.activeMarkerId = undefined;
    this.typePicker?.classList.remove('is-active');
    this.renderMarkers();
    this.refreshControls();
    this.setStatus('已清空当前页面的全部标记。');
  };

  private readonly copyAnnotatedScreenshot = async (): Promise<void> => {
    const markers = this.currentPageMarkers()
      .filter((marker): marker is Marker & { type: IssueType } => Boolean(marker.type));
    if (markers.length === 0 || !this.copyButton) return;

    if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      this.setStatus('当前浏览器不能直接写入图片剪贴板，请点击“下载图片”。');
      return;
    }

    this.copyButton.disabled = true;
    this.copyButton.textContent = '复制中…';
    this.setStatus('正在生成带标记的当前页面截图。');

    const image = this.captureViewport(markers);
    void image.catch(() => undefined);
    try {
      const text = this.buildPlainText(markers);
      const clipboardData = {
        'image/png': image,
        'text/plain': Promise.resolve(new Blob([text], { type: 'text/plain' })),
      };
      await navigator.clipboard.write([new ClipboardItem(clipboardData)]);

      this.copyButton.textContent = '已复制';
      this.setStatus('已复制带标记截图，现在可以直接粘贴发送给 AI。');
      window.setTimeout(() => {
        if (this.copyButton) this.copyButton.textContent = '复制';
        this.refreshControls();
      }, 1800);
    } catch (error: unknown) {
      this.copyButton.textContent = '复制';
      this.refreshControls();
      const denied = error instanceof DOMException && error.name === 'NotAllowedError';
      const message = denied
        ? '浏览器拒绝写入剪贴板，请允许权限后重试'
        : (error instanceof Error ? error.message : '未知错误');
      this.setStatus(`复制失败：${message}；也可以点击“下载图片”。`);
    }
  };

  private readonly downloadAnnotatedScreenshot = async (): Promise<void> => {
    const markers = this.currentPageMarkers()
      .filter((marker): marker is Marker & { type: IssueType } => Boolean(marker.type));
    if (markers.length === 0 || !this.downloadButton) return;

    this.downloadButton.disabled = true;
    this.downloadButton.textContent = '生成中…';
    this.setStatus('正在生成带标记的 PNG 图片。');

    try {
      const image = await this.captureViewport(markers);
      const href = URL.createObjectURL(image);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      link.href = href;
      link.download = `ui-inconsistency-${timestamp}.png`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      this.setStatus('已下载带标记图片，可以作为文件发送给 AI。');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : '未知错误';
      this.setStatus(`下载失败：${message}`);
    } finally {
      this.downloadButton.textContent = '下载图片';
      this.refreshControls();
    }
  };

  private readonly renderMarkers = (): void => {
    if (!this.markerLayer) return;
    const markers = this.currentPageMarkers();
    this.markerLayer.innerHTML = markers.map((marker) => {
      const label = marker.type ? ISSUE_LABELS[marker.type] : '待选择类型';
      return `
        <div class="ia-marker" style="left:${marker.pageX - window.scrollX}px;top:${marker.pageY - window.scrollY}px;width:${marker.width}px;height:${marker.height}px">
          <span class="ia-marker-label">#${marker.id} ${label}</span>
        </div>
      `;
    }).join('');
    const count = this.querySelector<HTMLElement>('.ia-marker-count');
    if (count) count.textContent = String(markers.length);
  };

  connectedCallback(): void {
    this.setAttribute('data-review-tool', 'inconsistency-annotator');
    this.renderTool();
    this.currentPageKey = this.resolvePageKey();
    this.pageObserver = new MutationObserver(this.schedulePageRefresh);
    this.pageObserver.observe(document.body, {
      attributeFilter: ['aria-hidden', 'class', 'data-screen-id', 'hidden', 'style'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    window.addEventListener('scroll', this.renderMarkers, { passive: true });
    window.addEventListener('resize', this.renderMarkers);
    window.addEventListener('popstate', this.schedulePageRefresh);
    window.addEventListener('hashchange', this.schedulePageRefresh);
  }

  disconnectedCallback(): void {
    window.removeEventListener('scroll', this.renderMarkers);
    window.removeEventListener('resize', this.renderMarkers);
    window.removeEventListener('popstate', this.schedulePageRefresh);
    window.removeEventListener('hashchange', this.schedulePageRefresh);
    window.removeEventListener('keydown', this.handleEscape);
    this.pageObserver?.disconnect();
    this.pageObserver = undefined;
    document.documentElement.classList.remove('ia-is-selecting');
  }

  private renderTool(): void {
    this.innerHTML = `
      <style>
        .ia-is-selecting, .ia-is-selecting * { user-select: none !important; }
        inconsistency-annotator { position: relative; z-index: 2147483000; font-family: "HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
        .ia-toolbar {
          position: fixed; z-index: 2147483600; top: 20px; right: 20px; display: grid; gap: 10px;
          width: 252px; padding: 14px; border: 1px solid rgba(255,255,255,.82); border-radius: 18px;
          color: #202124; background: rgba(255,255,255,.96); box-shadow: 0 18px 55px rgba(24,25,31,.28);
          backdrop-filter: blur(18px);
        }
        .ia-toolbar-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .ia-toolbar-title { margin: 0; font-size: 15px; font-weight: 900; letter-spacing: -.01em; }
        .ia-marker-count { min-width: 28px; padding: 3px 8px; border-radius: 999px; color: #fff; background: #e5484d; font-size: 11px; font-weight: 800; text-align: center; }
        .ia-toolbar-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
        .ia-button {
          min-height: 40px; padding: 0 12px; border: 0; border-radius: 12px; color: #fff; background: #202124;
          font: inherit; font-size: 13px; font-weight: 800; cursor: pointer;
        }
        .ia-button:hover { background: #34363a; }
        .ia-button:focus-visible, .ia-type-button:focus-visible { outline: 3px solid #ffbd2e; outline-offset: 2px; }
        .ia-button-primary { background: #e5484d; }
        .ia-button-primary:hover { background: #d93d42; }
        .ia-button-secondary { color: #444; background: #f0f1f3; }
        .ia-button-secondary:hover { background: #e5e7ea; }
        .ia-button:disabled { cursor: not-allowed; opacity: .42; }
        .ia-toolbar-secondary { display: flex; justify-content: flex-end; gap: 6px; }
        .ia-link-button { padding: 4px 6px; border: 0; color: #666; background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
        .ia-link-button:hover { color: #e5484d; }
        .ia-status { min-height: 18px; margin: 0; color: #676b73; font-size: 11px; line-height: 1.55; }
        .ia-capture-layer { position: fixed; z-index: 2147483200; inset: 0; display: none; cursor: crosshair; touch-action: none; }
        .ia-capture-layer.is-active { display: block; background: rgba(229,72,77,.035); }
        .ia-draft-box { position: fixed; display: none; border: 3px solid #e5484d; background: rgba(229,72,77,.11); box-shadow: 0 0 0 1px rgba(255,255,255,.9) inset; pointer-events: none; }
        .ia-marker-layer { position: fixed; z-index: 2147483250; inset: 0; pointer-events: none; }
        .ia-marker { position: fixed; border: 3px solid #e5484d; background: rgba(229,72,77,.09); box-shadow: 0 0 0 1px rgba(255,255,255,.9) inset, 0 6px 18px rgba(96,19,24,.16); }
        .ia-marker-label { position: absolute; left: -3px; top: -31px; max-width: 240px; height: 28px; display: flex; align-items: center; padding: 0 9px; border-radius: 8px 8px 8px 0; color: #fff; background: #e5484d; font-size: 12px; font-weight: 900; white-space: nowrap; }
        .ia-type-picker {
          position: fixed; z-index: 2147483500; display: none; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 8px;
          width: min(344px, calc(100vw - 24px)); padding: 12px; border: 1px solid #e3e4e7; border-radius: 16px;
          background: #fff; box-shadow: 0 18px 50px rgba(24,25,31,.28);
        }
        .ia-type-picker.is-active { display: grid; }
        .ia-type-picker-title { grid-column: 1 / -1; margin: 0 0 2px; color: #555; font-size: 12px; font-weight: 800; }
        .ia-type-button { min-height: 42px; padding: 0 10px; border: 1px solid #e3e4e7; border-radius: 11px; color: #25262a; background: #f8f8f9; font: inherit; font-size: 12px; font-weight: 800; cursor: pointer; }
        .ia-type-button:hover { border-color: #e5484d; color: #c9343a; background: #fff4f4; }
        @media (max-width: 560px) {
          .ia-toolbar { top: 12px; right: 12px; width: min(252px, calc(100vw - 24px)); }
          .ia-type-picker { left: 12px !important; width: calc(100vw - 24px); }
        }
      </style>
      <div class="ia-marker-layer" aria-hidden="true"></div>
      <div class="ia-capture-layer" aria-label="拖动框选不一致区域">
        <div class="ia-draft-box"></div>
      </div>
      <div class="ia-type-picker" role="dialog" aria-modal="true" aria-label="选择问题类型">
        <p class="ia-type-picker-title">选择问题类型</p>
        <button class="ia-type-button" type="button" data-issue-type="position-size">位置／尺寸</button>
        <button class="ia-type-button" type="button" data-issue-type="text">文字错误</button>
        <button class="ia-type-button" type="button" data-issue-type="interaction">交互错误</button>
        <button class="ia-type-button" type="button" data-issue-type="visual">看起来不一样</button>
      </div>
      <aside class="ia-toolbar" aria-label="不一致标记工具">
        <div class="ia-toolbar-header">
          <h2 class="ia-toolbar-title">不一致标记工具</h2>
          <span class="ia-marker-count" aria-label="已标记数量">0</span>
        </div>
        <div class="ia-toolbar-actions">
          <button class="ia-button ia-button-primary" type="button" data-action="start">开始框选</button>
          <button class="ia-button" type="button" data-action="copy" disabled>复制</button>
        </div>
        <div class="ia-toolbar-secondary">
          <button class="ia-link-button" type="button" data-action="download" disabled>下载图片</button>
          <button class="ia-link-button" type="button" data-action="undo" disabled>撤销上一个</button>
          <button class="ia-link-button" type="button" data-action="clear" disabled>清空</button>
        </div>
        <p class="ia-status" aria-live="polite">点击“开始框选”，然后拖动鼠标。</p>
      </aside>
    `;

    this.captureLayer = this.querySelector<HTMLElement>('.ia-capture-layer') ?? undefined;
    this.draftBox = this.querySelector<HTMLElement>('.ia-draft-box') ?? undefined;
    this.markerLayer = this.querySelector<HTMLElement>('.ia-marker-layer') ?? undefined;
    this.typePicker = this.querySelector<HTMLElement>('.ia-type-picker') ?? undefined;
    this.startButton = this.querySelector<HTMLButtonElement>('[data-action="start"]') ?? undefined;
    this.copyButton = this.querySelector<HTMLButtonElement>('[data-action="copy"]') ?? undefined;
    this.downloadButton = this.querySelector<HTMLButtonElement>('[data-action="download"]') ?? undefined;
    this.statusNode = this.querySelector<HTMLElement>('.ia-status') ?? undefined;

    this.startButton?.addEventListener('click', this.beginSelection);
    this.copyButton?.addEventListener('click', this.copyAnnotatedScreenshot);
    this.downloadButton?.addEventListener('click', this.downloadAnnotatedScreenshot);
    this.querySelector<HTMLButtonElement>('[data-action="undo"]')?.addEventListener('click', this.undoLastMarker);
    this.querySelector<HTMLButtonElement>('[data-action="clear"]')?.addEventListener('click', this.clearMarkers);
    this.typePicker?.addEventListener('click', this.chooseIssueType);
    this.captureLayer?.addEventListener('pointerdown', this.handlePointerDown);
    this.captureLayer?.addEventListener('pointermove', this.handlePointerMove);
    this.captureLayer?.addEventListener('pointerup', this.handlePointerUp);
    this.captureLayer?.addEventListener('pointercancel', this.cancelDraft);
    this.refreshControls();
  }

  private finishSelectionMode(): void {
    this.selecting = false;
    this.captureLayer?.classList.remove('is-active');
    document.documentElement.classList.remove('ia-is-selecting');
    if (this.startButton) this.startButton.textContent = '开始框选';
    window.removeEventListener('keydown', this.handleEscape);
  }

  private currentPageMarkers(): Marker[] {
    return this.markers.filter((marker) => marker.pageKey === this.currentPageKey);
  }

  private refreshPageScope(): void {
    const pageKey = this.resolvePageKey();
    if (pageKey === this.currentPageKey) return;

    this.currentPageKey = pageKey;
    this.cancelDraft();
    this.finishSelectionMode();
    this.activeMarkerId = undefined;
    this.typePicker?.classList.remove('is-active');
    this.renderMarkers();
    this.refreshControls();
    const count = this.currentPageMarkers().length;
    this.setStatus(count > 0
      ? `页面已切换，已恢复当前页面的 ${count} 个标记。`
      : '页面已切换；当前页面还没有标记。');
  }

  private resolvePageKey(): string {
    const url = new URL(window.location.href);
    url.searchParams.delete('annotate');
    url.searchParams.delete('psp-case');
    url.searchParams.delete('psp-cases');
    const screenIds = Array.from(document.querySelectorAll<HTMLElement>('[data-screen-id]'))
      .filter((element) => !this.contains(element) && element.getClientRects().length > 0)
      .filter((element) => element.getAttribute('aria-hidden') !== 'true')
      .map((element) => element.dataset.screenId ?? '')
      .filter(Boolean)
      .sort();
    return `${url.pathname}${url.search}${url.hash}::${screenIds.join(',')}`;
  }

  private openTypePicker(marker: Marker): void {
    if (!this.typePicker) return;
    const left = marker.pageX - window.scrollX;
    const top = marker.pageY - window.scrollY;
    const width = Math.min(344, window.innerWidth - 24);
    const pickerLeft = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    const below = top + marker.height + 10;
    const pickerTop = below + 150 < window.innerHeight ? below : Math.max(12, top - 160);
    this.typePicker.style.left = `${pickerLeft}px`;
    this.typePicker.style.top = `${pickerTop}px`;
    this.typePicker.classList.add('is-active');
    this.typePicker.querySelector<HTMLButtonElement>('[data-issue-type]')?.focus();
    this.setStatus('请选择这个框选区域的问题类型。');
  }

  private async captureViewport(markers: Array<Marker & { type: IssueType }>): Promise<Blob> {
    const html2canvas = await this.loadScreenshotRenderer();
    const scale = Math.min(Math.max(window.devicePixelRatio, 1), 2);
    const previousVisibility = this.style.visibility;
    this.style.visibility = 'hidden';
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    let screenshot: HTMLCanvasElement;
    try {
      screenshot = await html2canvas(document.documentElement, {
        allowTaint: false,
        backgroundColor: '#ffffff',
        height: window.innerHeight,
        ignoreElements: (element) => element.hasAttribute('data-review-tool'),
        logging: false,
        scale,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        useCORS: true,
        width: window.innerWidth,
        windowHeight: window.innerHeight,
        windowWidth: window.innerWidth,
        x: window.scrollX,
        y: window.scrollY,
      });
    } finally {
      this.style.visibility = previousVisibility;
    }

    const canvasScale = screenshot.width / window.innerWidth;
    const legendHeight = 54 + markers.length * 24;
    const output = document.createElement('canvas');
    output.width = screenshot.width;
    output.height = screenshot.height + Math.round(legendHeight * canvasScale);
    const context = output.getContext('2d');
    if (!context) throw new Error('无法创建截图画布');

    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, output.width, output.height);
    context.drawImage(screenshot, 0, 0);
    context.scale(canvasScale, canvasScale);
    this.drawMarkers(context, markers);
    this.drawLegend(context, markers, legendHeight);

    return await new Promise<Blob>((resolve, reject) => {
      output.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('无法生成截图')),
        'image/png',
      );
    });
  }

  private drawMarkers(context: CanvasRenderingContext2D, markers: Array<Marker & { type: IssueType }>): void {
    context.lineWidth = 4;
    context.font = '800 14px "Microsoft YaHei", sans-serif';
    context.textBaseline = 'middle';

    for (const marker of markers) {
      const left = marker.pageX - window.scrollX;
      const top = marker.pageY - window.scrollY;
      context.fillStyle = 'rgba(229,72,77,.11)';
      context.fillRect(left, top, marker.width, marker.height);
      context.strokeStyle = '#e5484d';
      context.strokeRect(left, top, marker.width, marker.height);

      const label = `#${marker.id} ${ISSUE_LABELS[marker.type]}`;
      const labelWidth = context.measureText(label).width + 18;
      const labelTop = top >= 31 ? top - 29 : top + 3;
      context.fillStyle = '#e5484d';
      this.roundRect(context, left, labelTop, labelWidth, 27, 7);
      context.fill();
      context.fillStyle = '#fff';
      context.fillText(label, left + 9, labelTop + 13.5);
    }
  }

  private drawLegend(
    context: CanvasRenderingContext2D,
    markers: Array<Marker & { type: IssueType }>,
    legendHeight: number,
  ): void {
    const top = window.innerHeight;
    context.fillStyle = '#202124';
    context.fillRect(0, top, window.innerWidth, legendHeight);
    context.fillStyle = '#fff';
    context.font = '800 14px "Microsoft YaHei", sans-serif';
    context.textBaseline = 'top';
    context.fillText('不一致标记工具', 16, top + 10);
    context.fillStyle = '#c9cbd1';
    context.font = '12px "Microsoft YaHei", sans-serif';
    const page = `${window.location.href} · ${window.innerWidth} × ${window.innerHeight}`;
    context.fillText(this.truncateForCanvas(context, page, window.innerWidth - 32), 16, top + 31);

    markers.forEach((marker, index) => {
      const left = Math.round(marker.pageX);
      const markerTop = Math.round(marker.pageY);
      const width = Math.round(marker.width);
      const height = Math.round(marker.height);
      const line = `#${marker.id}  ${ISSUE_LABELS[marker.type]}  ·  ${FEEDBACK_ROUTING[marker.type].label}  ·  ${marker.target}  ·  x=${left}, y=${markerTop}, w=${width}, h=${height}`;
      context.fillStyle = '#fff';
      context.fillText(
        this.truncateForCanvas(context, line, window.innerWidth - 32),
        16,
        top + 54 + index * 24,
      );
    });
  }

  private buildPlainText(markers: Array<Marker & { type: IssueType }>): string {
    const heading = [
      '不一致标记工具',
      `页面：${window.location.href}`,
      `视口：${window.innerWidth} × ${window.innerHeight}`,
    ];
    const details = markers.map((marker) => [
      `#${marker.id} ${ISSUE_LABELS[marker.type]}`,
      `反馈分类：${FEEDBACK_ROUTING[marker.type].category}`,
      `路由到：${FEEDBACK_ROUTING[marker.type].routedTo}`,
      `区域：x=${Math.round(marker.pageX)}, y=${Math.round(marker.pageY)}, w=${Math.round(marker.width)}, h=${Math.round(marker.height)}`,
      `关联元素：${marker.target}`,
    ].join('\n'));
    return [...heading, '', ...details].join('\n');
  }

  private async loadScreenshotRenderer(): Promise<Html2Canvas> {
    if (window.html2canvas) return window.html2canvas;

    const source = '/vendor/html2canvas-1.4.1.min.js';
    let script = document.querySelector<HTMLScriptElement>(`script[src="${source}"]`);
    await new Promise<void>((resolve, reject) => {
      if (script?.dataset.loaded === 'true') {
        resolve();
        return;
      }
      if (!script) {
        script = document.createElement('script');
        script.src = source;
        script.async = true;
        document.head.append(script);
      }
      script.addEventListener('load', () => {
        if (script) script.dataset.loaded = 'true';
        resolve();
      }, { once: true });
      script.addEventListener('error', () => reject(new Error('本地截图组件加载失败')), { once: true });
    });

    if (!window.html2canvas) throw new Error('本地截图组件不可用');
    return window.html2canvas;
  }

  private describeTarget(x: number, y: number): string {
    const previousPointerEvents = this.style.pointerEvents;
    this.style.pointerEvents = 'none';
    const target = document.elementFromPoint(x, y);
    this.style.pointerEvents = previousPointerEvents;
    if (!target) return '未识别元素';

    let current: Element | null = target;
    while (current && current !== document.body) {
      const attributes = [
        ['data-component-asset', current.getAttribute('data-component-asset')],
        ['data-asset-binding', current.getAttribute('data-asset-binding')],
        ['data-control', current.getAttribute('data-control')],
        ['data-screen-id', current.getAttribute('data-screen-id')],
        ['data-state-id', current.getAttribute('data-state-id')],
      ].filter((entry): entry is [string, string] => Boolean(entry[1]));
      if (attributes.length > 0) {
        return attributes.map(([name, value]) => `[${name}="${value}"]`).join(' ');
      }
      current = current.parentElement;
    }

    if (target.id) return `#${target.id}`;
    const classes = Array.from(target.classList).slice(0, 2).join('.');
    return `${target.tagName.toLowerCase()}${classes ? `.${classes}` : ''}`;
  }

  private refreshControls(): void {
    const markers = this.currentPageMarkers();
    const readyToCopy = markers.length > 0 && markers.every((marker) => Boolean(marker.type));
    if (this.copyButton) this.copyButton.disabled = !readyToCopy;
    if (this.downloadButton) this.downloadButton.disabled = !readyToCopy;
    const empty = markers.length === 0;
    const undo = this.querySelector<HTMLButtonElement>('[data-action="undo"]');
    const clear = this.querySelector<HTMLButtonElement>('[data-action="clear"]');
    if (undo) undo.disabled = empty;
    if (clear) clear.disabled = empty;
  }

  private updateDraftBox(start: Point, end: Point): void {
    if (!this.draftBox) return;
    const rect = this.normalizedRect(start, end);
    Object.assign(this.draftBox.style, {
      display: 'block',
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  private hideDraftBox(): void {
    if (this.draftBox) this.draftBox.style.display = 'none';
  }

  private normalizedRect(start: Point, end: Point): SelectionRect {
    return {
      left: Math.min(start.x, end.x),
      top: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }

  private setStatus(message: string): void {
    if (this.statusNode) this.statusNode.textContent = message;
  }

  private truncateForCanvas(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    if (context.measureText(text).width <= maxWidth) return text;
    let truncated = text;
    while (truncated.length > 1 && context.measureText(`${truncated}…`).width > maxWidth) {
      truncated = truncated.slice(0, -1);
    }
    return `${truncated}…`;
  }

  private roundRect(
    context: CanvasRenderingContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
  ): void {
    context.beginPath();
    context.roundRect(x, y, width, height, radius);
  }
}

customElements.define('inconsistency-annotator', InconsistencyAnnotator);

if (new URLSearchParams(window.location.search).get('annotate') !== '0') {
  document.body.append(document.createElement('inconsistency-annotator'));
}

declare global {
  interface Window {
    html2canvas?: Html2Canvas;
  }

  interface HTMLElementTagNameMap {
    'inconsistency-annotator': InconsistencyAnnotator;
  }
}
