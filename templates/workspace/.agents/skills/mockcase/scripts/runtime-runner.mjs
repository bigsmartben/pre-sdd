import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import playwright from '@playwright/test';
import { build } from 'vite';
import { commitManagedWrites } from '../../../../.psp/harness/scripts/lib/artifact-transaction.mjs';
import { repositoryFile } from '../../../../.psp/harness/scripts/lib/repository.mjs';
import {
  HOST_API_VERSION,
  actorArgument,
  argument,
  compileSchemas,
  failure,
  jsonText,
  sha256,
  validateSuiteData,
  workspaceContext,
} from './lib.mjs';

const { chromium } = playwright;
const dependencyRequire = createRequire(
  process.env.PRE_SDD_DEPENDENCY_ENTRY
  || process.env.PRE_SDD_RUNTIME_ENTRY
  || import.meta.url,
);
const DEFAULT_REVIEW_TIMEOUT_MS = 30 * 60 * 1000;

function reviewTimeoutMs() {
  const value = argument('--review-timeout-ms');
  if (!value) return DEFAULT_REVIEW_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw Object.assign(new Error('--review-timeout-ms 必须是正整数。'), { code: 'AIH_COMMAND_INVALID' });
  }
  return parsed;
}

async function waitForReviewDecision(page, timeoutMs) {
  try {
    await page.waitForFunction(
      () => Boolean(globalThis.__pspMockcaseReviewDecision?.decision),
      null,
      { timeout: timeoutMs },
    );
    return await page.evaluate(() => globalThis.__pspMockcaseReviewDecision);
  } catch (error) {
    if (/timeout/i.test(error instanceof Error ? error.message : '')) {
      throw Object.assign(new Error('可视 MockCase 评审等待用户操作超时。'), {
        code: 'AIH_MOCKCASE_TIMEOUT',
        cause: error,
      });
    }
    throw Object.assign(new Error('可视 MockCase 评审页面已关闭或异常退出。'), {
      code: 'AIH_MOCKCASE_PLUGIN_FAILED',
      cause: error,
    });
  }
}

async function waitForRuntimeApi(page) {
  await page.waitForFunction(
    () => Boolean(globalThis.__pspMockcaseRuntimeApi)
      || Boolean(globalThis.__pspMockcaseReviewDecision?.extensionError),
    null,
    { timeout: 10000 },
  );
  const extensionError = await page.evaluate(
    () => globalThis.__pspMockcaseReviewDecision?.extensionError ?? null,
  );
  if (extensionError) {
    throw Object.assign(new Error(`MockCase Extension 激活失败：${extensionError.message}`), {
      code: 'AIH_MOCKCASE_PLUGIN_FAILED',
    });
  }
}

