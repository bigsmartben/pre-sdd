import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import playwright from '@playwright/test';
import { createServer } from 'vite';
import { artifactPaths, loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const { chromium } = playwright;
const require = createRequire(process.env.PRE_SDD_RUNTIME_ENTRY || import.meta.url);
const json = process.argv.includes('--json');
const blockers = [];
const blockerKeys = new Set();
const evidence = [];
const loadedAssets = new Set();
const usedAssetTargets = new Map();
let server;
let browser;

function block(code, message, location) {
  const key = [code, message, location || ''].join('|');
  if (blockerKeys.has(key)) return;
  blockerKeys.add(key);
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

function selectorForId(id) {
  return [
    'data-screen-id',
    'data-component-id',
    'data-control-id',
    'data-state-id',
    'data-component-state',
  ].map((attribute) => '[' + attribute + '="' + id + '"]').join(',');
}

function locatorForId(page, id) {
  return page.locator(selectorForId(id));
}

function stateSelector(model, id) {
  const state = model.states.find((item) => item.id === id);
  return state?.scope === 'workflow'
    ? '[data-state-id="' + id + '"]'
    : '[data-component-state="' + id + '"]';
}

function controlsForScreen(model, screen) {
  const componentIds = new Set(screen.componentIds);
  return model.controls.filter((control) => componentIds.has(control.componentId));
}

function allowedRequest(value, base) {
  const url = new URL(value);
  return url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === new URL(base).origin;
}

async function guardedPage(viewport, base) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const explicitlyBlocked = new Set();
  await context.route('**/*', async (route) => {
    const value = route.request().url();
    if (allowedRequest(value, base)) {
      await route.continue();
      return;
    }
    explicitlyBlocked.add(value);
    block('AIH_CANONICAL_UI_NETWORK_FAILED', '禁止外部网络请求：' + value, viewport.id);
    await route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('console', (message) => {
    const text = message.text();
    // 浏览器会把预期的 HTTP 错误响应也写成资源加载日志；网络与资源由独立门禁负责。
    if (message.type() === 'error' && !text.startsWith('Failed to load resource:')) {
      block('AIH_CANONICAL_UI_CONSOLE_FAILED', '浏览器控制台错误：' + text, page.url() || viewport.id);
    }
  });
  page.on('pageerror', (error) => block('AIH_CANONICAL_UI_CONSOLE_FAILED', '页面异常：' + error.message, page.url() || viewport.id));
  page.on('response', (response) => {
    const resourceType = response.request().resourceType();
    if (response.status() >= 400 && ['document', 'stylesheet', 'image', 'font', 'script', 'media', 'manifest'].includes(resourceType)) {
      block('AIH_CANONICAL_UI_NETWORK_FAILED', '资源响应失败：' + response.status() + ' ' + response.url(), page.url() || viewport.id);
    }
  });
  page.on('requestfailed', (request) => {
    if (explicitlyBlocked.has(request.url())) return;
    block('AIH_CANONICAL_UI_NETWORK_FAILED', '资源请求失败：' + request.url() + ' · ' + (request.failure()?.errorText || 'unknown'), page.url() || viewport.id);
  });
  return { context, page };
}

async function verifyBaseSemantics(page, model, route) {
  const screen = model.screens.find((item) => item.id === route.screenId);
  if (!screen) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '路由引用未知 Screen：' + route.screenId, route.path);
    return null;
  }
  if (await page.locator('[data-screen-id="' + screen.id + '"]').count() === 0) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '路由未渲染声明的 data-screen-id：' + screen.id, route.path);
  }
  for (const stateId of screen.stateIds) {
    if (await page.locator('[data-state-id="' + stateId + '"]').count() === 0) {
      block('AIH_CANONICAL_UI_RUNTIME_FAILED', '缺少 Wireflow data-state-id：' + stateId, route.path);
    }
  }
  for (const componentId of screen.componentIds) {
    if (await page.locator('[data-component-id="' + componentId + '"]').count() === 0) {
      block('AIH_CANONICAL_UI_RUNTIME_FAILED', '缺少 data-component-id：' + componentId, route.path);
    }
  }
  for (const control of controlsForScreen(model, screen)) {
    const locator = page.locator('[data-control-id="' + control.id + '"]');
    if (await locator.count() === 0) {
      block('AIH_CANONICAL_UI_RUNTIME_FAILED', '缺少 data-control-id：' + control.id, route.path);
      continue;
    }
    const accessibleName = await locator.first().evaluate((element) =>
      element.getAttribute('aria-label') || element.textContent?.trim() || element.getAttribute('value') || '',
    );
    if (!accessibleName) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件缺少可访问名称：' + control.id, route.path);
  }
  if (await page.locator('[data-state-id][data-component-state]').count() > 0) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '同一页面元素不得混用流程状态与组件局部状态。', route.path);
  }
  return screen;
}

