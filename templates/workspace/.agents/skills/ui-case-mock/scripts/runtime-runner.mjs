import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import playwright from '@playwright/test';
import { build } from 'vite';
import {
  artifactCollectionMembers,
  artifactMemberPath,
  artifactPaths,
  loadProject,
  repositoryFile,
  repositoryRootFrom,
} from '../../../runtime/project.mjs';
import { extractCanonicalUi } from '../../product-design/canonical-ui-prototype/scripts/extract.mjs';
import { analyzeUiCaseCoverage, compileUiCaseRuntime } from './model.mjs';

const { chromium } = playwright;
const dependencyRequire = createRequire(
  process.env.PRE_SDD_DEPENDENCY_ENTRY
  || process.env.PRE_SDD_RUNTIME_ENTRY
  || import.meta.url,
);
const HOST_API_VERSION = 'psp.review-extension/v1';

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function actorArgument() {
  const actor = argument('--actor');
  if (!/^ACTOR-[0-9]{3}$/.test(actor || '')) {
    throw Object.assign(new Error('必须提供 --actor ACTOR-NNN。'), { code: 'AIH_COMMAND_INVALID' });
  }
  return actor;
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function reviewUrl(base, routePath, enabled) {
  const url = new URL(routePath, base);
  url.searchParams.set('review', enabled ? '1' : '0');
  return url.href;
}

function safeName(value) {
  return value.replace(/[^A-Za-z0-9_-]+/g, '-');
}

async function bundleExtension(root, runtime) {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: [{ find: 'lit', replacement: dependencyRequire.resolve('lit') }],
    },
    build: {
      write: false,
      minify: false,
      codeSplitting: false,
      lib: {
        entry: repositoryFile(root, '.agents/skills/ui-case-mock/runtime/extension.ts'),
        formats: ['es'],
      },
    },
    define: { __PSP_UI_CASE_RUNTIME__: JSON.stringify(runtime) },
  });
  const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const chunk = output.find((item) => item.type === 'chunk');
  if (!chunk) throw Object.assign(new Error('Vite 未生成 UI Case Mock Extension ESM。'), { code: 'AIH_UI_CASE_PLUGIN_FAILED' });
  return chunk.code;
}

