import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import playwright from '@playwright/test';
import { createServer } from 'vite';
import { artifactPaths, loadProjectAndManifest, readStructured, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const { chromium } = playwright;
const require = createRequire(process.env.PRE_SDD_DEPENDENCY_ENTRY || process.env.PRE_SDD_RUNTIME_ENTRY || import.meta.url);
const json = process.argv.includes('--json');
const blockers = [];
const blockerKeys = new Set();
const evidence = [];
const loadedAssets = new Set();
const usedAssetTargets = new Map();
let server;
let browser;
let evidenceRoot;

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

function hasAccessibilityCheck(model, check) {
  return model.accessibility?.checks?.includes(check) === true;
}

function allowedRequest(value, base) {
  const url = new URL(value);
  return url.protocol === 'data:' || url.protocol === 'blob:' || url.origin === new URL(base).origin;
}

function areaFile(areaDirectory, path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw Object.assign(new Error('视觉证据路径必须位于 Canonical UI Prototype Area 内：' + String(path)), { code: 'AIH_VISUAL_SOURCE_INCOMPLETE' });
  }
  const target = resolve(areaDirectory, ...path.split('/'));
  if (target !== areaDirectory && !target.startsWith(areaDirectory + sep)) {
    throw Object.assign(new Error('视觉证据路径越出 Canonical UI Prototype Area：' + path), { code: 'AIH_VISUAL_SOURCE_INCOMPLETE' });
  }
  return target;
}

function imageDataUrl(path, content) {
  const mime = extname(path).toLowerCase() === '.svg' ? 'image/svg+xml' : 'image/png';
  return 'data:' + mime + ';base64,' + content.toString('base64');
}

async function loadParityEvidence(areaDirectory, model) {
  const baselines = new Map();
  const sourceScreenshots = new Map();
  const sources = new Map();
  for (const source of model.designSources) {
    if (!source.evidence?.path) continue;
    const evidence = JSON.parse(await readFile(areaFile(areaDirectory, source.evidence.path), 'utf8'));
    const items = new Map(evidence.items.map((item) => [item.id, item]));
    const designContext = evidence.items.find((item) => item.role === 'design-context');
    const firstScreenshot = evidence.items.find((item) => item.role === 'screenshot');
    sources.set(source.id, {
      kind: source.kind,
      ...(evidence.items[0] ? { fallbackEvidenceItemId: evidence.items[0].id } : {}),
      ...(designContext ? {
        designContextEvidenceItemId: designContext.id,
        designContext: areaFile(areaDirectory, designContext.path),
      } : {}),
      ...(firstScreenshot ? { screenshotEvidenceItemId: firstScreenshot.id } : {}),
    });
    if (firstScreenshot) {
      const path = areaFile(areaDirectory, firstScreenshot.path);
      sourceScreenshots.set(source.id, { path, dataUrl: imageDataUrl(path, await readFile(path)) });
    }
    for (const assertion of model.sourceParityAssertions || []) {
      if (assertion.sourceId !== source.id || !assertion.baselineEvidenceItemId) continue;
      const item = items.get(assertion.baselineEvidenceItemId);
      if (!item || item.role !== 'screenshot') continue;
      const path = areaFile(areaDirectory, item.path);
      baselines.set(assertion.id, {
        path,
        evidenceItemId: item.id,
        dataUrl: imageDataUrl(path, await readFile(path)),
      });
    }
  }
  return { baselines, sourceScreenshots, sources };
}

