import { access, mkdtemp, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { parse as parseYaml } from 'yaml';
import {
  artifactPaths,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const json = process.argv.includes('--json');
const blockers = [];
const warnings = [];
const evidence = [];

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForServer(url, processHandle) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error('Vite preview 已提前退出。');
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('等待 Vite preview 超时。');
}

async function performAction(locator, step) {
  if (step.action === 'click') await locator.click();
  else if (step.action === 'fill') await locator.fill(step.input);
  else if (step.action === 'select') await locator.selectOption(step.input);
  else if (step.action === 'press') await locator.press(step.input);
  else if (step.action === 'check') await locator.check();
  else if (step.action === 'uncheck') await locator.uncheck();
  else throw new Error('不支持的操作：' + step.action);
}

async function launchChromium() {
  const attempts = [];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    attempts.push({ label: 'configured executable', options: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } });
  }
  attempts.push(
    { label: 'Playwright Chromium', options: {} },
    { label: 'Google Chrome', options: { channel: 'chrome' } },
    { label: 'Microsoft Edge', options: { channel: 'msedge' } },
  );
  const errors = [];
  for (const attempt of attempts) {
    try {
      return { browser: await chromium.launch({ headless: true, ...attempt.options }), runtime: attempt.label };
    } catch (error) {
      errors.push(attempt.label + ': ' + error.message);
    }
  }
  throw new Error(errors.join(' | '));
}