function sameIds(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function reviewModeUrl(base, routePath = null) {
  const url = routePath === null ? new URL(base) : new URL(routePath, base);
  url.searchParams.set('review', '1');
  return url.href;
}

function reviewDecisionFacts(decision, runtime, actor) {
  const detail = decision?.detail;
  const requiredRoutes = runtime.routes
    .filter((route) => runtime.cases.some((item) => item.routeId === route.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const completedRoutes = Array.isArray(detail?.completedRoutes)
    ? [...detail.completedRoutes].sort((left, right) => left.routeId.localeCompare(right.routeId))
    : [];
  if (
    decision?.decision !== 'complete'
    || detail?.actor !== actor
    || detail?.allRoutesComplete !== true
    || !sameIds(completedRoutes.map((item) => item.routeId), requiredRoutes.map((item) => item.id))
  ) {
    throw Object.assign(new Error('MockCase 完成事件缺少全量 Route 的成功投影事实。'), {
      code: 'AIH_MOCKCASE_PLUGIN_FAILED',
    });
  }
  return completedRoutes.map((completed) => {
    const available = new Map(runtime.cases
      .filter((item) => item.routeId === completed.routeId)
      .map((item) => [item.id, item.projectionDigest]));
    const caseProjections = Array.isArray(completed.caseProjections)
      ? [...completed.caseProjections].sort((left, right) => left.caseId.localeCompare(right.caseId))
      : [];
    if (
      caseProjections.length === 0
      || completed.applyStatus !== 'PASS'
      || completed.rollbackStatus !== 'PASS'
      || !sameIds(caseProjections.map((item) => item.caseId), [...available.keys()])
      || caseProjections.some((item) =>
        available.get(item.caseId) !== item.projectionDigest)
    ) {
      throw Object.assign(new Error('MockCase Route 决策引用了无效的 Case 投影摘要：' + completed.routeId), {
        code: 'AIH_MOCKCASE_PLUGIN_FAILED',
      });
    }
    return {
      kind: 'review-decision',
      decision: 'complete',
      routeId: completed.routeId,
      caseProjections,
      applyStatus: 'PASS',
      rollbackStatus: 'PASS',
      status: 'PASS',
    };
  });
}

async function capturePublicState(page, runtime, routeId) {
  const targets = runtime.cases
    .filter((item) => item.routeId === routeId)
    .flatMap((item) => item.effects)
    .reduce((result, effect) => {
      const current = result.get(effect.targetInstanceId) ?? {
        targetInstanceId: effect.targetInstanceId,
        propertyNames: new Set(),
        controlIds: new Set(),
      };
      for (const assignment of effect.assignments) current.propertyNames.add(assignment.propertyName);
      if (effect.activation.controlId) current.controlIds.add(effect.activation.controlId);
      result.set(effect.targetInstanceId, current);
      return result;
    }, new Map());
  const specification = [...targets.values()].map((item) => ({
    targetInstanceId: item.targetInstanceId,
    propertyNames: [...item.propertyNames].sort(),
    controlIds: [...item.controlIds].sort(),
  })).sort((left, right) => left.targetInstanceId.localeCompare(right.targetInstanceId));
  const snapshot = await page.evaluate((items) => {
    const find = (root, selector) => {
      const direct = root.querySelector(selector);
      if (direct) return direct;
      for (const element of root.querySelectorAll('*')) {
        if (!element.shadowRoot) continue;
        const nested = find(element.shadowRoot, selector);
        if (nested) return nested;
      }
      return null;
    };
    const copy = (value) => {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value);
      }
    };
    return items.map((item) => {
      const target = find(document, `[data-component-instance-id="${CSS.escape(item.targetInstanceId)}"]`);
      if (!target) throw Object.assign(new Error('公开组件实例不存在：' + item.targetInstanceId), {
        code: 'AIH_MOCKCASE_TARGET_MISSING',
      });
      return {
        targetInstanceId: item.targetInstanceId,
        stateId: target.getAttribute('data-state-id'),
        componentState: target.getAttribute('data-component-state'),
        properties: Object.fromEntries(item.propertyNames.map((name) => [name, copy(target[name])])),
        controls: item.controlIds.map((controlId) => {
          const control = find(target.shadowRoot ?? target, `[data-control-id="${CSS.escape(controlId)}"]`)
            ?? find(document, `[data-control-id="${CSS.escape(controlId)}"]`);
          if (!control) throw Object.assign(new Error('公开 Control 不存在：' + controlId), {
            code: 'AIH_MOCKCASE_TARGET_MISSING',
          });
          return {
            controlId,
            value: 'value' in control ? control.value : null,
            textContent: control.textContent,
          };
        }),
      };
    });
  }, specification);
  return sha256(JSON.stringify(snapshot));
}

async function disposeRuntimePage(page, beforeDigest, runtime, routeId) {
  const disposed = await page.evaluate(async () => {
    await globalThis.__pspMockcaseRuntimeApi.dispose();
    return {
      runtimeApi: typeof globalThis.__pspMockcaseRuntimeApi,
      toolCount: document.querySelectorAll('[data-review-tool="mockcase"]').length,
    };
  });
  if (disposed.runtimeApi !== 'undefined' || disposed.toolCount !== 0) {
    throw Object.assign(new Error('MockCase Extension dispose() 未完整清理公开运行时状态。'), {
      code: 'AIH_MOCKCASE_ROLLBACK_FAILED',
    });
  }
  const afterDigest = await capturePublicState(page, runtime, routeId);
  if (afterDigest !== beforeDigest) {
    throw Object.assign(new Error(`Route ${routeId} dispose 后公开状态未恢复。`), {
      code: 'AIH_MOCKCASE_ROLLBACK_FAILED',
    });
  }
  return afterDigest;
}

async function bundleExtension(context, runtime) {
  const temporary = await mkdtemp(resolve(tmpdir(), 'psp-mockcase-'));
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
        entry: repositoryFile(context.root, '.agents/skills/mockcase/runtime/extension.ts'),
        formats: ['es'],
      },
    },
    define: { __PSP_MOCKCASE_RUNTIME__: JSON.stringify(runtime) },
  });
  const output = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  const chunk = output.find((item) => item.type === 'chunk');
  if (!chunk) throw Object.assign(new Error('Vite 未生成 Extension ESM。'), { code: 'AIH_MOCKCASE_PLUGIN_FAILED' });
  return { temporary, code: chunk.code };
}