async function imageDifference(page, expectedDataUrl, channelTolerance) {
  const actual = await page.screenshot({ fullPage: true, animations: 'disabled' });
  const actualDataUrl = 'data:image/png;base64,' + actual.toString('base64');
  const difference = await page.evaluate(async ({ actualUrl, expectedUrl, tolerance }) => {
    const load = (url) => new Promise((resolveImage, rejectImage) => {
      const image = new Image();
      image.onload = () => resolveImage(image);
      image.onerror = () => rejectImage(new Error('无法解码视觉基线图片。'));
      image.src = url;
    });
    const [actualImage, expectedImage] = await Promise.all([load(actualUrl), load(expectedUrl)]);
    if (actualImage.width !== expectedImage.width || actualImage.height !== expectedImage.height) {
      return {
        ratio: 1,
        actual: [actualImage.width, actualImage.height],
        expected: [expectedImage.width, expectedImage.height],
        differenceRegions: [{
          x: 0,
          y: 0,
          width: Math.max(actualImage.width, 1),
          height: Math.max(actualImage.height, 1),
        }],
        differenceDataUrl: actualUrl,
      };
    }
    const canvas = document.createElement('canvas');
    canvas.width = actualImage.width;
    canvas.height = actualImage.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(actualImage, 0, 0);
    const actualPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(expectedImage, 0, 0);
    const expectedPixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const differencePixels = context.createImageData(canvas.width, canvas.height);
    let different = 0;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let offset = 0; offset < actualPixels.length; offset += 4) {
      const changed = (
        Math.abs(actualPixels[offset] - expectedPixels[offset]) > tolerance
        || Math.abs(actualPixels[offset + 1] - expectedPixels[offset + 1]) > tolerance
        || Math.abs(actualPixels[offset + 2] - expectedPixels[offset + 2]) > tolerance
        || Math.abs(actualPixels[offset + 3] - expectedPixels[offset + 3]) > tolerance
      );
      if (changed) {
        different += 1;
        const pixel = offset / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        differencePixels.data[offset] = 255;
        differencePixels.data[offset + 1] = 32;
        differencePixels.data[offset + 2] = 32;
        differencePixels.data[offset + 3] = 255;
      } else {
        differencePixels.data[offset] = Math.round(expectedPixels[offset] * 0.2);
        differencePixels.data[offset + 1] = Math.round(expectedPixels[offset + 1] * 0.2);
        differencePixels.data[offset + 2] = Math.round(expectedPixels[offset + 2] * 0.2);
        differencePixels.data[offset + 3] = 96;
      }
    }
    context.putImageData(differencePixels, 0, 0);
    return {
      ratio: different / (canvas.width * canvas.height),
      actual: [canvas.width, canvas.height],
      expected: [canvas.width, canvas.height],
      differenceRegions: different > 0 ? [{
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      }] : [],
      differenceDataUrl: canvas.toDataURL('image/png'),
    };
  }, { actualUrl: actualDataUrl, expectedUrl: expectedDataUrl, tolerance: channelTolerance });
  return { ...difference, actualScreenshot: actual };
}

function safeEvidenceName(...parts) {
  return parts.filter(Boolean).join('-').replace(/[^A-Za-z0-9._-]+/g, '-');
}

async function writeDataUrl(path, dataUrl) {
  const content = String(dataUrl).replace(/^data:image\/png;base64,/, '');
  await writeFile(path, Buffer.from(content, 'base64'));
}

async function captureStyleDifference(page, target, path) {
  const previous = await target.evaluate((element) => {
    const value = element.style.outline;
    element.style.outline = '4px solid #ff2020';
    element.style.outlineOffset = '2px';
    return value;
  });
  try {
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
  } finally {
    await target.evaluate((element, value) => {
      element.style.outline = value;
      element.style.outlineOffset = '';
    }, previous);
  }
}

async function ensureAxe(page, axePath) {
  const available = await page.evaluate(() => Boolean(globalThis.axe?.run && globalThis.axe?.commons?.text?.accessibleText));
  if (!available) await page.addScriptTag({ path: axePath });
}

async function verifyExclusiveComponentStates(page, model, location) {
  for (const component of model.components) {
    const visibleStateIds = [];
    for (const stateId of component.stateIds) {
      const states = page.locator('[data-component-state="' + stateId + '"]');
      for (let index = 0; index < await states.count(); index += 1) {
        if (await states.nth(index).isVisible()) {
          visibleStateIds.push(stateId);
          break;
        }
      }
    }
    if (visibleStateIds.length > 1) {
      block(
        'AIH_CANONICAL_UI_RUNTIME_FAILED',
        '组件同时暴露多个互斥状态：' + component.id + ' → ' + visibleStateIds.join(', '),
        location,
      );
    }
  }
}

