import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import playwright from '@playwright/test';
import { createServer } from 'vite';
import { artifactCollectionMembers, artifactMemberPath, artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../../runtime/project.mjs';
import { extractCanonicalUi } from './extract.mjs';
import { createRepairDiagnostic } from './lib/repair-diagnostics.mjs';
import { verifyMatrixMount } from './lib/verify-matrix-mount.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const actorIndex = process.argv.indexOf('--actor');
const requestedActor = actorIndex >= 0 ? process.argv[actorIndex + 1] : null;
const startedAt = performance.now();
const componentFilter = new Set(process.argv.flatMap((value, index) => value === '--component' && process.argv[index + 1] ? [process.argv[index + 1]] : []));
const require = createRequire(process.env.PRE_SDD_DEPENDENCY_ENTRY || process.env.PRE_SDD_RUNTIME_ENTRY || import.meta.url);
const { chromium } = playwright;

if (!requestedActor) {
  const project = await loadProject(root);
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const members = await artifactCollectionMembers(root, paths);
  const blockers = [];
  const evidence = [];
  const evidenceRoots = [];
  const metrics = [];
  for (const member of members) {
    const child = spawnSync(process.execPath, [process.argv[1], '--actor', member.actor, '--json', ...[...componentFilter].flatMap((value) => ['--component', value])], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024,
    });
    try {
      const parsed = JSON.parse(child.stdout || '{}');
      blockers.push(...(parsed.blockers || []).map((item) => ({ actor: member.actor, ...item })));
      evidence.push(...(parsed.evidence || []).map((item) => ({ actor: member.actor, ...item })));
      if (parsed.evidenceRoot) evidenceRoots.push({ actor: member.actor, path: parsed.evidenceRoot });
      if (parsed.metrics) metrics.push({ actor: member.actor, ...parsed.metrics });
    }
    catch { blockers.push({ actor: member.actor, code: 'AIH_COMPONENT_CONTRACT_TEST_FAILED', message: child.stderr || '组件契约测试没有返回 JSON。' }); }
  }
  if (members.length === 0) blockers.push({ code: 'AIH_ARTIFACT_INCOMPLETE', message: '尚未创建参与者 Canonical UI 应用。', location: paths.authorityRoot });
  const result = { status: blockers.length === 0 ? 'PASS' : 'BLOCKED', actors: members.map((item) => item.actor), blockers, evidence, evidenceRoots, metrics };
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'PASS') console.log('[PASS] 全部参与者 Component Contract 测试通过。');
  else blockers.forEach((item) => console.error('[' + item.code + '] ' + item.message));
  process.exit(result.status === 'PASS' ? 0 : 1);
}

const blockers = [];
const blockerKeys = new Set();
const evidence = [];
let server;
let browser;
let evidenceRoot;
let currentRepairContext = null;

function block(code, message, location, repairable = false) {
  let diagnosticId = null;
  if (repairable && currentRepairContext) {
    const item = createRepairDiagnostic('canonical-ui-contract-tests', {
      blockerCode: code,
      defectClass: 'component-contract',
      message,
      location: location || currentRepairContext.location,
      scope: currentRepairContext.scope,
      check: { kind: 'component-contract' },
      evidence: [{ kind: 'actual-screenshot', path: currentRepairContext.screenshot }],
    });
    evidence.push(item);
    diagnosticId = item.diagnosticId;
  }
  const key = [code, message, location || '', diagnosticId || ''].join('|');
  if (blockerKeys.has(key)) return;
  blockerKeys.add(key);
  blockers.push({ code, message, ...(location ? { location } : {}), ...(diagnosticId ? { diagnosticId } : {}) });
}

function selectorForId(id) {
  return ['data-component-id', 'data-control-id', 'data-component-state', 'data-state-id']
    .map((attribute) => '[' + attribute + '="' + id + '"]').join(',');
}

function matrixUrl(base, entry) {
  const url = new URL('/', base);
  url.searchParams.set('__pspComponentContract', entry.componentContractId);
  url.searchParams.set('__pspStateMatrix', entry.id);
  url.searchParams.set('review', '0');
  return url.href;
}

async function stateTrace(page) {
  await page.evaluate(() => {
    const values = [];
    let previous = '';
    const roots = [document, ...[...document.querySelectorAll('*')].map((node) => node.shadowRoot).filter(Boolean)];
    const scan = () => {
      for (const root of roots) {
        for (const node of root.querySelectorAll('[data-component-state]')) {
          const value = node.getAttribute('data-component-state');
          if (value && value !== previous) { values.push(value); previous = value; }
        }
      }
    };
    const observers = roots.map((root) => {
      const observer = new MutationObserver(scan);
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-component-state'] });
      return observer;
    });
    globalThis.__pspComponentContractTrace = { values, observers };
    scan();
  });
}

async function stopTrace(page) {
  return page.evaluate(() => {
    const trace = globalThis.__pspComponentContractTrace;
    trace?.observers.forEach((observer) => observer.disconnect());
    return trace?.values || [];
  });
}