async function serveExtension(code) {
  const server = createServer((request, response) => {
    if (request.url !== '/ui-case-mock-extension.mjs') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    response.end(code);
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/ui-case-mock-extension.mjs`,
    close: () => new Promise((ready, reject) => server.close((error) => error ? reject(error) : ready())),
  };
}

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

async function serveStatic(directory) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      let pathname = decodeURIComponent(url.pathname);
      let target = resolve(directory, `.${pathname}`);
      if (target !== directory && !target.startsWith(directory + sep)) {
        response.writeHead(403).end();
        return;
      }
      try {
        if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
      } catch {
        target = resolve(directory, 'index.html');
      }
      const bytes = await readFile(target);
      response.writeHead(200, {
        'content-type': contentTypes[extname(target)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(bytes);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((ready, reject) => server.close((error) => error ? reject(error) : ready())),
  };
}

async function buildTemporaryPreview(areaDirectory, siteDirectory) {
  await build({
    root: areaDirectory,
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: [
        { find: 'lit', replacement: dependencyRequire.resolve('lit') },
        { find: 'msw/browser', replacement: dependencyRequire.resolve('msw/browser') },
        { find: 'msw', replacement: dependencyRequire.resolve('msw') },
      ],
    },
    build: {
      outDir: siteDirectory,
      emptyOutDir: true,
    },
  });
  return serveStatic(siteDirectory);
}

async function waitForRuntimeApi(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.__pspUiCaseRuntimeApi)
      || Boolean(globalThis.__pspUiCaseReviewDecision?.extensionError),
    null,
    { timeout: 10000 },
  );
  const error = await page.evaluate(() => globalThis.__pspUiCaseReviewDecision?.extensionError || null);
  if (error) {
    throw Object.assign(new Error(`UI Case Mock Extension 激活失败：${error.message}`), {
      code: 'AIH_UI_CASE_PLUGIN_FAILED',
    });
  }
}

async function assertReviewBoundary(context, baseUrl, routePath) {
  const page = await context.newPage();
  try {
    await page.goto(reviewUrl(baseUrl, routePath, false), { waitUntil: 'networkidle' });
    const boundary = await page.evaluate(() => ({
      api: typeof globalThis.__pspUiCaseRuntimeApi,
      tools: document.querySelectorAll('[data-review-tool="ui-case-mock"]').length,
    }));
    if (boundary.api !== 'undefined' || boundary.tools !== 0) {
      throw Object.assign(new Error('review=0 不得加载 UI Case Mock。'), { code: 'AIH_UI_CASE_PLUGIN_FAILED' });
    }
  } finally {
    await page.close();
  }
}

async function evaluateAssertions(page, checks) {
  return page.evaluate((requestedChecks) => {
    function query(root, id) {
      const escaped = CSS.escape(id);
      const selector = [
        `[data-screen-id="${escaped}"]`,
        `[data-component-id="${escaped}"]`,
        `[data-component-instance-id="${escaped}"]`,
        `[data-component-contract-id="${escaped}"]`,
        `[data-control-id="${escaped}"]`,
        `[data-state-id="${escaped}"]`,
        `#${escaped}`,
      ].join(',');
      const direct = root.querySelector(selector);
      if (direct) return direct;
      for (const item of root.querySelectorAll('*')) {
        if (item.shadowRoot) {
          const nested = query(item.shadowRoot, id);
          if (nested) return nested;
        }
      }
      return null;
    }
    function visible(element) {
      if (!element) return false;
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
    }
    const failures = [];
    for (const check of requestedChecks) {
      if (check.kind === 'screenshot-match') continue;
      if (check.kind === 'document-no-horizontal-overflow') {
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) failures.push(check.kind);
      } else if (check.kind === 'element-visible' || check.kind === 'element-in-viewport') {
        for (const id of check.targetIds || []) {
          const element = query(document, id);
          if (!visible(element)) {
            failures.push(`${check.kind}:${id}`);
            continue;
          }
          if (check.kind === 'element-in-viewport') {
            const box = element.getBoundingClientRect();
            if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) failures.push(`${check.kind}:${id}`);
          }
        }
      } else if (check.kind === 'text-no-clipping') {
        for (const id of check.targetIds || []) {
          const element = query(document, id);
          if (!element || element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) failures.push(`${check.kind}:${id}`);
        }
      } else if (check.kind === 'elements-no-overlap') {
        const boxes = (check.targetIds || []).map((id) => [id, query(document, id)?.getBoundingClientRect()]);
        for (let left = 0; left < boxes.length; left += 1) {
          for (let right = left + 1; right < boxes.length; right += 1) {
            const a = boxes[left][1];
            const b = boxes[right][1];
            if (a && b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
              failures.push(`${check.kind}:${boxes[left][0]}/${boxes[right][0]}`);
            }
          }
        }
      } else if (check.kind === 'text-max-lines') {
        for (const id of check.targetIds || []) {
          const element = query(document, id);
          const style = element && getComputedStyle(element);
          const lineHeight = style ? Number.parseFloat(style.lineHeight) : NaN;
          if (!element || !Number.isFinite(lineHeight) || element.getBoundingClientRect().height > lineHeight * check.maxLines + 1) failures.push(`${check.kind}:${id}`);
        }
      } else if (check.kind === 'computed-style') {
        const element = query(document, check.targetId);
        const actual = element ? getComputedStyle(element).getPropertyValue(check.property).trim() : null;
        if (actual !== check.expected) failures.push(`${check.kind}:${check.targetId}:${check.property}:${actual}`);
      }
    }
    return failures;
  }, checks);
}