async function verifyComponentMappings(page, model, screen, location) {
  const coverageByMapping = new Map();
  for (const coverage of model.componentVariantCoverage) {
    if (!coverage.screenIds.includes(screen.id)) continue;
    if (!coverageByMapping.has(coverage.mappingId)) coverageByMapping.set(coverage.mappingId, []);
    coverageByMapping.get(coverage.mappingId).push(coverage);
  }
  const allowedByComponent = new Map();
  for (const mapping of model.componentMappings) {
    const coverageRows = coverageByMapping.get(mapping.id) || [];
    if (coverageRows.length === 0) continue;
    const registered = await page.evaluate((tagName) => Boolean(customElements.get(tagName)), mapping.litTagName);
    if (!registered) {
      block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Lit 自定义元素未注册：' + mapping.litTagName, location);
    }
    if (!allowedByComponent.has(mapping.componentId)) {
      allowedByComponent.set(mapping.componentId, { tags: new Set(), instances: new Set() });
    }
    const allowed = allowedByComponent.get(mapping.componentId);
    allowed.tags.add(mapping.litTagName);
    for (const coverage of coverageRows) {
      for (const instanceNodeId of coverage.instanceNodeIds) {
        allowed.instances.add(instanceNodeId);
        const locator = page.locator('[data-figma-instance-id="' + instanceNodeId + '"]');
        const count = await locator.count();
        if (count !== 1) {
          block(
            'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
            'Figma Instance 必须且只能渲染一次：' + instanceNodeId + '，实际为 ' + count + ' 次。',
            location,
          );
          continue;
        }
        const element = locator.first();
        const actual = await element.evaluate((node) => ({
          tagName: node.tagName.toLowerCase(),
          componentId: node.getAttribute('data-component-id'),
        }));
        if (actual.tagName !== mapping.litTagName || actual.componentId !== mapping.componentId) {
          block(
            'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
            'Figma Instance 未使用声明的 Lit 组件：' + instanceNodeId + '，期望 <' + mapping.litTagName + '> / ' + mapping.componentId + '。',
            location,
          );
        }
        for (const [attribute, expected] of Object.entries(coverage.litVariantAttributes)) {
          const observed = await element.getAttribute(attribute);
          if (observed !== expected) {
            block(
              'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
              'Lit Variant Attribute 不匹配：' + instanceNodeId + ' / ' + attribute + '，期望 ' + expected + '，实际 ' + (observed ?? '未声明') + '。',
              location,
            );
          }
        }
        for (const slotName of coverage.litSlotNames) {
          const assigned = await element.evaluate((node, name) => (
            [...node.children].some((child) => child.getAttribute('slot') === name)
          ), slotName);
          if (!assigned) {
            block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Lit Instance 缺少声明 Slot：' + instanceNodeId + ' / ' + slotName, location);
          }
        }
      }
    }
  }
  for (const [componentId, allowed] of allowedByComponent) {
    const implementations = page.locator('[data-component-id="' + componentId + '"]');
    for (let index = 0; index < await implementations.count(); index += 1) {
      const observed = await implementations.nth(index).evaluate((node) => ({
        tagName: node.tagName.toLowerCase(),
        instanceNodeId: node.getAttribute('data-figma-instance-id'),
      }));
      if (!allowed.tags.has(observed.tagName) || !allowed.instances.has(observed.instanceNodeId)) {
        block(
          'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
          '页面绕过声明的 Lit 组件实现了 Component：' + componentId,
          location,
        );
      }
    }
  }
}

async function beginStateTrace(page) {
  await page.evaluate(() => {
    const state = {
      ids: [],
      initializing: true,
      observers: [],
      roots: new WeakSet(),
      values: new WeakMap(),
    };
    const recordElement = (element) => {
      const previous = state.values.get(element) || {};
      for (const attribute of ['data-state-id', 'data-component-state']) {
        const value = element.getAttribute(attribute);
        if (value && previous[attribute] !== value && !state.initializing && state.ids.at(-1) !== value) state.ids.push(value);
        if (value) previous[attribute] = value;
        else delete previous[attribute];
      }
      state.values.set(element, previous);
    };
    let registerRoot;
    const scanRoot = (root) => {
      const elements = [...root.querySelectorAll('*')];
      if (root instanceof Element) elements.unshift(root);
      for (const element of elements) {
        recordElement(element);
        if (element.shadowRoot) registerRoot(element.shadowRoot);
      }
    };
    registerRoot = (root) => {
      if (state.roots.has(root)) return;
      state.roots.add(root);
      const observer = new MutationObserver(() => scanRoot(root));
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state-id', 'data-component-state'] });
      state.observers.push(observer);
      scanRoot(root);
    };
    globalThis.__pspCanonicalStateTrace = state;
    registerRoot(document);
    state.initializing = false;
    state.ids.length = 0;
  });
}