async function waitForContractTrace(page, expectedStateIds) {
  try {
    await page.waitForFunction((expected) => {
      const observed = globalThis.__pspComponentContractTrace?.values || [];
      let expectedIndex = 0;
      for (const stateId of observed) {
        if (stateId === expected[expectedIndex]) expectedIndex += 1;
        if (expectedIndex === expected.length) return true;
      }
      return false;
    }, expectedStateIds, { timeout: 3000 });
  } catch {
    // The caller reports the observed sequence after stopping the trace.
  }
}

try {
  const project = await loadProject(root);
  if (!['active', 'published'].includes(project.stages?.['product-design']?.status)) {
    throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  }
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const authorityPath = artifactMemberPath(paths, requestedActor);
  const model = await extractCanonicalUi(root, authorityPath);
  const areaPath = repositoryFile(root, paths.authorityRoot + '/' + requestedActor);
  evidenceRoot = await mkdtemp(join(tmpdir(), 'psp-canonical-ui-contract-'));
  server = await createServer({
    root: areaPath,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: [
      { find: 'lit', replacement: require.resolve('lit') },
      { find: 'msw/browser', replacement: require.resolve('msw/browser') },
      { find: 'msw', replacement: require.resolve('msw') },
    ] },
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const base = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true });
  const viewport = model.viewports[0] || { width: 1280, height: 900 };
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const page = await context.newPage();

  const selectedContracts = model.componentContracts.filter((item) => componentFilter.size === 0 || componentFilter.has(item.componentId));
  if (componentFilter.size > 0 && selectedContracts.length !== componentFilter.size) block('AIH_INCREMENTAL_SCOPE_INVALID', '组件契约增量测试引用未知 Component。', [...componentFilter].join(', '));
  for (const contract of selectedContracts) {
    currentRepairContext = {
      location: contract.id,
      scope: { contractId: contract.id, componentId: contract.componentId },
      screenshot: join(evidenceRoot, contract.id + '.png'),
    };
    const mapping = model.componentMappings.find((item) => item.id === contract.mappingId);
    const defaultEntry = model.stateMatrix.find((item) => item.id === contract.defaultStateMatrixEntryId);
    if (!defaultEntry || (contract.mappingId && !mapping)) continue;
    await page.goto(matrixUrl(base, defaultEntry), { waitUntil: 'networkidle' });
    const registered = await page.evaluate((tagName) => Boolean(customElements.get(tagName)), contract.litTagName);
    if (!registered) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Lit Tag 未注册：' + contract.litTagName, contract.id, true);
    const defaultHost = await verifyMatrixMount({
      surface: page,
      model,
      contract,
      entry: defaultEntry,
      mapping,
      block: (code, message, location) => block(code, message, location, true),
      code: 'AIH_COMPONENT_CONTRACT_TEST_FAILED',
      location: contract.id,
    });
    if (defaultHost) {
      const contentAxes = model.stateAxes
        .filter((axis) => axis.componentContractId === contract.id && axis.kind === 'content-override');
      const contentBindings = new Set(contentAxes.map((axis) => axis.renderBinding.name).filter(Boolean));
      const contentBoundProperties = new Set(contentAxes.flatMap((axis) => {
        if (axis.renderBinding.kind === 'lit-property') return [axis.renderBinding.name];
        if (axis.renderBinding.kind !== 'lit-attribute') return [];
        const attribute = contract.attributes.find((item) => item.name === axis.renderBinding.name);
        return attribute ? [attribute.propertyName] : [];
      }));
      for (const property of contract.properties) {
        if (!Object.hasOwn(property, 'defaultValue') || contentBoundProperties.has(property.name)) continue;
        const actual = await defaultHost.evaluate((node, name) => node[name], property.name);
        if (JSON.stringify(actual) !== JSON.stringify(property.defaultValue)) {
          block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Property 默认值不匹配：' + contract.id + ' / ' + property.name, contract.id, true);
        }
      }
      for (const attribute of contract.attributes) {
        if (contentBindings.has(attribute.name)) continue;
        const property = contract.properties.find((item) => item.name === attribute.propertyName);
        if (!property || !Object.hasOwn(property, 'defaultValue')) continue;
        const actual = await defaultHost.getAttribute(attribute.name);
        if (actual !== String(property.defaultValue)) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Attribute 默认值不匹配：' + contract.id + ' / ' + attribute.name, contract.id, true);
      }
    }

    const coveredStates = new Set();
    const legalEntries = model.stateMatrix.filter((item) => item.componentContractId === contract.id && item.classification === 'legal');
    for (const entry of legalEntries) {
      await page.goto(matrixUrl(base, entry), { waitUntil: 'networkidle' });
      const axes = model.stateAxes.filter((axis) => axis.componentContractId === contract.id);
      const runtimeAxis = axes.find((axis) => axis.kind === 'runtime-state');
      const runtimeState = runtimeAxis?.values.find((value) => value.id === entry.values[runtimeAxis.id])?.stateId;
      if (runtimeState) coveredStates.add(runtimeState);
      await verifyMatrixMount({
        surface: page,
        model,
        contract,
        entry,
        mapping,
        block: (code, message, location) => block(code, message, location, true),
        code: 'AIH_COMPONENT_CONTRACT_TEST_FAILED',
        location: contract.id,
      });
    }
    for (const stateId of model.components.find((item) => item.id === contract.componentId)?.stateIds || []) {
      if (!coveredStates.has(stateId)) block('AIH_COMPONENT_CONTRACT_COVERAGE_FAILED', '组件 State 缺少独立 Contract Test：' + contract.id + ' / ' + stateId, contract.id);
    }

    for (const eventId of contract.eventIds) {
      const event = model.events.find((item) => item.id === eventId);
      const action = model.actions.find((item) => item.eventId === eventId);
      if (!event || !action) continue;
      await page.goto(matrixUrl(base, defaultEntry), { waitUntil: 'networkidle' });
      const scenario = model.scenarios.find((item) => item.eventIds.includes(eventId));
      const precedingEventIds = scenario ? scenario.eventIds.slice(0, scenario.eventIds.indexOf(eventId)) : [];
      for (const precedingEventId of precedingEventIds) {
        const preceding = model.events.find((item) => item.id === precedingEventId);
        const precedingAction = model.actions.find((item) => item.eventId === precedingEventId);
        if (!preceding) continue;
        await page.locator('[data-control-id="' + preceding.controlId + '"][data-event-id="' + preceding.id + '"]').click();
        const finalStateId = precedingAction?.resultingStateIds.at(-1);
        if (finalStateId) {
          try {
            await page.locator('[data-component-state="' + finalStateId + '"]').first().waitFor({
              state: 'visible',
              timeout: 3000,
            });
          } catch {
            // The target Event assertion below remains authoritative.
          }
        }
      }
      const control = page.locator('[data-control-id="' + event.controlId + '"][data-event-id="' + event.id + '"]');
      if (await control.count() !== 1 || await control.getAttribute('data-action-id') !== action.id) {
        block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Event 未绑定唯一声明 Action：' + eventId, contract.id);
        continue;
      }
      await stateTrace(page);
      await control.click();
      await waitForContractTrace(page, action.resultingStateIds);
      const observed = await stopTrace(page);
      let expectedIndex = 0;
      for (const stateId of observed) if (stateId === action.resultingStateIds[expectedIndex]) expectedIndex += 1;
      if (expectedIndex !== action.resultingStateIds.length) {
        block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Event 的状态迁移顺序不匹配：' + eventId + '，观测到 ' + observed.join(' → '), contract.id);
      }
    }

    for (const assertion of contract.testAssertions) {
      const entry = model.stateMatrix.find((item) => item.id === assertion.stateMatrixEntryId) || defaultEntry;
      await page.goto(matrixUrl(base, entry), { waitUntil: 'networkidle' });
      const target = page.locator(selectorForId(assertion.targetId)).first();
      if (await target.count() === 0) {
        block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Contract Test Assertion 目标不存在：' + assertion.targetId, contract.id, true);
        continue;
      }
      if (assertion.kind === 'accessible-name') {
        const name = ((await target.getAttribute('aria-label')) || (await target.textContent()) || '').trim();
        if (!name) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', '目标缺少关键可访问名称：' + assertion.targetId, contract.id, true);
      } else if (assertion.kind === 'focusable') {
        await target.focus();
        if (!await target.evaluate((node) => node.getRootNode().activeElement === node)) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', '目标不可聚焦：' + assertion.targetId, contract.id, true);
      } else if (assertion.kind === 'disabled') {
        if (await target.isDisabled() !== assertion.expected) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', '目标 Disabled 状态不匹配：' + assertion.targetId, contract.id, true);
      } else if (assertion.kind === 'aria') {
        const values = await page.locator(selectorForId(assertion.targetId)).evaluateAll((nodes, attribute) => nodes.map((node) => node.getAttribute(attribute)), assertion.attribute);
        if (!values.includes(assertion.expected)) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', '目标 ARIA 语义不匹配：' + assertion.targetId + ' / ' + assertion.attribute, contract.id, true);
      }
    }

    const preview = page.locator('[data-component-preview]').first();
    if (await preview.count() === 1) await preview.screenshot({ path: currentRepairContext.screenshot, animations: 'disabled' });
    else await page.screenshot({ path: currentRepairContext.screenshot, fullPage: true, animations: 'disabled' });
  }
  await context.close();
} catch (error) {
  block(error.code || 'AIH_COMPONENT_CONTRACT_TEST_FAILED', error.message);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  blockers,
  evidence,
  evidenceRoot,
  metrics: { totalDurationMs: Math.round(performance.now() - startedAt), components: [...componentFilter] },
};
if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Component Contract 浏览器测试通过。');
else blockers.forEach((item) => console.error('[' + item.code + '] ' + item.message));
if (result.status !== 'PASS') process.exitCode = 1;
