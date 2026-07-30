import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { chromium } from 'playwright';
import { hashUihtml } from './hash-uihtml.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function add(blockers, code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contentType(path) {
  return {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  }[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function startUihtmlServer(root) {
  const indexPath = resolve(root, 'index.html');
  if (!(await fileExists(indexPath))) throw new Error('UIHTML/index.html 不存在。');
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname);
      const relativePath = pathname.replace(/^\/+/, '');
      let target = resolve(root, relativePath || 'index.html');
      if (target !== root && !target.startsWith(root + sep)) {
        response.writeHead(403).end();
        return;
      }
      if (!(await fileExists(target))) {
        if (extname(relativePath)) {
          response.writeHead(404).end();
          return;
        }
        target = indexPath;
      }
      response.writeHead(200, { 'content-type': contentType(target) });
      response.end(await readFile(target));
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动 UIHTML 验收服务器。');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose()))),
  };
}

async function verifyRuntime(uihtmlRoot, routes) {
  const failures = [];
  const server = await startUihtmlServer(uihtmlRoot);
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    for (const route of routes) {
      const page = await browser.newPage();
      const routeFailures = [];
      page.on('pageerror', (error) => routeFailures.push(`pageerror: ${error.message}`));
      page.on('requestfailed', (request) => routeFailures.push(`requestfailed: ${request.url()}`));
      page.on('response', (response) => {
        if (response.status() >= 400) routeFailures.push(`response ${response.status()}: ${response.url()}`);
      });
      try {
        const response = await page.goto(new URL(route, server.origin).href, { waitUntil: 'networkidle' });
        if (!response?.ok()) routeFailures.push(`navigation status: ${response?.status() ?? 'missing'}`);
        const ready = await page.evaluate(() => document.readyState === 'complete' && Boolean(document.body));
        if (!ready) routeFailures.push('document did not reach a complete state');
      } catch (error) {
        routeFailures.push(error instanceof Error ? error.message : String(error));
      } finally {
        await page.close();
      }
      if (routeFailures.length) failures.push({ route, failures: routeFailures });
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
  return failures;
}

try {
  const reportPath = resolve(argument('report', '.psp/evidence/uihtml-acceptance.json'));
  const uihtmlRoot = resolve(argument('uihtml', 'UIHTML'));
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const schema = JSON.parse(await readFile(new URL('../contracts/delivery-acceptance.schema.json', import.meta.url), 'utf8'));
  const validateSchema = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false,
  }).compile(schema);
  const blockers = [];
  const schemaValid = validateSchema(report);
  if (!schemaValid) {
    for (const error of validateSchema.errors ?? []) {
      const path = error.instancePath || 'report';
      const code = path.startsWith('/interactions')
        ? 'UIHTML_INTERACTION_PARITY_FAILED'
        : path.startsWith('/motions')
          ? 'UIHTML_MOTION_PARITY_FAILED'
          : path.startsWith('/visualComparisons')
            ? 'UIHTML_VISUAL_PARITY_FAILED'
            : path.startsWith('/productHash')
              ? 'UIHTML_HASH_BOUNDARY_INVALID'
              : 'UIHTML_RUNTIME_DEP_MISSING';
      add(blockers, code, `UIHTML 验收报告 Schema 无效：${error.message ?? error.keyword}。`, path);
    }
  }
  if (report.standalone?.opened !== true || report.standalone?.assetsResolved !== true) {
    add(blockers, 'UIHTML_RUNTIME_DEP_MISSING', 'UIHTML 未证明可独立打开且资源完整。', 'standalone');
  }
  if (!Array.isArray(report.interactions) || !report.interactions.length || report.interactions.some((item) => item?.passed !== true)) {
    add(blockers, 'UIHTML_INTERACTION_PARITY_FAILED', '已确认 Route/Event/State 分支未全部通过。', 'interactions');
  }
  if (
    !Array.isArray(report.motions)
    || report.motions.some((item) => (
      item?.timingPassed !== true
      || item?.interruptionPassed !== true
      || item?.reducedMotionPassed !== true
    ))
  ) {
    add(blockers, 'UIHTML_MOTION_PARITY_FAILED', 'Motion 时序、打断或 reduced-motion 未通过。', 'motions');
  }
  if (
    !Array.isArray(report.visualComparisons)
    || !report.visualComparisons.length
    || report.visualComparisons.some((item) => (
      !item.figmaNodeId
      || !item.viewport
      || typeof item.differenceRatio !== 'number'
      || typeof item.threshold !== 'number'
      || item.differenceRatio < 0
      || item.threshold < 0
      || item.differenceRatio > item.threshold
    ))
  ) {
    add(blockers, 'UIHTML_VISUAL_PARITY_FAILED', '确认范围的 Figma 节点/Viewport 视觉差异超阈值或缺证据。', 'visualComparisons');
  }
  if (
    !/^sha256:[a-f0-9]{64}$/i.test(report.productHash ?? '')
    || report.productHash !== report.productHashAfterReviewCaseChange
  ) {
    add(blockers, 'UIHTML_HASH_BOUNDARY_INVALID', 'Review/Mock/Case 变化影响了 UIHTML 内容哈希。', 'productHash');
  }
  try {
    const actualHash = await hashUihtml(uihtmlRoot);
    if (actualHash !== report.productHash) {
      add(blockers, 'UIHTML_HASH_BOUNDARY_INVALID', '验收报告未绑定当前 UIHTML 内容哈希。', 'productHash');
    }
  } catch (error) {
    add(blockers, 'UIHTML_RUNTIME_DEP_MISSING', error instanceof Error ? error.message : String(error), 'UIHTML');
  }
  if (schemaValid && Array.isArray(report.interactions) && report.interactions.length) {
    try {
      const routes = [...new Set(report.interactions
        .map((item) => item?.route)
        .filter((route) => typeof route === 'string' && route.startsWith('/')))];
      if (!routes.length) {
        add(blockers, 'UIHTML_INTERACTION_PARITY_FAILED', '验收报告没有可执行的绝对 Route。', 'interactions');
      } else {
        const failures = await verifyRuntime(uihtmlRoot, routes);
        for (const failure of failures) {
          add(
            blockers,
            'UIHTML_RUNTIME_DEP_MISSING',
            `Route ${failure.route} 运行失败：${failure.failures.join('; ')}`,
            failure.route,
          );
        }
      }
    } catch (error) {
      add(blockers, 'UIHTML_RUNTIME_DEP_MISSING', error instanceof Error ? error.message : String(error), 'UIHTML');
    }
  }
  console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', blockers }));
  process.exitCode = blockers.length ? 1 : 0;
} catch (error) {
  console.log(JSON.stringify({
    status: 'BLOCKED',
    blockers: [{ code: 'UIHTML_RUNTIME_DEP_MISSING', message: error instanceof Error ? error.message : String(error) }],
  }));
  process.exitCode = 1;
}