async function stopStateTrace(page) {
  return page.evaluate(() => {
    const state = globalThis.__pspCanonicalStateTrace;
    if (!state) return [];
    for (const observer of state.observers) observer.disconnect();
    const ids = [...state.ids];
    delete globalThis.__pspCanonicalStateTrace;
    return ids;
  });
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
    if (hasAccessibilityCheck(model, 'accessible-name')) {
      const ariaSnapshot = await locator.first().ariaSnapshot();
      const serializedName = ariaSnapshot.split('\n')[0]?.match(/^-\s+\S+\s+("(?:\\.|[^"\\])*")/)?.[1];
      let accessibleName = '';
      if (serializedName) {
        try { accessibleName = JSON.parse(serializedName).trim(); } catch { /* An invalid snapshot name remains empty. */ }
      }
      if (!accessibleName) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件缺少可访问名称：' + control.id, route.path);
    }
  }
  if (await page.locator('[data-state-id][data-component-state]').count() > 0) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '同一页面元素不得混用流程状态与组件局部状态。', route.path);
  }
  await verifyExclusiveComponentStates(page, model, route.path);
  await verifyComponentMappings(page, model, screen, route.path);
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
  const assertions = model.renderAssertions.filter((assertion) => (
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

async function runSourceParityAssertions(page, model, routeId, viewport, parityEvidence, thresholds, evidenceRoot, scenarioId = null) {
  if (model.visualPolicy.mode === 'autonomous' || model.visualPolicy.mode === 'unresolved') return;
  const assertions = model.sourceParityAssertions.filter((assertion) => (
    assertion.routeId === routeId
    && assertion.viewportId === viewport.id
    && (scenarioId ? assertion.scenarioId === scenarioId : !assertion.scenarioId)
  ));
  for (const assertion of assertions) {
    for (let checkIndex = 0; checkIndex < assertion.checks.length; checkIndex += 1) {
      const check = assertion.checks[checkIndex];
      const sourceScreenshot = parityEvidence.sourceScreenshots.get(assertion.sourceId);
      const source = parityEvidence.sources.get(assertion.sourceId) || { kind: 'other' };
      const sourceEvidenceItemIds = [
        source.designContextEvidenceItemId,
        assertion.baselineEvidenceItemId,
        source.screenshotEvidenceItemId,
        source.fallbackEvidenceItemId,
      ].filter((item, index, values) => item && values.indexOf(item) === index);
      const sourceDetails = {
        sourceId: assertion.sourceId,
        sourceKind: source.kind,
        sourceEvidenceItemIds,
        checkKind: check.kind,
        ...(source.designContextEvidenceItemId ? { designContextEvidenceItemId: source.designContextEvidenceItemId } : {}),
        ...(source.designContext ? { designContext: source.designContext } : {}),
        ...(assertion.baselineEvidenceItemId ? { baselineEvidenceItemId: assertion.baselineEvidenceItemId } : {}),
      };
      if (check.kind === 'computed-style') {
        const target = locatorForId(page, check.targetId);
        if (await target.count() === 0) {
          const message = '来源样式断言目标不存在：' + check.targetId;
          block('AIH_VISUAL_STYLE_BINDING_FAILED', message, assertion.id);
          const prefix = safeEvidenceName('style-missing', viewport.id, routeId, scenarioId, assertion.id, checkIndex);
          const actualScreenshot = join(evidenceRoot, prefix + '-actual.png');
          const differenceScreenshot = join(evidenceRoot, prefix + '-difference.png');
          await page.screenshot({ path: actualScreenshot, fullPage: true, animations: 'disabled' });
          await page.screenshot({ path: differenceScreenshot, fullPage: true, animations: 'disabled' });
          evidence.push({
            kind: 'source-parity-failure',
            blockerCode: 'AIH_VISUAL_STYLE_BINDING_FAILED',
            assertionId: assertion.id,
            ...sourceDetails,
            targetId: check.targetId,
            styleProperty: check.property,
            routeId,
            viewportId: viewport.id,
            ...(scenarioId ? { scenarioId } : {}),
            message,
            expectedStyle: check.expected,
            actualStyle: '',
            ...(sourceScreenshot ? { sourceBaseline: sourceScreenshot.path } : {}),
            actualScreenshot,
            differenceScreenshot,
          });
          continue;
        }
        const actual = await target.first().evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), check.property);
        if (actual !== check.expected) {
          const message = '来源样式不匹配：' + check.targetId + ' / ' + check.property + '，实际为 ' + actual;
          block('AIH_VISUAL_STYLE_BINDING_FAILED', message, assertion.id);
          const prefix = safeEvidenceName('style', viewport.id, routeId, scenarioId, assertion.id, checkIndex);
          const actualScreenshot = join(evidenceRoot, prefix + '-actual.png');
          const differenceScreenshot = join(evidenceRoot, prefix + '-difference.png');
          await page.screenshot({ path: actualScreenshot, fullPage: true, animations: 'disabled' });
          await captureStyleDifference(page, target.first(), differenceScreenshot);
          evidence.push({
            kind: 'source-parity-failure',
            blockerCode: 'AIH_VISUAL_STYLE_BINDING_FAILED',
            assertionId: assertion.id,
            ...sourceDetails,
            targetId: check.targetId,
            styleProperty: check.property,
            routeId,
            viewportId: viewport.id,
            ...(scenarioId ? { scenarioId } : {}),
            message,
            expectedStyle: check.expected,
            actualStyle: actual,
            ...(sourceScreenshot ? { sourceBaseline: sourceScreenshot.path } : {}),
            actualScreenshot,
            differenceScreenshot,
          });
        }
      } else if (check.kind === 'screenshot-match') {
        const baseline = parityEvidence.baselines.get(assertion.id);
        if (!baseline) {
          block('AIH_VISUAL_SOURCE_INCOMPLETE', '无法读取截图一致性基线。', assertion.id);
          continue;
        }
        const difference = await imageDifference(page, baseline.dataUrl, thresholds.channelTolerance);
        if (difference.ratio > thresholds.maxDifferentPixelRatio) {
          const prefix = safeEvidenceName('parity', viewport.id, routeId, scenarioId, assertion.id, checkIndex);
          const actualScreenshot = join(evidenceRoot, prefix + '-actual.png');
          const differenceScreenshot = join(evidenceRoot, prefix + '-difference.png');
          await writeFile(actualScreenshot, difference.actualScreenshot);
          await writeDataUrl(differenceScreenshot, difference.differenceDataUrl);
          const message = '实现与视觉来源截图差异超限：' + (difference.ratio * 100).toFixed(3) + '%，允许 ' + (thresholds.maxDifferentPixelRatio * 100).toFixed(3) + '%；实际 ' + difference.actual.join('×') + '，基线 ' + difference.expected.join('×');
          block(
            'AIH_VISUAL_SOURCE_PARITY_FAILED',
            message,
            assertion.id,
          );
          evidence.push({
            kind: 'source-parity-failure',
            blockerCode: 'AIH_VISUAL_SOURCE_PARITY_FAILED',
            assertionId: assertion.id,
            ...sourceDetails,
            routeId,
            viewportId: viewport.id,
            ...(scenarioId ? { scenarioId } : {}),
            message,
            differenceRatio: difference.ratio,
            differenceRegions: difference.differenceRegions,
            sourceBaseline: baseline.path,
            actualScreenshot,
            differenceScreenshot,
          });
        }
      }
    }
  }
}