async function selectedAssertions(page, model, runtimeCase, viewportId) {
  const routeChecks = (model.renderAssertions || [])
    .filter((item) => (
      item.routeId === runtimeCase.routeId
      && !item.scenarioId
      && (item.viewportIds || []).includes(viewportId)
    ))
    .flatMap((item) => item.checks.map((check) => ({ ...check, assertionId: item.id })));
  const sourceChecks = (model.sourceParityAssertions || [])
    .filter((item) => item.routeId === runtimeCase.routeId && item.viewportId === viewportId && !item.scenarioId)
    .flatMap((item) => item.checks.map((check) => ({ ...check, assertionId: item.id })));
  const componentChecks = runtimeCase.components.flatMap((component) => (
    (model.componentSourceParityAssertions || [])
      .filter((item) => (
        item.componentContractId === component.componentContractId
        && item.pageInstanceId === component.pageInstanceId
        && item.stateMatrixEntryId === component.stateMatrixEntryId
        && item.viewportId === viewportId
      ))
      .flatMap((item) => item.checks.map((check) => ({ ...check, assertionId: item.id })))
  ));
  const checks = [...routeChecks, ...sourceChecks, ...componentChecks];
  const failures = await evaluateAssertions(page, checks);
  if (failures.length > 0) {
    throw Object.assign(new Error(`UI Case 的 Render/Source Parity Assertion 失败：${failures.join('; ')}`), {
      code: 'AIH_UI_CASE_ASSERTION_FAILED',
    });
  }
  return [...new Set(checks.map((item) => item.assertionId))];
}