let project;
let serverProcess;
let browser;
let evidenceRoot;
let scenarioRuns = 0;
let browserRuntime = null;
try {
  ({ project } = await loadProjectAndManifest(root));
  const stage = project.stages?.['product-design'];
  if (!stage || stage.status !== 'active') {
    block(stage?.status === 'uninitialized' ? 'AIH_STAGE_UNINITIALIZED' : 'AIH_PROJECT_BINDING_INVALID', '产品设计阶段不可运行 HTML Mock 浏览器验证。');
  } else {
    const paths = artifactPaths(project, 'ui-spec', 'product-design');
    const uiSpec = parseYaml(await readFile(repositoryFile(root, paths.internalModel), 'utf8'));
    if (!uiSpec.htmlMocks?.length && uiSpec.metadata?.status === 'draft') {
      warnings.push('HTML Mock 仍为无正式实例的 draft；浏览器场景验证未执行。');
    } else if (!uiSpec.htmlMocks?.length || !uiSpec.interactionScenarios?.length || !uiSpec.viewports?.some((item) => item.required)) {
      block('AIH_HTML_MOCK_RUNTIME_FAILED', '浏览器验证要求 HTML Mock、操作场景和 required viewport。', 'ui-spec');
    } else {
      const areaRoot = stage.areas?.['html-mock']?.root;
      const areaPath = repositoryFile(root, stage.root + '/' + areaRoot);
      await access(repositoryFile(root, stage.root + '/' + areaRoot + '/dist/index.html'));
      const port = await freePort();
      const baseUrl = 'http://127.0.0.1:' + port;
      const vitePath = repositoryFile(root, 'node_modules/vite/bin/vite.js');
      let serverErrors = '';
      serverProcess = spawn(process.execPath, [vitePath, 'preview', '--host', '127.0.0.1', '--port', String(port)], {
        cwd: areaPath,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      serverProcess.stderr.on('data', (chunk) => { serverErrors += String(chunk); });
      await waitForServer(baseUrl, serverProcess);
      try {
        const launched = await launchChromium();
        browser = launched.browser;
        browserRuntime = launched.runtime;
      } catch (error) {
        block('AIH_BROWSER_UNAVAILABLE', 'Chromium 不可用；先运行 npm run install:browser。' + error.message);
      }
      if (browser) {
        evidenceRoot = await mkdtemp(join(tmpdir(), 'psp-html-mock-evidence-'));
        const requiredViewports = uiSpec.viewports.filter((item) => item.required);
        const bindings = (uiSpec.assetBindings || []).filter((item) => item.status === 'localized');
        for (const mock of uiSpec.htmlMocks) {
          const scenarios = uiSpec.interactionScenarios.filter((item) => item.htmlMock === mock.id);
          for (const viewport of requiredViewports) {
            const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
            page.setDefaultTimeout(5_000);
            try {
              await page.goto(new URL(mock.route, baseUrl).href, { waitUntil: 'networkidle' });
              for (const mapping of mock.screens) await page.locator(mapping.selector).waitFor({ state: 'visible' });
              for (const binding of bindings.filter((item) => item.htmlMocks.includes(mock.id))) {
                for (const usage of binding.usages.filter((item) => item.htmlMock === mock.id && item.scenario === null)) {
                  await page.locator(usage.selector).waitFor({ state: 'visible' });
                }
              }
              const initialOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
              if (initialOverflow > 1) throw new Error('页面存在横向溢出：' + initialOverflow + 'px');
              const initialPath = join(evidenceRoot, mock.id + '-' + viewport.id + '-initial.png');
              await page.screenshot({ path: initialPath, fullPage: true });
              evidence.push({ htmlMock: mock.id, viewport: viewport.id, scenario: null, path: initialPath });
              for (const scenario of scenarios) {
                await page.goto(new URL(scenario.startRoute, baseUrl).href, { waitUntil: 'networkidle' });
                for (const step of scenario.steps) {
                  const target = page.locator(step.target);
                  await target.waitFor({ state: 'visible' });
                  await performAction(target, step);
                  const screen = mock.screens.find((item) => item.screen === step.expectedScreen);
                  if (!screen) throw new Error('场景引用未映射 Screen：' + step.expectedScreen);
                  await page.locator(screen.selector).waitFor({ state: 'visible' });
                  await page.locator('[data-state-id="' + step.expectedState + '"]').waitFor({ state: 'visible' });
                  await page.getByText(step.expectedFeedback, { exact: false }).waitFor({ state: 'visible' });
                }
                for (const binding of bindings.filter((item) => item.htmlMocks.includes(mock.id))) {
                  for (const usage of binding.usages.filter((item) => item.htmlMock === mock.id && item.scenario === scenario.id)) {
                    await page.locator(usage.selector).waitFor({ state: 'visible' });
                  }
                }
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
                if (overflow > 1) throw new Error('场景结束页面存在横向溢出：' + overflow + 'px');
                const screenshotPath = join(evidenceRoot, mock.id + '-' + viewport.id + '-' + scenario.id + '.png');
                await page.screenshot({ path: screenshotPath, fullPage: true });
                evidence.push({ htmlMock: mock.id, viewport: viewport.id, scenario: scenario.id, path: screenshotPath });
                scenarioRuns += 1;
              }
            } catch (error) {
              block('AIH_HTML_MOCK_RUNTIME_FAILED', mock.id + ' / ' + viewport.id + '：' + error.message, 'ui-spec.htmlMocks.' + mock.id);
            } finally {
              await page.close();
            }
          }
        }
      }
      if (serverProcess.exitCode !== null && blockers.length === 0) {
        block('AIH_HTML_MOCK_RUNTIME_FAILED', 'Vite preview 异常退出：' + serverErrors.trim());
      }
    }
  }
} catch (error) {
  block(error.code === 'ENOENT' ? 'AIH_HTML_MOCK_RUNTIME_FAILED' : (error.code || 'AIH_HTML_MOCK_RUNTIME_FAILED'), error.message);
} finally {
  if (browser) await browser.close();
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
}

const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  gate: 'html-mock-runtime',
  scenarioRuns,
  browserRuntime,
  screenshotCount: evidence.length,
  evidenceRoot: evidenceRoot || null,
  evidence,
  blockerCount: blockers.length,
  blockers,
  warnings,
};

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') {
  if (warnings.length) for (const warning of warnings) console.warn('[WARN] ' + warning);
  console.log('[PASS] HTML Mock 浏览器场景验证通过；场景运行 ' + scenarioRuns + ' 次，截图 ' + evidence.length + ' 张。');
} else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);

if (result.status !== 'PASS') process.exitCode = 1;