async function runAccessibility(page, model, screen, axePath, location) {
  const checks = new Set(model.accessibility?.checks || []);
  if (checks.size === 0) return;

  if (checks.has('automated-rules')) {
    await ensureAxe(page, axePath);
    const violations = await page.evaluate(async () => {
      const result = await globalThis.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'] },
      });
      return result.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
    });
    for (const violation of violations) {
      block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '自动无障碍规则失败：' + violation.id + ' · ' + violation.nodes + ' 个节点', location);
    }
  }

  const controls = controlsForScreen(model, screen);
  const needsKeyboardWalk = checks.has('keyboard-operation') || checks.has('visible-focus');
  const reached = new Set();
  const visibleFocus = new Set();
  if (needsKeyboardWalk) {
    const expected = new Set(controls.map((item) => item.id));
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
  }

  for (const control of controls) {
    const locator = page.locator('[data-control-id="' + control.id + '"]').first();
    if (checks.has('keyboard-operation') && !reached.has(control.id)) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件无法通过键盘 Tab 到达：' + control.id, location);
    if (checks.has('visible-focus') && !visibleFocus.has(control.id)) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件缺少可见焦点：' + control.id, location);
    if (checks.has('target-size')) {
      const box = await locator.boundingBox();
      if (!box || box.width < 24 || box.height < 24) block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '控件触控目标小于 24×24 CSS 像素：' + control.id, location);
    }
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
        const candidates = [];
        const visit = (root) => {
          if (root instanceof Element) candidates.push(root);
          for (const child of root.children || []) visit(child);
          if (root instanceof Element && root.shadowRoot) visit(root.shadowRoot);
        };
        visit(element);
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
        if (input.kind === 'font') {
          const normalizeFamily = (value) => value.trim().replace(/^["']|["']$/g, '').toLowerCase();
          const expectedFamily = normalizeFamily(input.fontFamily);
          const targetUsesFamily = candidates.some((candidate) => getComputedStyle(candidate).fontFamily
            .split(',')
            .map(normalizeFamily)
            .includes(expectedFamily));
          return targetUsesFamily && document.fonts.check('12px "' + input.fontFamily + '"');
        }
        return candidates.some(references);
      }, { expectedUrl, kind: asset.kind, fontFamily: asset.fontFamily || '' });
      if (used) usedAssetTargets.get(asset.id).add(targetId);
    }
  }
}