async function publicProjectionSnapshot(page, runtimeCase) {
  return page.evaluate((selectedCase) => {
    function query(root, selector) {
      const direct = root.querySelector(selector);
      if (direct) return direct;
      for (const item of root.querySelectorAll('*')) {
        if (item.shadowRoot) {
          const nested = query(item.shadowRoot, selector);
          if (nested) return nested;
        }
      }
      return null;
    }
    return selectedCase.components.map((component) => {
      const element = query(document, component.selector);
      if (!element) return { pageInstanceId: component.pageInstanceId, missing: true };
      const values = component.operations.map((operation) => {
        if (operation.kind === 'property') {
          return { kind: 'property', name: operation.name, value: structuredClone(element[operation.name]) };
        }
        if (operation.kind === 'workflow-state' && operation.name) {
          return { kind: 'workflow-state', name: operation.name, value: structuredClone(element[operation.name]) };
        }
        if (operation.kind === 'attribute') {
          return {
            kind: 'attribute',
            name: operation.name,
            present: element.hasAttribute(operation.name),
            value: element.getAttribute(operation.name),
          };
        }
        if (operation.kind === 'slot') {
          return {
            kind: 'slot',
            name: operation.name,
            values: [...element.childNodes]
              .filter((node) => node instanceof HTMLElement && node.slot === operation.name)
              .map((node) => node.textContent),
          };
        }
        return { kind: operation.kind };
      });
      return {
        pageInstanceId: component.pageInstanceId,
        marker: element.getAttribute('data-ui-case-state-matrix-entry'),
        values,
      };
    });
  }, runtimeCase);
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function verifyProjection(page, runtimeCase) {
  const snapshot = await publicProjectionSnapshot(page, runtimeCase);
  const failures = [];
  for (const component of runtimeCase.components) {
    const actual = snapshot.find((item) => item.pageInstanceId === component.pageInstanceId);
    if (!actual || actual.missing || actual.marker !== component.stateMatrixEntryId) {
      failures.push(`${component.pageInstanceId}:matrix-marker`);
      continue;
    }
    component.operations.forEach((operation, index) => {
      const value = actual.values[index];
      if (operation.kind === 'property' && !sameSnapshot(value?.value, operation.value)) {
        failures.push(`${component.pageInstanceId}:property:${operation.name}`);
      } else if (operation.kind === 'workflow-state' && operation.name && value?.value !== operation.stateId) {
        failures.push(`${component.pageInstanceId}:workflow-state:${operation.name}`);
      } else if (operation.kind === 'attribute') {
        const expectedPresent = operation.valueType === 'boolean' ? operation.value === true : true;
        const expectedValue = operation.valueType === 'boolean'
          ? (expectedPresent ? '' : null)
          : (typeof operation.value === 'string' ? operation.value : JSON.stringify(operation.value));
        if (value?.present !== expectedPresent || value?.value !== expectedValue) {
          failures.push(`${component.pageInstanceId}:attribute:${operation.name}`);
        }
      } else if (operation.kind === 'slot' && !sameSnapshot(value?.values, [operation.value])) {
        failures.push(`${component.pageInstanceId}:slot:${operation.name}`);
      }
    });
  }
  if (failures.length > 0) {
    throw Object.assign(new Error(`UI Case 公开接口投影不一致：${failures.join(', ')}`), {
      code: 'AIH_UI_CASE_ASSERTION_FAILED',
    });
  }
  return snapshot;
}

async function screenshotWithoutReviewTool(page, path) {
  const hidden = await page.evaluate(() => {
    const values = [];
    for (const element of document.querySelectorAll('[data-review-tool]')) {
      values.push([element, element.style.visibility]);
      element.style.visibility = 'hidden';
      element.setAttribute('data-product-screenshot-excluded', 'true');
    }
    globalThis.__pspHiddenReviewTools = values;
    return values.length;
  });
  await page.screenshot({ path, fullPage: true });
  await page.evaluate(() => {
    for (const [element, visibility] of globalThis.__pspHiddenReviewTools || []) element.style.visibility = visibility;
    delete globalThis.__pspHiddenReviewTools;
  });
  return hidden;
}

function browserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/executable.*doesn.t exist|browser.*not found|playwright install/i.test(message)) {
    return Object.assign(
      new Error('Chromium 未安装。Agent 需在后台准备浏览器依赖后重试，不得要求用户执行安装命令。'),
      { code: 'AIH_UI_CASE_BROWSER_MISSING', cause: error },
    );
  }
  return error;
}

