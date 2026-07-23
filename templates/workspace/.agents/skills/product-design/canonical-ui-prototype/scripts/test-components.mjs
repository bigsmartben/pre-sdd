import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import playwright from '@playwright/test';
import { createServer } from 'vite';
import { artifactCollectionMembers, artifactMemberPath, artifactPaths, loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';
import { createRepairDiagnostic } from './lib/repair-diagnostics.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const actorIndex = process.argv.indexOf('--actor');
const requestedActor = actorIndex >= 0 ? process.argv[actorIndex + 1] : null;
const startedAt = performance.now();
const componentFilter = new Set(process.argv.flatMap((value, index) => value === '--component' && process.argv[index + 1] ? [process.argv[index + 1]] : []));
const require = createRequire(process.env.PRE_SDD_DEPENDENCY_ENTRY || process.env.PRE_SDD_RUNTIME_ENTRY || import.meta.url);
const { chromium } = playwright;

if (!requestedActor) {
  const { project } = await loadProjectAndManifest(root);
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const members = await artifactCollectionMembers(root, paths);
  const blockers = [];
  const evidence = [];
  const evidenceRoots = [];
  const metrics = [];
  for (const member of members) {
    const child = spawnSync(process.execPath, [process.argv[1], '--actor', member.actor, '--json', ...[...componentFilter].flatMap((value) => ['--component', value])], { cwd: root, encoding: 'utf8', env: process.env, windowsHide: true });
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
  url.searchParams.set('annotate', '0');
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

try {
  const { project } = await loadProjectAndManifest(root);
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
    if (!mapping || !defaultEntry) continue;
    await page.goto(matrixUrl(base, defaultEntry), { waitUntil: 'networkidle' });
    const registered = await page.evaluate((tagName) => Boolean(customElements.get(tagName)), contract.litTagName);
    if (!registered) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Lit Tag 未注册：' + contract.litTagName, contract.id, true);
    for (const instance of contract.pageInstances) {
      const selector = instance.figmaInstanceNodeId
        ? '[data-figma-instance-id="' + instance.figmaInstanceNodeId + '"]'
        : '[data-component-instance-id="' + instance.id + '"]';
      const element = page.locator(selector);
      if (await element.count() !== 1) {
        block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Component Contract 页面实例未唯一挂载：' + instance.id, contract.id, true);
        continue;
      }
      if (!instance.figmaInstanceNodeId) {
        if (await element.getAttribute('data-component-owner-id') !== contract.componentId) {
          block('AIH_COMPONENT_CONTRACT_TEST_FAILED', '本地页面实例未声明所属 Component：' + instance.id, contract.id, true);
        }
        continue;
      }
      if (await element.evaluate((node) => node.tagName.toLowerCase()) !== contract.litTagName) {
        block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Figma 页面实例未使用 Contract Lit Tag：' + instance.id, contract.id, true);
      }
      for (const property of contract.properties) {
        if (!Object.hasOwn(property, 'defaultValue')) continue;
        const actual = await element.evaluate((node, name) => node[name], property.name);
        if (JSON.stringify(actual) !== JSON.stringify(property.defaultValue)) {
          block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Property 默认值不匹配：' + contract.id + ' / ' + property.name, contract.id, true);
        }
      }
      for (const attribute of contract.attributes) {
        const property = contract.properties.find((item) => item.name === attribute.propertyName);
        if (!property || !Object.hasOwn(property, 'defaultValue')) continue;
        const actual = await element.getAttribute(attribute.name);
        if (actual !== String(property.defaultValue)) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Attribute 默认值不匹配：' + contract.id + ' / ' + attribute.name, contract.id, true);
      }
      for (const slot of contract.slots) {
        const assigned = await element.evaluate((node, name) => [...node.children].some((child) => child.getAttribute('slot') === name), slot);
        if (!assigned) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Contract Slot 未在实例中使用：' + contract.id + ' / ' + slot, contract.id, true);
      }
    }

    const coveredStates = new Set();
    const legalEntries = model.stateMatrix.filter((item) => item.componentContractId === contract.id && item.classification === 'legal');
    for (const entry of legalEntries) {
      await page.goto(matrixUrl(base, entry), { waitUntil: 'networkidle' });
      const axes = model.stateAxes.filter((axis) => axis.componentContractId === contract.id);
      const runtimeAxis = axes.find((axis) => axis.kind === 'runtime-state');
      const runtimeState = runtimeAxis?.values.find((value) => value.id === entry.values[runtimeAxis.id])?.stateId;
      if (runtimeState) {
        coveredStates.add(runtimeState);
        const state = page.locator('[data-component-state="' + runtimeState + '"]').first();
        if (await state.count() === 0 || !await state.isVisible()) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', '独立挂载未呈现 Runtime State：' + entry.id + ' / ' + runtimeState, contract.id, true);
      }
      for (const axis of axes.filter((item) => item.kind === 'variant')) {
        const selected = axis.values.find((value) => value.id === entry.values[axis.id]);
        const property = mapping.propertyMappings.find((item) => item.kind === 'variant' && item.figmaProperty === axis.name);
        const expected = property?.values.find((item) => item.figmaValue === selected?.value)?.litValue;
        const instance = page.locator('[data-component-id="' + contract.componentId + '"]').first();
        if (!property?.litAttribute || await instance.getAttribute(property.litAttribute) !== expected) {
          block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Variant 未通过声明的 Lit Attribute 实际渲染：' + entry.id + ' / ' + axis.name, contract.id, true);
        }
      }
      await page.goto(matrixUrl(base, entry), { waitUntil: 'networkidle' });
      const visibleStates = [];
      for (const stateId of model.components.find((item) => item.id === contract.componentId)?.stateIds || []) {
        const target = page.locator('[data-component-state="' + stateId + '"]').first();
        if (await target.count() > 0 && await target.isVisible()) visibleStates.push(stateId);
      }
      if (visibleStates.length !== 1) block('AIH_COMPONENT_CONTRACT_TEST_FAILED', '独立挂载违反组件状态互斥：' + entry.id + ' / ' + visibleStates.join(', '), contract.id, true);
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
        if (!preceding) continue;
        await page.locator('[data-control-id="' + preceding.controlId + '"][data-event-id="' + preceding.id + '"]').click();
        await page.waitForTimeout(700);
      }
      const control = page.locator('[data-control-id="' + event.controlId + '"][data-event-id="' + event.id + '"]');
      if (await control.count() !== 1 || await control.getAttribute('data-action-id') !== action.id) {
        block('AIH_COMPONENT_CONTRACT_TEST_FAILED', 'Event 未绑定唯一声明 Action：' + eventId, contract.id);
        continue;
      }
      await stateTrace(page);
      await control.click();
      await page.waitForTimeout(700);
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

    await page.screenshot({ path: currentRepairContext.screenshot, fullPage: true, animations: 'disabled' });
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