async function verifyReducedMotion(page, model, routePath) {
  if (!hasAccessibilityCheck(model, 'reduced-motion')) return;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const animated = await page.locator('[data-component-id]').evaluateAll((elements) => elements.some((element) => {
    const style = getComputedStyle(element);
    return style.animationName !== 'none' && style.animationDuration !== '0s';
  }));
  if (animated && model.motions.some((motion) => motion.reducedMotion)) {
    block('AIH_CANONICAL_UI_ACCESSIBILITY_FAILED', '减少动画偏好下仍存在组件动画。', routePath);
  }
}

function cleanReviewUrl(base, routePath) {
  const url = new URL(routePath, base);
  url.searchParams.set('annotate', '0');
  return url.href;
}

async function verifyDefaultReviewTool(page, routePath) {
  const tool = page.locator('inconsistency-annotator[data-review-tool="inconsistency-annotator"]');
  if (await tool.count() !== 1) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '页面默认未显示不一致标记工具。', routePath);
    return;
  }
  const toolbar = tool.locator('.ia-toolbar');
  if (await toolbar.count() !== 1 || !await toolbar.isVisible()) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '页面默认未显示不一致标记工具栏。', routePath);
    return;
  }
  const placement = await toolbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, right: style.right, top: style.top };
  });
  if (placement.position !== 'fixed' || placement.right === 'auto' || placement.top === 'auto') {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具未固定在页面右上方。', routePath);
  }
}

async function installClipboardProbe(page) {
  await page.addInitScript(() => {
    globalThis.__pspClipboardMode = 'success';
    globalThis.__pspClipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items) => {
          const write = {
            active: navigator.userActivation?.isActive === true,
            mode: globalThis.__pspClipboardMode,
            types: [],
          };
          for (const item of items) {
            for (const type of item.types) {
              const value = await item.getType(type);
              write.types.push({ type, size: value.size });
            }
          }
          globalThis.__pspClipboardWrites.push(write);
          if (write.mode === 'denied') {
            throw new DOMException('Write permission denied.', 'NotAllowedError');
          }
        },
      },
    });
  });
}