async function serve(code) {
  const server = createServer((request, response) => {
    if (request.url !== '/mockcase-extension.mjs') {
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
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/mockcase-extension.mjs`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  };
}

export async function runRuntime(mode, options = {}) {
  const actor = actorArgument();
  const reviewUrl = argument('--review-url');
  const headedRequested = process.argv.includes('--headed');
  const interactiveReview = mode === 'review'
    && (options.interactiveReview ?? headedRequested);
  if (!reviewUrl) throw Object.assign(new Error('必须提供 --review-url <Canonical UI Review URL>。'), { code: 'AIH_COMMAND_INVALID' });
  if (mode === 'review' && !interactiveReview) {
    throw Object.assign(new Error('review-mockcase 必须使用 --headed 等待用户完成或取消评审；自动验证请使用 verify-mockcase。'), {
      code: 'AIH_COMMAND_INVALID',
    });
  }
  if (mode === 'verify' && headedRequested) {
    throw Object.assign(new Error('verify-mockcase 是独立无头验证，不接受 --headed。'), { code: 'AIH_COMMAND_INVALID' });
  }
  const context = await workspaceContext(actor, { allowMissingSuite: false });
  await validateSuiteData(context, { requireCoverage: true });
  const runtimeText = await readFile(repositoryFile(context.root, context.files.runtime), 'utf8');
  const runtime = JSON.parse(runtimeText);
  const schemas = await compileSchemas(context.root);
  if (!schemas.runtime(runtime)) throw Object.assign(new Error('Runtime Bundle Schema 校验失败。'), { code: 'AIH_ARTIFACT_SCHEMA_FAILED' });
  if (
    runtime.sourceDigests.suite !== sha256(jsonText(context.suite))
    || runtime.sourceDigests.mockdata !== context.suite.files['mockdata.json']
    || runtime.sourceDigests.mockcases !== context.suite.files['mockcases.json']
    || runtime.sourceDigests.capabilities !== context.upstream.capabilitiesDigest
    || runtime.sourceDigests.canonicalUi !== context.upstream.canonicalUiDigest
  ) throw Object.assign(new Error('Runtime Bundle 来源摘要已漂移。'), { code: 'AIH_MOCKCASE_CANDIDATE_STALE' });

  const bundle = await bundleExtension(context, runtime);
  let endpoint;
  let browser;
  let browserContext;
  const facts = [];
  try {
    endpoint = await serve(bundle.code);
    browser = await chromium.launch({
      headless: options.launchHeadless ?? mode === 'verify',
    });
    browserContext = await browser.newContext();
    const descriptor = Object.freeze({
      id: 'mockcase',
      apiVersion: HOST_API_VERSION,
      moduleUrl: endpoint.url,
      integrity: sha256(bundle.code),
    });
    await browserContext.addInitScript((allowed) => {
      const descriptors = Object.freeze(allowed.map((item) => Object.freeze(item)));
      Object.defineProperty(globalThis, '__PSP_REVIEW_EXTENSIONS__', {
        value: descriptors,
        configurable: false,
        writable: false,
      });
      const reviewDecision = { decision: null, detail: null, extensionError: null };
      Object.defineProperty(globalThis, '__pspMockcaseReviewDecision', {
        value: reviewDecision,
        configurable: false,
        writable: false,
      });
      globalThis.addEventListener('psp:mockcase-review-complete', (event) => {
        reviewDecision.detail = event.detail;
        if (event.detail?.allRoutesComplete === true) reviewDecision.decision = 'complete';
      });
      globalThis.addEventListener('psp:mockcase-review-cancel', (event) => {
        reviewDecision.decision = 'cancel';
        reviewDecision.detail = event.detail;
      });
      globalThis.addEventListener('psp:review-extension-error', (event) => {
        reviewDecision.extensionError = event.detail;
      });
    }, [descriptor]);
    facts.push({ kind: 'descriptor', descriptor });
    if (mode === 'verify') {
      const routes = runtime.routes.filter((route) =>
        runtime.cases.some((item) => item.routeId === route.id));
      for (const route of routes) {
        const page = await browserContext.newPage();
        try {
          const routeUrl = reviewModeUrl(reviewUrl, route.path);
          await page.goto(routeUrl, { waitUntil: 'networkidle' });
          await waitForRuntimeApi(page);
          const caseIds = await page.evaluate(() => [...globalThis.__pspMockcaseRuntimeApi.caseIds]);
          const expectedCaseIds = runtime.cases.filter((item) => item.routeId === route.id).map((item) => item.id);
          if (!sameIds(caseIds, expectedCaseIds)) {
            throw Object.assign(new Error(
              `Route ${route.id} 的运行时 Case 集合不完整：expected=${expectedCaseIds.join(',')}；actual=${caseIds.join(',')}`,
            ), { code: 'AIH_MOCKCASE_COVERAGE_FAILED' });
          }
          await options.onPageReady?.(page, { mode, routeId: route.id });
          await page.evaluate(() => globalThis.__pspMockcaseRuntimeApi.reset());
          const beforeDigest = await capturePublicState(page, runtime, route.id);
          for (const caseId of caseIds) {
            try {
              await page.evaluate((id) => globalThis.__pspMockcaseRuntimeApi.apply([id]), caseId);
            } catch (error) {
              throw Object.assign(new Error(`Case ${caseId} 验证失败：${error.message}`), {
                code: error.code || 'AIH_MOCKCASE_PLUGIN_FAILED',
                cause: error,
              });
            }
            const runtimeCase = runtime.cases.find((item) => item.id === caseId);
            facts.push({
              kind: 'case',
              caseId,
              routeId: route.id,
              projectionDigest: runtimeCase.projectionDigest,
              applyStatus: 'PASS',
              status: 'PASS',
            });
          }
          const afterDigest = await disposeRuntimePage(page, beforeDigest, runtime, route.id);
          facts.push({
            kind: 'dispose',
            routeId: route.id,
            rollbackStatus: 'PASS',
            beforeDigest,
            afterDigest,
            status: 'PASS',
          });
        } finally {
          await page.close();
        }
      }
    } else {
      const page = await browserContext.newPage();
      try {
        await page.goto(reviewModeUrl(reviewUrl), { waitUntil: 'networkidle' });
        await waitForRuntimeApi(page);
        await options.onPageReady?.(page, { mode, routeId: null });
        facts.push({ kind: 'review-host', url: page.url(), status: 'PASS' });
        if (interactiveReview) {
          await options.onInteractiveReady?.(page);
          const decision = await waitForReviewDecision(page, reviewTimeoutMs());
          if (decision.decision === 'cancel') {
            throw Object.assign(new Error('用户取消了 MockCase 可视评审；未写入新的 READY Evidence。'), {
              code: 'AIH_MOCKCASE_REVIEW_CANCELLED',
            });
          }
          facts.push(...reviewDecisionFacts(decision, runtime, actor));
        }
      } finally {
        await page.close();
      }
    }
    const evidence = {
      schemaVersion: '2.0.0',
      actor,
      lifecycle: mode === 'verify' ? 'VERIFIED' : 'READY',
      suiteDigest: context.suiteDigest,
      runtimeDigest: sha256(runtimeText),
      hostApiVersion: HOST_API_VERSION,
      facts,
      blockers: [],
    };
    if (!schemas.evidence(evidence)) throw Object.assign(new Error('Evidence Schema 校验失败。'), { code: 'AIH_ARTIFACT_SCHEMA_FAILED' });
    const target = `.psp/evidence/mockcase/${actor}/${mode}.json`;
    const transactionId = await commitManagedWrites({
      root: context.root,
      ownerId: `mockcase-evidence-${actor}`,
      writes: [{ target, content: jsonText(evidence) }],
    });
    return { status: 'PASS', operation: `${mode}-mockcase`, actor, lifecycle: evidence.lifecycle, evidence: target, transactionId, blockers: [] };
  } finally {
    await Promise.allSettled([
      browserContext?.close(),
      browser?.close(),
      endpoint?.close(),
    ]);
    await rm(bundle.temporary, { recursive: true, force: true });
  }
}

export async function runCommand(mode) {
  let result;
  try {
    result = await runRuntime(mode);
  } catch (error) {
    result = failure(error, `${mode}-mockcase`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'PASS') process.exitCode = 1;
}