async function verifyTarget(page, id, assertionId) {
  const locator = locatorForId(page, id);
  if (await locator.count() === 0) {
    block('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标不存在：' + id, assertionId);
    return null;
  }
  return locator.first();
}

async function runVisualAssertions(page, model, routeId, viewport, scenarioId = null) {
  const assertions = model.visualAssertions.filter((assertion) => (
    assertion.routeId === routeId
    && assertion.viewportIds.includes(viewport.id)
    && (scenarioId ? assertion.scenarioId === scenarioId : !assertion.scenarioId)
  ));
  for (const assertion of assertions) {
    for (const check of assertion.checks) {
      if (check.kind === 'document-no-horizontal-overflow') {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        if (overflow) block('AIH_CANONICAL_UI_VISUAL_FAILED', '视口产生水平溢出：' + viewport.id, assertion.id);
        continue;
      }
      if (check.kind === 'elements-no-overlap') {
        const boxes = [];
        for (const id of check.targetIds) {
          const target = await verifyTarget(page, id, assertion.id);
          if (target) boxes.push({ id, box: await target.boundingBox() });
        }
        for (let left = 0; left < boxes.length; left += 1) {
          for (let right = left + 1; right < boxes.length; right += 1) {
            const a = boxes[left];
            const b = boxes[right];
            if (!a.box || !b.box) continue;
            const width = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
            const height = Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
            if (width > 0.5 && height > 0.5) block('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标发生重叠：' + a.id + ' / ' + b.id, assertion.id);
          }
        }
        continue;
      }
      if (check.kind === 'computed-style') {
        const target = await verifyTarget(page, check.targetId, assertion.id);
        if (!target) continue;
        const actual = await target.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), check.property);
        if (actual !== check.expected) block('AIH_CANONICAL_UI_VISUAL_FAILED', '计算样式不匹配：' + check.targetId + ' / ' + check.property + '，实际为 ' + actual, assertion.id);
        continue;
      }
      for (const id of check.targetIds) {
        const target = await verifyTarget(page, id, assertion.id);
        if (!target) continue;
        if (check.kind === 'element-visible' && !await target.isVisible()) {
          block('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标不可见：' + id, assertion.id);
        } else if (check.kind === 'element-in-viewport') {
          const box = await target.boundingBox();
          if (!box || box.x < -0.5 || box.y < -0.5 || box.x + box.width > viewport.width + 0.5 || box.y + box.height > viewport.height + 0.5) {
            block('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标超出视口：' + id, assertion.id);
          }
        } else if (check.kind === 'text-no-clipping') {
          const clipped = await target.evaluate((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
          if (clipped) block('AIH_CANONICAL_UI_VISUAL_FAILED', '文本发生裁切：' + id, assertion.id);
        } else if (check.kind === 'text-max-lines') {
          const lines = await target.evaluate((element) => {
            const style = getComputedStyle(element);
            const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
            return element.getBoundingClientRect().height / lineHeight;
          });
          if (lines > check.maxLines + 0.15) block('AIH_CANONICAL_UI_VISUAL_FAILED', '文本行数超过声明上限：' + id, assertion.id);
        }
      }
    }
  }
}

async function runAccessibility(page, model, screen, axePath, location) {
  await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const result = await globalThis.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] },
    });
    return result.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
  });
  for (const violation of violations) {
    block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '自动无障碍规则失败：' + violation.id + ' · ' + violation.nodes + ' 个节点', location);
  }

  const controls = controlsForScreen(model, screen);
  const expected = new Set(controls.map((item) => item.id));
  const reached = new Set();
  const visibleFocus = new Set();
  await page.evaluate(() => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active instanceof HTMLElement) active.blur();
  });
  const maximumTabs = Math.max(12, expected.size * 4 + 8);
  for (let index = 0; index < maximumTabs && reached.size < expected.size; index += 1) {
    await page.keyboard.press('Tab');
    const active = await page.evaluate(() => {
      let element = document.activeElement;
      while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      const before = getComputedStyle(element, '::before');
      const after = getComputedStyle(element, '::after');
      const painted = [style, before, after].some((value) => (
        (value.outlineStyle !== 'none' && Number.parseFloat(value.outlineWidth) > 0)
        || value.boxShadow !== 'none'
      ));
      return {
        id: element.getAttribute('data-control-id'),
        focusVisible: element.matches(':focus-visible') && painted,
      };
    });
    if (active?.id && expected.has(active.id)) {
      reached.add(active.id);
      if (active.focusVisible) visibleFocus.add(active.id);
    }
  }

  for (const control of controls) {
    const locator = page.locator('[data-control-id="' + control.id + '"]').first();
    if (!reached.has(control.id)) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件无法通过键盘 Tab 到达：' + control.id, location);
    if (!visibleFocus.has(control.id)) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件缺少可见焦点：' + control.id, location);
    const box = await locator.boundingBox();
    if (!box || box.width < 24 || box.height < 24) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件触控目标小于 24×24 CSS 像素：' + control.id, location);
  }
}