export async function runRuntime(mode, options = {}) {
  const actor = options.actor || actorArgument();
  const headedRequested = process.argv.includes('--headed');
  if (mode === 'review' && !(options.interactiveReview ?? headedRequested)) {
    throw Object.assign(new Error('review:ui-case-mock 必须显式使用 --headed。'), { code: 'AIH_COMMAND_INVALID' });
  }
  if (mode === 'verify' && headedRequested) {
    throw Object.assign(new Error('verify:ui-case-mock 是无头验证，不接受 --headed。'), { code: 'AIH_COMMAND_INVALID' });
  }

  const root = options.root || repositoryRootFrom(resolve(import.meta.dirname, '..'));
  const project = await loadProject(root);
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const authorityPath = artifactMemberPath(paths, actor);
  const model = options.model || await extractCanonicalUi(root, authorityPath);
  const analysis = analyzeUiCaseCoverage(model);
  if (analysis.status !== 'PASS') {
    const error = new Error(analysis.blockers.map((item) => `[${item.code}] ${item.message}`).join('\n'));
    error.code = analysis.blockers[0]?.code || 'AIH_UI_CASE_CONTRACT_INVALID';
    throw error;
  }
  const compiled = compileUiCaseRuntime(model);
  if (compiled.status !== 'PASS') {
    const error = new Error(compiled.blockers.map((item) => `[${item.code}] ${item.message}`).join('\n'));
    error.code = compiled.blockers[0]?.code || 'AIH_UI_CASE_CONTRACT_INVALID';
    throw error;
  }
  const runtime = { actor, cases: compiled.cases };
  const extensionCode = await bundleExtension(root, runtime);
  const extensionServer = await serveExtension(extensionCode);
  const evidenceRoot = options.evidenceRoot || await mkdtemp(resolve(tmpdir(), 'psp-ui-case-mock-'));
  const siteDirectory = resolve(evidenceRoot, 'site');
  const screenshotDirectory = resolve(evidenceRoot, 'screenshots');
  await mkdir(screenshotDirectory, { recursive: true });
  let previewServer = null;
  let browser = null;
  let browserContext = null;
  const facts = [];
  try {
    let baseUrl = options.reviewUrl || argument('--review-url');
    if (!baseUrl) {
      const areaDirectory = repositoryFile(root, `${paths.authorityRoot}/${actor}`);
      previewServer = await buildTemporaryPreview(areaDirectory, siteDirectory);
      baseUrl = previewServer.url;
    }
    try {
      browser = await chromium.launch({ headless: options.launchHeadless ?? mode === 'verify' });
    } catch (error) {
      throw browserError(error);
    }
    browserContext = await browser.newContext();
    const descriptor = Object.freeze({
      id: 'ui-case-mock',
      apiVersion: HOST_API_VERSION,
      moduleUrl: extensionServer.url,
      integrity: sha256(extensionCode),
    });
    await browserContext.addInitScript((allowed) => {
      Object.defineProperty(globalThis, '__PSP_REVIEW_EXTENSIONS__', {
        value: Object.freeze(allowed.map((item) => Object.freeze(item))),
        configurable: false,
        writable: false,
      });
      const decision = { decision: null, detail: null, extensionError: null };
      Object.defineProperty(globalThis, '__pspUiCaseReviewDecision', {
        value: decision,
        configurable: false,
        writable: false,
      });
      globalThis.addEventListener('psp:ui-case-review-complete', (event) => {
        decision.decision = 'complete';
        decision.detail = event.detail;
      });
      globalThis.addEventListener('psp:ui-case-review-cancel', (event) => {
        decision.decision = 'cancel';
        decision.detail = event.detail;
      });
      globalThis.addEventListener('psp:review-extension-error', (event) => {
        decision.extensionError = event.detail;
      });
    }, [descriptor]);

    if (mode === 'verify') {
      for (const routePath of new Set(runtime.cases.map((item) => item.routePath))) {
        await assertReviewBoundary(browserContext, baseUrl, routePath);
      }
      const viewports = new Map((model.viewports || []).map((item) => [item.id, item]));
      for (const runtimeCase of runtime.cases) {
        for (const viewportId of runtimeCase.viewportIds) {
          const viewport = viewports.get(viewportId);
          const page = await browserContext.newPage();
          try {
            await page.setViewportSize({ width: viewport.width, height: viewport.height });
            await page.goto(reviewUrl(baseUrl, runtimeCase.routePath, true), { waitUntil: 'networkidle' });
            await waitForRuntimeApi(page);
            await options.onPageReady?.(page, { mode, uiCaseId: runtimeCase.id, viewportId });
            const baseline = await publicProjectionSnapshot(page, runtimeCase);
            await page.evaluate((id) => globalThis.__pspUiCaseRuntimeApi.apply(id), runtimeCase.id);
            await verifyProjection(page, runtimeCase);
            const assertionIds = await selectedAssertions(page, model, runtimeCase, viewportId);
            const screenshotPath = resolve(screenshotDirectory, `${safeName(runtimeCase.id)}-${safeName(viewportId)}.png`);
            const excludedReviewTools = await screenshotWithoutReviewTool(page, screenshotPath);
            facts.push({
              kind: 'ui-case',
              uiCaseId: runtimeCase.id,
              viewModelId: runtimeCase.viewModelId,
              routeId: runtimeCase.routeId,
              viewportId,
              assertionIds,
              screenshot: screenshotPath,
              excludedReviewTools,
              status: 'PASS',
            });
            const disposedState = await page.evaluate(async () => {
              await globalThis.__pspUiCaseRuntimeApi.dispose();
              return {
                api: typeof globalThis.__pspUiCaseRuntimeApi,
                tools: document.querySelectorAll('[data-review-tool="ui-case-mock"]').length,
                projections: document.querySelectorAll('[data-ui-case-state-matrix-entry]').length,
              };
            });
            const restored = await publicProjectionSnapshot(page, runtimeCase);
            if (
              disposedState.api !== 'undefined'
              || disposedState.tools !== 0
              || disposedState.projections !== 0
              || !sameSnapshot(restored, baseline)
            ) {
              throw Object.assign(new Error('UI Case Mock dispose 未完整回滚或清理。'), { code: 'AIH_UI_CASE_ROLLBACK_FAILED' });
            }
          } finally {
            await page.close();
          }
        }
      }
    } else {
      const firstCase = runtime.cases[0];
      if (!firstCase) throw Object.assign(new Error('没有可评审的 UI Case。'), { code: 'AIH_UI_CASE_COVERAGE_INCOMPLETE' });
      const page = await browserContext.newPage();
      try {
        await page.goto(reviewUrl(baseUrl, firstCase.routePath, true), { waitUntil: 'networkidle' });
        await waitForRuntimeApi(page);
        await options.onInteractiveReady?.(page);
        await page.waitForFunction(() => Boolean(globalThis.__pspUiCaseReviewDecision?.decision), null, {
          timeout: options.reviewTimeoutMs || 30 * 60 * 1000,
        });
        const decision = await page.evaluate(() => globalThis.__pspUiCaseReviewDecision);
        if (decision.decision !== 'complete') {
          throw Object.assign(new Error('用户取消了 UI Case Mock 评审。'), { code: 'AIH_UI_CASE_REVIEW_CANCELLED' });
        }
        facts.push({ kind: 'review-decision', ...decision.detail, status: 'PASS' });
        await page.evaluate(() => globalThis.__pspUiCaseRuntimeApi.dispose());
      } finally {
        await page.close();
      }
    }
    return {
      status: 'PASS',
      operation: mode === 'review' ? 'review:ui-case-mock' : 'verify:ui-case-mock',
      actor,
      evidence: {
        temporary: true,
        root: evidenceRoot,
        facts,
      },
      blockers: [],
    };
  } finally {
    await Promise.allSettled([
      browserContext?.close(),
      browser?.close(),
      previewServer?.close(),
      extensionServer.close(),
    ]);
    await rm(siteDirectory, { recursive: true, force: true });
  }
}

export async function runCommand(mode) {
  try {
    const requestedActor = argument('--actor');
    const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
    let actors;
    if (requestedActor || mode === 'review') {
      actors = [requestedActor || actorArgument()];
    } else {
      const project = await loadProject(root);
      const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
      actors = (await artifactCollectionMembers(root, paths)).map((item) => item.actor);
      if (actors.length === 0) {
        throw Object.assign(new Error('尚未创建参与者 Canonical UI 应用。'), { code: 'AIH_ARTIFACT_INCOMPLETE' });
      }
    }
    const actorResults = [];
    for (const actor of actors) actorResults.push(await runRuntime(mode, { root, actor }));
    const result = actorResults.length === 1
      ? actorResults[0]
      : {
          status: 'PASS',
          operation: 'verify:ui-case-mock',
          actors,
          evidence: {
            temporary: true,
            actors: actorResults.map((item) => ({ actor: item.actor, ...item.evidence })),
          },
          blockers: [],
        };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const result = {
      status: 'BLOCKED',
      operation: mode === 'review' ? 'review:ui-case-mock' : 'verify:ui-case-mock',
      blockers: [{
        code: error.code || 'AIH_UI_CASE_PLUGIN_FAILED',
        message: error.message,
      }],
    };
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}