async function verifyReviewToolCopy(page, routePath) {
  const viewport = page.viewportSize();
  const startX = Math.min(16, Math.max(1, viewport.width - 40));
  const startY = Math.min(120, Math.max(1, viewport.height - 100));
  const endX = Math.min(viewport.width - 1, startX + 120);
  const endY = Math.min(viewport.height - 1, startY + 100);
  await page.locator('[data-action="start"]').click();
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 4 });
  await page.mouse.up();
  await page.locator('[data-issue-type="visual"]').click();

  const copy = page.locator('[data-action="copy"]');
  await copy.click();
  await page.waitForFunction(() => document.querySelector('.ia-status')?.textContent?.includes('已复制'));
  let writes = await page.evaluate(() => globalThis.__pspClipboardWrites);
  const successfulTypes = new Set(writes[0]?.types?.map((item) => item.type));
  if (writes.length !== 1 || writes[0]?.active !== true || !successfulTypes.has('image/png') || !successfulTypes.has('text/plain')) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具没有在用户点击期间写入 PNG 与文字。', routePath);
  }

  await page.waitForFunction(() => document.querySelector('[data-action="copy"]')?.textContent === '复制');
  await page.evaluate(() => { globalThis.__pspClipboardMode = 'denied'; });
  await copy.click();
  await page.waitForFunction(() => document.querySelector('.ia-status')?.textContent?.includes('复制失败'));
  writes = await page.evaluate(() => globalThis.__pspClipboardWrites);
  const failureStatus = await page.locator('.ia-status').textContent();
  if (writes.length !== 2 || !failureStatus?.includes('下载图片')) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '剪贴板拒绝后没有提供下载图片降级入口。', routePath);
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="download"]').click(),
  ]);
  if (!download.suggestedFilename().endsWith('.png')) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具下载的文件不是 PNG。', routePath);
  }
  await page.waitForFunction(() => document.querySelector('.ia-status')?.textContent?.includes('已下载'));
}

async function verifyReviewToolWorkflow(viewport, base, routePath) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  try {
    await installClipboardProbe(page);
    await page.goto(new URL(routePath, base).href, { waitUntil: 'networkidle' });
    await verifyDefaultReviewTool(page, routePath);
    await verifyReviewToolCopy(page, routePath);
  } finally {
    await context.close();
  }
}