async function observeAssets(page, model, base) {
  const resources = new Set(await page.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name)));
  for (const asset of model.assets) {
    const expectedUrl = new URL('/' + asset.path.slice('public/'.length), base).href;
    if (resources.has(expectedUrl)) loadedAssets.add(asset.id);
    if (!usedAssetTargets.has(asset.id)) usedAssetTargets.set(asset.id, new Set());
    for (const targetId of asset.usageTargetIds) {
      const target = locatorForId(page, targetId);
      if (await target.count() === 0) continue;
      const used = await target.first().evaluate((element, input) => {
        const candidates = [element, ...element.querySelectorAll('*')];
        const references = (candidate) => {
          for (const attribute of ['src', 'href', 'poster']) {
            const value = candidate.getAttribute(attribute);
            if (value && new URL(value, document.baseURI).href === input.expectedUrl) return true;
          }
          const srcset = candidate.getAttribute('srcset') || '';
          if (srcset.split(',').some((part) => {
            const value = part.trim().split(/\s+/)[0];
            return value && new URL(value, document.baseURI).href === input.expectedUrl;
          })) return true;
          const style = getComputedStyle(candidate);
          if ([style.backgroundImage, style.maskImage, style.webkitMaskImage].some((value) => value?.includes(input.expectedUrl))) return true;
          return candidate instanceof HTMLImageElement && candidate.currentSrc === input.expectedUrl && candidate.complete && candidate.naturalWidth > 0;
        };
        if (input.kind === 'font') return document.fonts.check('12px "' + input.fontFamily + '"');
        return candidates.some(references);
      }, { expectedUrl, kind: asset.kind, fontFamily: asset.fontFamily || '' });
      if (used) usedAssetTargets.get(asset.id).add(targetId);
    }
  }
}

async function verifyReducedMotion(page, model, routePath) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animated = await page.locator('[data-component-id]').evaluateAll((elements) => elements.some((element) => {
    const style = getComputedStyle(element);
    return style.animationName !== 'none' && style.animationDuration !== '0s';
  }));
  if (animated && model.motions.some((motion) => motion.reducedMotion)) {
    block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '减少动画偏好下仍存在组件动画。', routePath);
  }
}

async function capture(page, evidenceRoot, item) {
  const parts = [item.kind, item.viewportId, item.routeId, item.scenarioId].filter(Boolean);
  const screenshot = join(evidenceRoot, parts.join('-') + '.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  evidence.push({ ...item, screenshot });
}

try {
  const { project } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  if (stage?.status !== 'active') throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const model = await extractCanonicalUi(root, paths.authorityPath);
  const areaPath = repositoryFile(root, stage.root + '/' + stage.areas[paths.area].root);
  const evidenceRoot = await mkdtemp(join(tmpdir(), 'psp-canonical-ui-'));
  const axePath = require.resolve('axe-core/axe.min.js');
  server = await createServer({
    root: areaPath,
    configFile: false,
    cacheDir: join(evidenceRoot, 'vite-cache'),
    resolve: { alias: [
      { find: 'lit', replacement: require.resolve('lit') },
      { find: 'msw/browser', replacement: require.resolve('msw/browser') },
      { find: 'msw', replacement: require.resolve('msw') },
    ] },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer.address();
  const base = 'http://127.0.0.1:' + address.port;
  browser = await chromium.launch({ headless: true });

  for (const viewport of model.viewports) {
    for (const route of model.routes) {
      const { context, page } = await guardedPage(viewport, base);
      let screen = null;
      try {
        await page.goto(base + route.path, { waitUntil: 'networkidle' });
        screen = await verifyBaseSemantics(page, model, route);
        await runVisualAssertions(page, model, route.id, viewport);
        await observeAssets(page, model, base);
        await verifyReducedMotion(page, model, route.path);
        await capture(page, evidenceRoot, {
          kind: 'route',
          viewportId: viewport.id,
          routeId: route.id,
          initialStateIds: screen?.stateIds || [],
        });
        if (screen) await runAccessibility(page, model, screen, axePath, route.id + ' / ' + viewport.id);
      } catch (error) {
        block(error.code || 'AIH_CANONICAL_UI_RUNTIME_FAILED', error.message, route.id + ' / ' + viewport.id);
        try {
          await capture(page, evidenceRoot, { kind: 'route-failure', viewportId: viewport.id, routeId: route.id });
        } catch { /* Page may not have rendered. */ }
      } finally {
        await context.close();
      }
    }
  }

  for (const scenario of model.scenarios) {
    const route = model.routes.find((item) => item.id === scenario.routeId);
    for (const viewportId of scenario.viewportIds) {
      const viewport = model.viewports.find((item) => item.id === viewportId);
      if (!route || !viewport) continue;
      const { context, page } = await guardedPage(viewport, base);
      try {
        await page.goto(base + route.path, { waitUntil: 'networkidle' });
        const screen = await verifyBaseSemantics(page, model, route);
        for (const stateId of scenario.initialStateIds) {
          const initialState = page.locator(stateSelector(model, stateId)).first();
          if (await initialState.count() === 0 || !await initialState.isVisible()) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景缺少声明的初始状态：' + stateId, scenario.id + ' / ' + viewport.id);
          }
        }
        const before = await page.locator('[role="status"]').allTextContents();
        for (const eventId of scenario.eventIds) {
          const event = model.events.find((item) => item.id === eventId);
          const control = page.locator('[data-control-id="' + event.controlId + '"][data-event-id="' + event.id + '"]');
          if (await control.count() === 0) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景缺少事件控件：' + event.id, scenario.id);
            continue;
          }
          await control.click();
          for (const action of model.actions.filter((item) => item.eventId === eventId)) {
            for (const stateId of action.resultingStateIds) {
              try {
                await page.locator(stateSelector(model, stateId)).first().waitFor({ state: 'visible', timeout: 2500 });
              } catch {
                block('AIH_CANONICAL_UI_RUNTIME_FAILED', '动作未按序产生声明状态：' + action.id + ' → ' + stateId, scenario.id + ' / ' + viewport.id);
              }
            }
          }
        }
        const after = await page.locator('[role="status"]').allTextContents();
        if (JSON.stringify(before) === JSON.stringify(after)) block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景未产生可见状态变化。', scenario.id + ' / ' + viewport.id);
        for (const stateId of scenario.expectedStateIds) {
          const finalState = page.locator(stateSelector(model, stateId)).first();
          if (await finalState.count() === 0 || !await finalState.isVisible()) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景未达到声明的最终状态：' + stateId, scenario.id + ' / ' + viewport.id);
          }
        }
        await runVisualAssertions(page, model, route.id, viewport, scenario.id);
        await observeAssets(page, model, base);
        await capture(page, evidenceRoot, {
          kind: 'scenario',
          viewportId: viewport.id,
          routeId: route.id,
          scenarioId: scenario.id,
          initialStateIds: scenario.initialStateIds,
          eventIds: scenario.eventIds,
          finalStateIds: scenario.expectedStateIds,
        });
        if (screen) await runAccessibility(page, model, screen, axePath, scenario.id + ' / ' + viewport.id);
      } catch (error) {
        block(error.code || 'AIH_CANONICAL_UI_RUNTIME_FAILED', error.message, scenario.id + ' / ' + viewport.id);
        try {
          await capture(page, evidenceRoot, { kind: 'scenario-failure', viewportId: viewport.id, routeId: route.id, scenarioId: scenario.id });
        } catch { /* Page may not have rendered. */ }
      } finally {
        await context.close();
      }
    }
  }

  for (const asset of model.assets) {
    if (!loadedAssets.has(asset.id)) block('AIH_CANONICAL_UI_ASSET_FAILED', '资源未成功加载：' + asset.path, asset.id);
    for (const targetId of asset.usageTargetIds) {
      if (!usedAssetTargets.get(asset.id)?.has(targetId)) block('AIH_CANONICAL_UI_ASSET_FAILED', '资源未在声明目标中实际使用：' + asset.id + ' / ' + targetId, asset.path);
    }
  }
} catch (error) {
  block(error.code || (String(error.message).includes('Executable') ? 'AIH_BROWSER_UNAVAILABLE' : 'AIH_CANONICAL_UI_RUNTIME_FAILED'), error.message);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

const result = { status: blockers.length === 0 ? 'PASS' : 'BLOCKED', blockers, evidence };
if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Canonical UI Prototype 浏览器验收通过；证据位于操作系统临时目录。');
else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
if (result.status !== 'PASS') process.exitCode = 1;