async function capture(page, evidenceRoot, item) {
  const parts = [item.kind, item.viewportId, item.routeId, item.scenarioId].filter(Boolean);
  const screenshot = join(evidenceRoot, parts.join('-') + '.png');
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
  evidence.push({ ...item, screenshot });
}

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  if (stage?.status !== 'active') throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const model = await extractCanonicalUi(root, paths.authorityPath);
  const areaPath = repositoryFile(root, stage.root + '/' + stage.areas[paths.area].root);
  const registry = manifest.artifactRegistry.find((item) => item.id === 'canonical-ui-prototype');
  const contract = await readStructured(root, registry.contract, 'yaml');
  const thresholds = contract.spec.visualParity;
  const parityEvidence = await loadParityEvidence(areaPath, model);
  evidenceRoot = await mkdtemp(join(tmpdir(), 'psp-canonical-ui-'));
  const axePath = require.resolve('axe-core/axe.min.js');
  server = await createServer({
    root: areaPath,
    configFile: false,
    logLevel: 'silent',
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

  if (model.viewports[0] && model.routes[0]) {
    try {
      await verifyReviewToolWorkflow(model.viewports[0], base, model.routes[0].path);
    } catch (error) {
      block(error.code || 'AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具复制回归失败：' + error.message, model.routes[0].path);
    }
  }

  for (const viewport of model.viewports) {
    for (const route of model.routes) {
      const { context, page } = await guardedPage(viewport, base);
      let screen = null;
      try {
        await page.goto(new URL(route.path, base).href, { waitUntil: 'networkidle' });
        await verifyDefaultReviewTool(page, route.path);
        await page.goto(cleanReviewUrl(base, route.path), { waitUntil: 'networkidle' });
        if (await page.locator('inconsistency-annotator').count() !== 0) {
          block('AIH_CANONICAL_UI_RUNTIME_FAILED', 'annotate=0 未关闭不一致标记工具。', route.path);
        }
        screen = await verifyBaseSemantics(page, model, route);
        await runVisualAssertions(page, model, route.id, viewport);
        await runSourceParityAssertions(page, model, route.id, viewport, parityEvidence, thresholds, evidenceRoot);
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
        await page.goto(cleanReviewUrl(base, route.path), { waitUntil: 'networkidle' });
        const screen = await verifyBaseSemantics(page, model, route);
        for (const stateId of scenario.initialStateIds) {
          const initialState = page.locator(stateSelector(model, stateId)).first();
          if (await initialState.count() === 0 || !await initialState.isVisible()) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景缺少声明的初始状态：' + stateId, scenario.id + ' / ' + viewport.id);
          }
        }
        const before = await page.locator('[role="status"]').allTextContents();
        const actionStateTraces = [];
        for (const eventId of scenario.eventIds) {
          const event = model.events.find((item) => item.id === eventId);
          if (!event) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景引用未知事件：' + eventId, scenario.id);
            continue;
          }
          const actions = model.actions.filter((item) => item.eventId === eventId);
          if (actions.length !== 1) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景事件必须且只能对应一个动作：' + eventId + '，实际为 ' + actions.length + ' 个。', scenario.id);
            continue;
          }
          const [action] = actions;
          const control = page.locator('[data-control-id="' + event.controlId + '"][data-event-id="' + event.id + '"]');
          if (await control.count() === 0) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '场景缺少事件控件：' + event.id, scenario.id);
            continue;
          }
          const boundActionId = await control.first().getAttribute('data-action-id');
          if (boundActionId !== action.id) {
            block('AIH_CANONICAL_UI_RUNTIME_FAILED', '事件控件未绑定声明动作：' + event.id + ' → ' + action.id + '，实际为 ' + (boundActionId || '未声明'), scenario.id);
          }
          await beginStateTrace(page);
          let observedStateIds = [];
          try {
            await control.first().click();
            await page.waitForFunction((expectedStateIds) => {
              const observed = globalThis.__pspCanonicalStateTrace?.ids || [];
              let expectedIndex = 0;
              for (const stateId of observed) {
                if (stateId === expectedStateIds[expectedIndex]) expectedIndex += 1;
                if (expectedIndex === expectedStateIds.length) return true;
              }
              return false;
            }, action.resultingStateIds, { timeout: 2500 });
          } catch {
            // The trace is inspected after the observer is stopped so the blocker contains the actual sequence.
          } finally {
            observedStateIds = await stopStateTrace(page);
          }
          actionStateTraces.push({ actionId: action.id, stateIds: observedStateIds });
          let expectedIndex = 0;
          for (const stateId of observedStateIds) {
            if (stateId === action.resultingStateIds[expectedIndex]) expectedIndex += 1;
            if (expectedIndex === action.resultingStateIds.length) break;
          }
          if (expectedIndex !== action.resultingStateIds.length) {
            block(
              'AIH_CANONICAL_UI_RUNTIME_FAILED',
              '动作未按序产生声明状态：' + action.id + '，期望 ' + action.resultingStateIds.join(' → ') + '，观测到 ' + (observedStateIds.join(' → ') || '无状态变化'),
              scenario.id + ' / ' + viewport.id,
            );
          }
          await verifyExclusiveComponentStates(page, model, scenario.id + ' / ' + viewport.id);
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
        await runSourceParityAssertions(page, model, route.id, viewport, parityEvidence, thresholds, evidenceRoot, scenario.id);
        await observeAssets(page, model, base);
        await capture(page, evidenceRoot, {
          kind: 'scenario',
          viewportId: viewport.id,
          routeId: route.id,
          scenarioId: scenario.id,
          initialStateIds: scenario.initialStateIds,
          eventIds: scenario.eventIds,
          finalStateIds: scenario.expectedStateIds,
          actionStateTraces,
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

const result = { status: blockers.length === 0 ? 'PASS' : 'BLOCKED', blockers, evidence, ...(evidenceRoot ? { evidenceRoot } : {}) };
if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Canonical UI Prototype 浏览器验收通过；证据位于操作系统临时目录。');
else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
if (result.status !== 'PASS') process.exitCode = 1;
