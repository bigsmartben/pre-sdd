import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import playwright from '@playwright/test';
import Ajv2020 from 'ajv/dist/2020.js';
import { createServer } from 'vite';
import { artifactCollectionMembers, artifactDefinition, artifactMemberPath, artifactPaths, loadProject, readStructured, repositoryFile, repositoryRootFrom } from '../../../../runtime/project.mjs';
import { extractCanonicalUi } from './extract.mjs';
import { findFigmaVisualBypasses } from './lib/figma-css-policy.mjs';
import { createRepairDiagnostic } from './lib/repair-diagnostics.mjs';
import { verifyMatrixMount } from './lib/verify-matrix-mount.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const { chromium } = playwright;
const PRODUCT_SCREENSHOT_STYLE = '[data-review-tool]{display:none!important}';
const require = createRequire(process.env.PRE_SDD_DEPENDENCY_ENTRY || process.env.PRE_SDD_RUNTIME_ENTRY || import.meta.url);
const json = process.argv.includes('--json');
const actorIndex = process.argv.indexOf('--actor');
const requestedActor = actorIndex >= 0 ? process.argv[actorIndex + 1] : null;
const startedAt = performance.now();
const valuesFor = (name) => process.argv.flatMap((value, index) => value === '--' + name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
const routeFilter = new Set(valuesFor('route'));
const viewportFilter = new Set(valuesFor('viewport'));
const scenarioFilter = new Set(valuesFor('scenario'));
const componentFilter = new Set(valuesFor('component'));
const skipVisualDiagnostics = process.argv.includes('--skip-visual-diagnostics');
const skipStateGallery = process.argv.includes('--skip-state-gallery');
const forwardedFilters = [
  ...[...routeFilter].flatMap((value) => ['--route', value]),
  ...[...viewportFilter].flatMap((value) => ['--viewport', value]),
  ...[...scenarioFilter].flatMap((value) => ['--scenario', value]),
  ...[...componentFilter].flatMap((value) => ['--component', value]),
  ...(skipVisualDiagnostics ? ['--skip-visual-diagnostics'] : []),
  ...(skipStateGallery ? ['--skip-state-gallery'] : []),
];

if (!requestedActor) {
  const project = await loadProject(root);
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const members = await artifactCollectionMembers(root, paths);
  const aggregateBlockers = [];
  const aggregateEvidence = [];
  const evidenceRoots = [];
  const reviewAddresses = [];
  const metrics = [];
  for (const member of members) {
    const child = spawnSync(process.execPath, [process.argv[1], '--actor', member.actor, '--json', ...forwardedFilters], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
      maxBuffer: 128 * 1024 * 1024,
    });
    try {
      const result = JSON.parse(child.stdout || '{}');
      aggregateBlockers.push(...(result.blockers || []));
      aggregateEvidence.push(...(result.evidence || []).map((item) => ({ actor: member.actor, ...item })));
      if (result.evidenceRoot) evidenceRoots.push({ actor: member.actor, path: result.evidenceRoot });
      if (result.reviewAddress) reviewAddresses.push({ actor: member.actor, address: result.reviewAddress });
      if (result.metrics) metrics.push({ actor: member.actor, ...result.metrics });
    } catch {
      aggregateBlockers.push({ code: 'AIH_VALIDATION_FAILED', message: child.stderr || '参与者运行时校验没有返回 JSON。', location: member.actor });
    }
  }
  if (members.length === 0) aggregateBlockers.push({ code: 'AIH_ARTIFACT_INCOMPLETE', message: '尚未创建参与者 Canonical UI 应用。', location: paths.authorityRoot });
  const aggregate = { status: aggregateBlockers.length === 0 ? 'PASS' : 'BLOCKED', actors: members.map((member) => member.actor), blockers: aggregateBlockers, evidence: aggregateEvidence, evidenceRoots, reviewAddresses, metrics };
  if (json) console.log(JSON.stringify(aggregate, null, 2));
  else if (aggregate.status === 'PASS') console.log('[PASS] 全部参与者 Canonical UI 浏览器验收通过。');
  else for (const item of aggregateBlockers) console.error('[' + item.code + '] ' + item.message);
  process.exit(aggregate.status === 'PASS' ? 0 : 1);
}
const blockers = [];
const blockerKeys = new Set();
const evidence = [];
const loadedAssets = new Set();
const usedAssetTargets = new Map();
const usedTokenTargets = new Map();
const tokenFailureKeys = new Set();
const implementationSourceCache = new Map();
let server;
let browser;
let evidenceRoot;
let reviewAddress;
let visualDiagnosticDurationMs = 0;
let currentRepairContext = null;

function block(code, message, location, diagnosticId = null) {
  let effectiveDiagnosticId = diagnosticId;
  const automaticClass = {
    AIH_COMPONENT_IMPLEMENTATION_MISMATCH: 'html-structure',
    AIH_CANONICAL_UI_ACCESSIBILITY_FAILED: 'html-accessibility',
  }[code];
  if (!effectiveDiagnosticId && automaticClass && currentRepairContext) {
    const item = createRepairDiagnostic('canonical-ui-runtime', {
      blockerCode: code,
      defectClass: automaticClass,
      message,
      location: location || currentRepairContext.location,
      scope: currentRepairContext.scope,
      check: { kind: automaticClass },
      evidence: [{ kind: 'actual-screenshot', path: currentRepairContext.screenshot }],
    });
    evidence.push(item);
    effectiveDiagnosticId = item.diagnosticId;
  }
  const key = [code, message, location || '', effectiveDiagnosticId || ''].join('|');
  if (blockerKeys.has(key)) return;
  blockerKeys.add(key);
  blockers.push({ code, message, ...(location ? { location } : {}), ...(effectiveDiagnosticId ? { diagnosticId: effectiveDiagnosticId } : {}) });
}

function repairBlock(code, message, location, diagnostic) {
  const item = createRepairDiagnostic('canonical-ui-runtime', {
    blockerCode: code,
    message,
    location,
    ...diagnostic,
  });
  evidence.push(item);
  block(code, message, location, item.diagnosticId);
}

function componentContractBlock(message, location, contract, instance, check) {
  if (currentRepairContext) {
    evidence.push(createRepairDiagnostic('canonical-ui-runtime', {
      blockerCode: 'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
      defectClass: 'component-contract',
      message,
      location,
      scope: {
        ...currentRepairContext.scope,
        componentId: contract.componentId,
        componentContractId: contract.id,
        pageInstanceId: instance.id,
      },
      check,
      evidence: [{ kind: 'actual-screenshot', path: currentRepairContext.screenshot }],
    }));
  }
  block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', message, location);
}

function routeScreenshotPath(routeId, viewportId, scenarioId = null) {
  const kind = scenarioId ? 'scenario' : 'route';
  return join(evidenceRoot, [kind, viewportId, routeId, scenarioId].filter(Boolean).join('-') + '.png');
}

function selectorForId(id) {
  return [
    'data-screen-id',
    'data-component-id',
    'data-component-instance-id',
    'data-control-id',
    'data-state-id',
    'data-component-state',
  ].map((attribute) => '[' + attribute + '="' + id + '"]').join(',');
}

function componentParityTarget(host, contract, assertion, targetId) {
  if (targetId === contract.componentId || targetId === assertion.pageInstanceId) return host;
  return host.locator(selectorForId(targetId));
}

function locatorForId(page, id) {
  return page.locator(selectorForId(id));
}

function tokenOwnerContracts(model, targetId) {
  const component = model.components.find((item) => item.id === targetId);
  const control = model.controls.find((item) => item.id === targetId);
  const state = model.states.find((item) => item.id === targetId);
  const screenId = model.screens.some((item) => item.id === targetId)
    ? targetId
    : state?.scope === 'workflow'
      ? state.ownerId
      : null;
  const componentIds = component
    ? [component.id]
    : control
      ? [control.componentId]
      : state?.scope === 'component'
        ? [state.ownerId]
        : screenId
          ? model.componentContracts
            .filter((contract) => (
              contract.implementationRole === 'app-shell'
              && contract.pageInstances.some((instance) => instance.screenId === screenId)
            ))
            .map((contract) => contract.componentId)
          : [];
  return model.componentContracts.filter((contract) => componentIds.includes(contract.componentId));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function implementationUsesToken(areaPath, contracts, cssProperty) {
  const pattern = new RegExp('var\\(\\s*' + escapeRegExp(cssProperty) + '(?:\\s*,|\\s*\\))');
  for (const implementationPath of new Set(contracts.flatMap((contract) => contract.implementationPaths))) {
    if (!implementationSourceCache.has(implementationPath)) {
      try {
        implementationSourceCache.set(implementationPath, await readFile(resolve(areaPath, implementationPath), 'utf8'));
      } catch {
        implementationSourceCache.set(implementationPath, '');
      }
    }
    if (pattern.test(implementationSourceCache.get(implementationPath))) return true;
  }
  return false;
}

async function implementationSource(areaPath, implementationPath) {
  if (!implementationSourceCache.has(implementationPath)) {
    try {
      implementationSourceCache.set(implementationPath, await readFile(resolve(areaPath, implementationPath), 'utf8'));
    } catch {
      implementationSourceCache.set(implementationPath, '');
    }
  }
  return implementationSourceCache.get(implementationPath);
}

async function validateFigmaImplementationPolicy(model, areaPath) {
  if (model.visualPolicy.mode !== 'exact') return;
  const sourceKinds = new Map(model.designSources.map((source) => [source.id, source.kind]));
  const mappingSources = new Map(model.componentMappings.map((mapping) => [mapping.id, mapping.sourceId]));
  const paths = new Set(
    model.componentContracts
      .filter((contract) => contract.mappingId && sourceKinds.get(mappingSources.get(contract.mappingId)) === 'figma')
      .flatMap((contract) => contract.implementationPaths),
  );
  for (const implementationPath of paths) {
    const source = await implementationSource(areaPath, implementationPath);
    for (const issue of findFigmaVisualBypasses(source)) {
      if (issue.kind === 'css-property') {
        block(
          'AIH_ASSET_CSS_BYPASS',
          'Figma 精确覆盖区域的 CSS 只能负责布局和文字排版；禁止视觉声明：' + issue.property,
          implementationPath,
        );
      } else if (issue.kind === 'pseudo-element') {
        block('AIH_ASSET_CSS_BYPASS', 'Figma 精确覆盖区域禁止使用伪元素绘制视觉内容。', implementationPath);
      } else {
        block('AIH_ASSET_CSS_BYPASS', 'Figma 精确覆盖区域禁止使用内联 SVG 或 Canvas 替代来源资产。', implementationPath);
      }
    }
  }
}

async function observeTokens(page, model, tokens, tokenTargets, areaPath, location, scope, screenshot) {
  for (const token of tokens) {
    if (!usedTokenTargets.has(token.id)) usedTokenTargets.set(token.id, new Set());
    for (const targetId of tokenTargets.get(token.id) || []) {
      const contracts = tokenOwnerContracts(model, targetId);
      const sourceUsesToken = contracts.length === 1
        && await implementationUsesToken(areaPath, contracts, token.cssProperty);
      const target = locatorForId(page, targetId);
      const observedValues = await target.evaluateAll(
        (nodes, cssProperty) => nodes.map((node) => getComputedStyle(node).getPropertyValue(cssProperty).trim()),
        token.cssProperty,
      );
      const expected = String(token.value);
      const computedBindingMatches = observedValues.length > 0
        && observedValues.every((value) => value === expected);
      if (sourceUsesToken && computedBindingMatches) {
        usedTokenTargets.get(token.id).add(targetId);
        continue;
      }
      const failureKey = token.id + '/' + targetId;
      if (tokenFailureKeys.has(failureKey)) continue;
      tokenFailureKeys.add(failureKey);
      repairBlock(
        'AIH_VISUAL_STYLE_BINDING_FAILED',
        'Token 必须在目标所属 Component Contract 实现中通过 CSS var() 消费，且目标必须解析到登记值：'
          + token.id + ' / ' + targetId + ' / ' + token.cssProperty,
        location,
        {
          defectClass: 'css-rendering',
          scope: { ...scope, targetIds: [targetId] },
          check: {
            kind: 'token-consumed',
            expected: true,
            actual: sourceUsesToken && computedBindingMatches,
          },
          evidence: [{ kind: 'actual-screenshot', path: screenshot }],
        },
      );
    }
  }
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
    for (const assertion of [
      ...(model.sourceParityAssertions || []),
      ...(model.componentSourceParityAssertions || []),
    ]) {
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

async function imageDifference(page, expectedDataUrl, channelTolerance, target = null) {
  const actual = target
    ? await target.screenshot({ animations: 'disabled' })
    : await page.screenshot({ fullPage: true, animations: 'disabled', style: PRODUCT_SCREENSHOT_STYLE });
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
    await page.screenshot({ path, fullPage: true, animations: 'disabled', style: PRODUCT_SCREENSHOT_STYLE });
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
  for (const contract of model.componentContracts) {
    const component = model.components.find((item) => item.id === contract.componentId);
    if (!component) continue;
    const hosts = page.locator(contract.litTagName + '[data-component-id="' + contract.componentId + '"]');
    for (let hostIndex = 0; hostIndex < await hosts.count(); hostIndex += 1) {
      const host = hosts.nth(hostIndex);
      const visibleStateIds = [];
      for (const stateId of component.stateIds) {
        const visible = await host.locator('[data-component-state="' + stateId + '"]').evaluateAll((nodes) => nodes.some((node) => {
          const style = getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
        }));
        if (visible || (await host.getAttribute('data-component-state')) === stateId) visibleStateIds.push(stateId);
      }
      if (visibleStateIds.length > 1) {
        block(
          'AIH_CANONICAL_UI_RUNTIME_FAILED',
          '同一组件实例同时暴露多个互斥状态：' + (await host.getAttribute('data-component-instance-id') || contract.id) + ' → ' + visibleStateIds.join(', '),
          location,
        );
      }
    }
  }
}

async function verifyComponentMappings(page, model, screen, location) {
  const contracts = model.componentContracts.filter((contract) => (
    contract.pageInstances.some((instance) => instance.screenId === screen.id)
  ));
  const expectedInstanceIds = new Set();
  const expectedFigmaNodeIds = new Set();
  const shellInstances = contracts.flatMap((contract) => (
    contract.implementationRole === 'app-shell'
      ? contract.pageInstances
        .filter((instance) => instance.screenId === screen.id)
        .map((instance) => ({ contract, instance }))
      : []
  ));
  if (shellInstances.length !== 1) {
    block(
      'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
      '运行页面必须且只能解析一个 app-shell Page Instance：' + screen.id,
      location,
    );
  }

  for (const contract of contracts) {
    const expectedInstances = contract.pageInstances.filter((instance) => instance.screenId === screen.id);
    const registered = await page.evaluate((tagName) => Boolean(customElements.get(tagName)), contract.litTagName);
    if (!registered) block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Lit 自定义元素未注册：' + contract.litTagName, location);
    const renderedHosts = page.locator(contract.litTagName + '[data-component-id="' + contract.componentId + '"]');
    if (await renderedHosts.count() !== expectedInstances.length) {
      block(
        'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
        'Screen 上的 Contract Lit Host 数量与 Page Instance 不一致：' + contract.id,
        location,
      );
    }

    const mapping = contract.mappingId
      ? model.componentMappings.find((item) => item.id === contract.mappingId)
      : null;
    for (const instance of expectedInstances) {
      expectedInstanceIds.add(instance.id);
      const host = page.locator('[data-component-instance-id="' + instance.id + '"]');
      if (await host.count() !== 1) {
        block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Page Instance 必须且只能挂载一次：' + instance.id, location);
        continue;
      }
      const identity = await host.evaluate((node) => ({
        tagName: node.tagName.toLowerCase(),
        componentId: node.getAttribute('data-component-id'),
        figmaNodeId: node.getAttribute('data-figma-instance-id'),
      }));
      if (identity.tagName !== contract.litTagName || identity.componentId !== contract.componentId) {
        block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Page Instance 未使用声明的 Contract Lit Tag：' + instance.id, location);
      }
      if (instance.origin === 'figma') {
        expectedFigmaNodeIds.add(instance.figmaInstanceNodeId);
        if (identity.figmaNodeId !== instance.figmaInstanceNodeId) {
          block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Figma Page Instance 身份不匹配：' + instance.id, location);
        }
        const coverage = model.componentVariantCoverage.find((item) => (
          item.mappingId === contract.mappingId
          && item.usages.some((usage) => usage.instanceNodeId === instance.figmaInstanceNodeId && usage.screenId === screen.id)
        ));
        const definition = coverage && model.componentVariantDefinitions.find((item) => item.id === coverage.definitionId);
        if (!mapping || !coverage || !definition) {
          block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Figma Page Instance 无法解析 Definition 与 Usage Coverage：' + instance.id, location);
        } else {
          for (const [attribute, expected] of Object.entries(definition.litVariantAttributes)) {
            const observed = await host.getAttribute(attribute);
            if (observed !== expected) {
              componentContractBlock(
                'Lit Variant Attribute 不匹配：' + instance.figmaInstanceNodeId + ' / ' + attribute + '，期望 ' + expected + '。',
                location,
                contract,
                instance,
                { kind: 'variant-attribute', property: attribute, expected, actual: observed },
              );
            }
          }
          for (const slotName of coverage.litSlotNames) {
            const assigned = await host.evaluate((node, name) => (
              [...node.children].some((child) => child.getAttribute('slot') === name)
            ), slotName);
            if (!assigned) block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Lit Instance 缺少声明 Slot：' + instance.id + ' / ' + slotName, location);
          }
        }
      } else if (identity.figmaNodeId !== null) {
        block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Local Page Instance 不得伪造 Figma 身份：' + instance.id, location);
      }
    }

    const component = model.components.find((item) => item.id === contract.componentId);
    const semanticIds = [
      ...(component?.controlIds || []),
      ...(component?.stateIds || []),
    ];
    for (const semanticId of semanticIds) {
      const selector = component?.controlIds.includes(semanticId)
        ? '[data-control-id="' + semanticId + '"]'
        : '[data-component-state="' + semanticId + '"]';
      const globalCount = await page.locator(selector).count();
      let ownedCount = 0;
      for (let hostIndex = 0; hostIndex < await renderedHosts.count(); hostIndex += 1) {
        const renderedHost = renderedHosts.nth(hostIndex);
        ownedCount += await renderedHost.locator(selector).count();
        if (
          !component?.controlIds.includes(semanticId)
          && await renderedHost.getAttribute('data-component-state') === semanticId
        ) ownedCount += 1;
      }
      if (ownedCount !== globalCount) {
        block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Component Control/State 必须位于对应 Contract Host 内：' + semanticId, location);
      }
    }
  }

  if (shellInstances.length === 1) {
    const [{ contract: shellContract, instance: shellInstance }] = shellInstances;
    const renderedShellHosts = page.locator(
      shellContract.litTagName + '[data-component-id="' + shellContract.componentId + '"]',
    );
    if (await renderedShellHosts.count() !== 1) {
      block(
        'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
        '运行页面必须且只能挂载一个 app-shell Lit Host：' + screen.id,
        location,
      );
    }
    const shell = page.locator('[data-component-instance-id="' + shellInstance.id + '"]');
    if (await shell.count() === 1) {
      for (const contract of contracts.filter((item) => item.implementationRole !== 'app-shell')) {
        for (const instance of contract.pageInstances.filter((item) => item.screenId === screen.id)) {
          const host = page.locator('[data-component-instance-id="' + instance.id + '"]');
          if (await host.count() !== 1) continue;
          const nested = await host.evaluate((node, shellInstanceId) => {
            let current = node;
            while (current) {
              if (
                current instanceof Element
                && current.getAttribute('data-component-instance-id') === shellInstanceId
              ) return true;
              if (current.parentElement) {
                current = current.parentElement;
                continue;
              }
              const root = current.getRootNode();
              current = root instanceof ShadowRoot ? root.host : null;
            }
            return false;
          }, shellInstance.id);
          if (!nested) {
            block(
              'AIH_COMPONENT_IMPLEMENTATION_MISMATCH',
              '非 app-shell Component Instance 必须位于统一 Shell 内：' + instance.id,
              location,
            );
          }
        }
      }
    }
  }

  const instanceMarkers = await page.locator('[data-component-instance-id]').evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-component-instance-id'),
    tagName: node.tagName.toLowerCase(),
    componentId: node.getAttribute('data-component-id'),
  })));
  for (const marker of instanceMarkers) {
    const contract = contracts.find((item) => item.litTagName === marker.tagName && item.componentId === marker.componentId);
    if (!marker.id || !contract || !expectedInstanceIds.has(marker.id)) {
      block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', '页面存在孤立或未登记的 Component Instance Marker。', location);
    }
  }
  for (const expectedId of expectedInstanceIds) {
    if (!instanceMarkers.some((marker) => marker.id === expectedId)) {
      block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', '页面缺少登记的 Component Instance Marker：' + expectedId, location);
    }
  }

  const figmaMarkers = await page.locator('[data-figma-instance-id]').evaluateAll(
    (nodes) => nodes.map((node) => node.getAttribute('data-figma-instance-id')),
  );
  for (const nodeId of figmaMarkers) {
    if (!nodeId || !expectedFigmaNodeIds.has(nodeId)) {
      block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', '页面存在孤立或落错 Screen 的 Figma Instance Marker：' + (nodeId || 'empty'), location);
    }
  }
  for (const nodeId of expectedFigmaNodeIds) {
    if (figmaMarkers.filter((item) => item === nodeId).length !== 1) {
      block('AIH_COMPONENT_IMPLEMENTATION_MISMATCH', 'Figma Instance Marker 必须且只能出现一次：' + nodeId, location);
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

async function verifyBaseSemantics(page, model, route, viewport, scenarioId = null) {
  const screen = model.screens.find((item) => item.id === route.screenId);
  if (!screen) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '路由引用未知 Screen：' + route.screenId, route.path);
    return null;
  }
  const scope = { routeId: route.id, viewportId: viewport.id, ...(scenarioId ? { scenarioId } : {}) };
  const screenshot = routeScreenshotPath(route.id, viewport.id, scenarioId);
  if (await page.locator('[data-screen-id="' + screen.id + '"]').count() === 0) {
    repairBlock('AIH_CANONICAL_UI_RUNTIME_FAILED', '路由未渲染声明的 data-screen-id：' + screen.id, route.path, {
      defectClass: 'html-structure',
      scope: { ...scope, targetIds: [screen.id] },
      check: { kind: 'screen-mounted', expected: true, actual: false },
      evidence: [{ kind: 'actual-screenshot', path: screenshot }],
    });
  }
  for (const stateId of screen.stateIds) {
    if (await page.locator('[data-state-id="' + stateId + '"]').count() === 0) {
      block('AIH_CANONICAL_UI_RUNTIME_FAILED', '缺少正式 Interaction State data-state-id：' + stateId, route.path);
    }
  }
  for (const componentId of screen.componentIds) {
    if (await page.locator('[data-component-id="' + componentId + '"]').count() === 0) {
      repairBlock('AIH_CANONICAL_UI_RUNTIME_FAILED', '缺少 data-component-id：' + componentId, route.path, {
        defectClass: 'html-structure',
        scope: { ...scope, componentId, targetIds: [componentId] },
        check: { kind: 'component-mounted', expected: true, actual: false },
        evidence: [{ kind: 'actual-screenshot', path: screenshot }],
      });
    }
  }
  for (const control of controlsForScreen(model, screen)) {
    const locator = page.locator('[data-control-id="' + control.id + '"]');
    if (await locator.count() === 0) {
      repairBlock('AIH_CANONICAL_UI_RUNTIME_FAILED', '缺少 data-control-id：' + control.id, route.path, {
        defectClass: 'html-structure',
        scope: { ...scope, targetIds: [control.id] },
        check: { kind: 'control-mounted', expected: true, actual: false },
        evidence: [{ kind: 'actual-screenshot', path: screenshot }],
      });
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

async function verifyTarget(page, id, assertion, scope, screenshot) {
  const locator = locatorForId(page, id);
  if (await locator.count() === 0) {
    repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标不存在：' + id, assertion.id, {
      defectClass: 'html-structure',
      scope: { ...scope, assertionId: assertion.id, targetIds: [id] },
      check: { kind: 'target-exists', expected: true, actual: false },
      evidence: [{ kind: 'actual-screenshot', path: screenshot }],
    });
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
    const scope = {
      routeId,
      viewportId: viewport.id,
      ...(scenarioId ? { scenarioId } : {}),
    };
    const screenshot = routeScreenshotPath(routeId, viewport.id, scenarioId);
    for (const check of assertion.checks) {
      if (check.kind === 'document-no-horizontal-overflow') {
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        if (overflow) repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '视口产生水平溢出：' + viewport.id, assertion.id, {
          defectClass: 'css-rendering',
          scope: { ...scope, assertionId: assertion.id },
          check: { kind: check.kind, expected: false, actual: true },
          evidence: [{ kind: 'actual-screenshot', path: screenshot }],
        });
        continue;
      }
      if (check.kind === 'elements-no-overlap') {
        const boxes = [];
        for (const id of check.targetIds) {
          const target = await verifyTarget(page, id, assertion, scope, screenshot);
          if (target) boxes.push({ id, box: await target.boundingBox() });
        }
        for (let left = 0; left < boxes.length; left += 1) {
          for (let right = left + 1; right < boxes.length; right += 1) {
            const a = boxes[left];
            const b = boxes[right];
            if (!a.box || !b.box) continue;
            const width = Math.min(a.box.x + a.box.width, b.box.x + b.box.width) - Math.max(a.box.x, b.box.x);
            const height = Math.min(a.box.y + a.box.height, b.box.y + b.box.height) - Math.max(a.box.y, b.box.y);
            if (width > 0.5 && height > 0.5) repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标发生重叠：' + a.id + ' / ' + b.id, assertion.id, {
              defectClass: 'css-rendering',
              scope: { ...scope, assertionId: assertion.id, targetIds: [a.id, b.id] },
              check: { kind: check.kind, expected: false, actual: true },
              evidence: [{ kind: 'actual-screenshot', path: screenshot }],
            });
          }
        }
        continue;
      }
      if (check.kind === 'computed-style') {
        const target = await verifyTarget(page, check.targetId, assertion, scope, screenshot);
        if (!target) continue;
        const actual = await target.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), check.property);
        if (actual !== check.expected) repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '计算样式不匹配：' + check.targetId + ' / ' + check.property + '，实际为 ' + actual, assertion.id, {
          defectClass: 'css-rendering',
          scope: { ...scope, assertionId: assertion.id, targetIds: [check.targetId] },
          check: { kind: check.kind, property: check.property, expected: check.expected, actual },
          evidence: [{ kind: 'actual-screenshot', path: screenshot }],
        });
        continue;
      }
      for (const id of check.targetIds) {
        const target = await verifyTarget(page, id, assertion, scope, screenshot);
        if (!target) continue;
        if (check.kind === 'element-visible' && !await target.isVisible()) {
          repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标不可见：' + id, assertion.id, {
            defectClass: 'css-rendering',
            scope: { ...scope, assertionId: assertion.id, targetIds: [id] },
            check: { kind: check.kind, expected: true, actual: false },
            evidence: [{ kind: 'actual-screenshot', path: screenshot }],
          });
        } else if (check.kind === 'element-in-viewport') {
          const box = await target.boundingBox();
          if (!box || box.x < -0.5 || box.y < -0.5 || box.x + box.width > viewport.width + 0.5 || box.y + box.height > viewport.height + 0.5) {
            repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '视觉断言目标超出视口：' + id, assertion.id, {
              defectClass: 'css-rendering',
              scope: { ...scope, assertionId: assertion.id, targetIds: [id] },
              check: { kind: check.kind, expected: true, actual: false },
              evidence: [{ kind: 'actual-screenshot', path: screenshot }],
            });
          }
        } else if (check.kind === 'text-no-clipping') {
          const clipped = await target.evaluate((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1);
          if (clipped) repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '文本发生裁切：' + id, assertion.id, {
            defectClass: 'css-rendering',
            scope: { ...scope, assertionId: assertion.id, targetIds: [id] },
            check: { kind: check.kind, expected: false, actual: true },
            evidence: [{ kind: 'actual-screenshot', path: screenshot }],
          });
        } else if (check.kind === 'text-max-lines') {
          const lines = await target.evaluate((element) => {
            const style = getComputedStyle(element);
            const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.2;
            return element.getBoundingClientRect().height / lineHeight;
          });
          if (lines > check.maxLines + 0.15) repairBlock('AIH_CANONICAL_UI_VISUAL_FAILED', '文本行数超过声明上限：' + id, assertion.id, {
            defectClass: 'css-rendering',
            scope: { ...scope, assertionId: assertion.id, targetIds: [id] },
            check: { kind: check.kind, expected: check.maxLines, actual: Number(lines.toFixed(3)) },
            evidence: [{ kind: 'actual-screenshot', path: screenshot }],
          });
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
          const prefix = safeEvidenceName('style-missing', viewport.id, routeId, scenarioId, assertion.id, checkIndex);
          const actualScreenshot = join(evidenceRoot, prefix + '-actual.png');
          const differenceScreenshot = join(evidenceRoot, prefix + '-difference.png');
          await page.screenshot({ path: actualScreenshot, fullPage: true, animations: 'disabled', style: PRODUCT_SCREENSHOT_STYLE });
          await page.screenshot({ path: differenceScreenshot, fullPage: true, animations: 'disabled', style: PRODUCT_SCREENSHOT_STYLE });
          repairBlock('AIH_VISUAL_STYLE_BINDING_FAILED', message, assertion.id, {
            defectClass: 'source-parity',
            scope: {
              routeId,
              viewportId: viewport.id,
              ...(scenarioId ? { scenarioId } : {}),
              assertionId: assertion.id,
              targetIds: [check.targetId],
            },
            check: { kind: check.kind, property: check.property, expected: check.expected, actual: '' },
            evidence: [
              { kind: 'actual-screenshot', path: actualScreenshot },
              { kind: 'difference-screenshot', path: differenceScreenshot },
              ...(sourceScreenshot ? [{ kind: 'source-baseline', path: sourceScreenshot.path }] : []),
              ...(source.designContext ? [{ kind: 'design-context', ...(source.designContextEvidenceItemId ? { id: source.designContextEvidenceItemId } : {}), path: source.designContext }] : []),
            ],
            source: {
              sourceId: assertion.sourceId,
              sourceKind: source.kind,
              evidenceItemIds: sourceEvidenceItemIds,
            },
          });
          continue;
        }
        const actual = await target.first().evaluate((element, property) => getComputedStyle(element).getPropertyValue(property).trim(), check.property);
        if (actual !== check.expected) {
          const message = '来源样式不匹配：' + check.targetId + ' / ' + check.property + '，实际为 ' + actual;
          const prefix = safeEvidenceName('style', viewport.id, routeId, scenarioId, assertion.id, checkIndex);
          const actualScreenshot = join(evidenceRoot, prefix + '-actual.png');
          const differenceScreenshot = join(evidenceRoot, prefix + '-difference.png');
          await page.screenshot({ path: actualScreenshot, fullPage: true, animations: 'disabled', style: PRODUCT_SCREENSHOT_STYLE });
          await captureStyleDifference(page, target.first(), differenceScreenshot);
          repairBlock('AIH_VISUAL_STYLE_BINDING_FAILED', message, assertion.id, {
            defectClass: 'source-parity',
            scope: {
              routeId,
              viewportId: viewport.id,
              ...(scenarioId ? { scenarioId } : {}),
              assertionId: assertion.id,
              targetIds: [check.targetId],
            },
            check: { kind: check.kind, property: check.property, expected: check.expected, actual },
            evidence: [
              { kind: 'actual-screenshot', path: actualScreenshot },
              { kind: 'difference-screenshot', path: differenceScreenshot },
              ...(sourceScreenshot ? [{ kind: 'source-baseline', path: sourceScreenshot.path }] : []),
              ...(source.designContext ? [{ kind: 'design-context', ...(source.designContextEvidenceItemId ? { id: source.designContextEvidenceItemId } : {}), path: source.designContext }] : []),
            ],
            source: {
              sourceId: assertion.sourceId,
              sourceKind: source.kind,
              evidenceItemIds: sourceEvidenceItemIds,
            },
          });
        }
      } else if (check.kind === 'screenshot-match') {
        if (skipVisualDiagnostics) continue;
        const baseline = parityEvidence.baselines.get(assertion.id);
        if (!baseline) {
          block('AIH_VISUAL_SOURCE_INCOMPLETE', '无法读取截图一致性基线。', assertion.id);
          continue;
        }
        const diagnosticStartedAt = performance.now();
        const difference = await imageDifference(page, baseline.dataUrl, thresholds.channelTolerance);
        visualDiagnosticDurationMs += performance.now() - diagnosticStartedAt;
        if (difference.ratio > thresholds.maxDifferentPixelRatio) {
          const prefix = safeEvidenceName('parity', viewport.id, routeId, scenarioId, assertion.id, checkIndex);
          const actualScreenshot = join(evidenceRoot, prefix + '-actual.png');
          const differenceScreenshot = join(evidenceRoot, prefix + '-difference.png');
          await writeFile(actualScreenshot, difference.actualScreenshot);
          await writeDataUrl(differenceScreenshot, difference.differenceDataUrl);
          const message = '实现与视觉来源截图差异超限：' + (difference.ratio * 100).toFixed(3) + '%，允许 ' + (thresholds.maxDifferentPixelRatio * 100).toFixed(3) + '%；实际 ' + difference.actual.join('×') + '，基线 ' + difference.expected.join('×');
          const diagnostic = {
            defectClass: 'source-parity',
            scope: {
              routeId,
              viewportId: viewport.id,
              ...(scenarioId ? { scenarioId } : {}),
              assertionId: assertion.id,
            },
            check: { kind: check.kind, expected: thresholds.maxDifferentPixelRatio, actual: difference.ratio },
            evidence: [
              { kind: 'source-baseline', ...(assertion.baselineEvidenceItemId ? { id: assertion.baselineEvidenceItemId } : {}), path: baseline.path },
              { kind: 'actual-screenshot', path: actualScreenshot },
              { kind: 'difference-screenshot', path: differenceScreenshot },
              ...(source.designContext ? [{ kind: 'design-context', ...(source.designContextEvidenceItemId ? { id: source.designContextEvidenceItemId } : {}), path: source.designContext }] : []),
            ],
            source: {
              sourceId: assertion.sourceId,
              sourceKind: source.kind,
              evidenceItemIds: sourceEvidenceItemIds,
            },
            difference: { ratio: difference.ratio, regions: difference.differenceRegions },
          };
          if (model.visualPolicy.mode === 'exact') {
            repairBlock('AIH_VISUAL_SOURCE_PARITY_FAILED', message, assertion.id, diagnostic);
          } else {
            evidence.push(createRepairDiagnostic('canonical-ui-runtime', {
              blockerCode: 'AIH_VISUAL_PIXEL_DIAGNOSTIC',
              message,
              location: assertion.id,
              ...diagnostic,
            }));
          }
        }
      }
    }
  }
}

async function runComponentSourceParityAssertions(base, model, parityEvidence, thresholds) {
  if (model.visualPolicy.mode === 'autonomous' || model.visualPolicy.mode === 'unresolved') return;
  const assertions = (model.componentSourceParityAssertions || []).filter((assertion) => (
    (componentFilter.size === 0
      || componentFilter.has(model.componentContracts.find((item) => item.id === assertion.componentContractId)?.componentId))
    && (viewportFilter.size === 0 || viewportFilter.has(assertion.viewportId))
  ));
  for (const assertion of assertions) {
    const contract = model.componentContracts.find((item) => item.id === assertion.componentContractId);
    const entry = model.stateMatrix.find((item) => item.id === assertion.stateMatrixEntryId);
    const viewport = model.viewports.find((item) => item.id === assertion.viewportId);
    const mapping = contract?.mappingId
      ? model.componentMappings.find((item) => item.id === contract.mappingId)
      : null;
    const baseline = parityEvidence.baselines.get(assertion.id);
    if (!contract || !entry || !viewport || !baseline) {
      block('AIH_VISUAL_SOURCE_INCOMPLETE', '组件来源一致性断言无法解析 Contract、Matrix、Viewport 或基线：' + assertion.id, assertion.id);
      continue;
    }
    const { context, page } = await guardedPage(viewport, base);
    try {
      const url = new URL('/', base);
      url.searchParams.set('__pspComponentContract', contract.id);
      url.searchParams.set('__pspStateMatrix', entry.id);
      url.searchParams.set('review', '0');
      await page.goto(url.href, { waitUntil: 'networkidle' });
      const host = await verifyMatrixMount({
        surface: page,
        model,
        contract,
        entry,
        mapping,
        block,
        code: 'AIH_COMPONENT_CONTRACT_TEST_FAILED',
        location: assertion.id,
      });
      if (!host) continue;
      for (let checkIndex = 0; checkIndex < assertion.checks.length; checkIndex += 1) {
        const check = assertion.checks[checkIndex];
        if (check.kind === 'computed-style') {
          const target = componentParityTarget(host, contract, assertion, check.targetId);
          if (await target.count() === 0) {
            block('AIH_VISUAL_STYLE_BINDING_FAILED', '组件来源样式断言目标不存在：' + check.targetId, assertion.id);
            continue;
          }
          const actual = await target.first().evaluate(
            (element, property) => getComputedStyle(element).getPropertyValue(property).trim(),
            check.property,
          );
          if (actual !== check.expected) {
            repairBlock('AIH_VISUAL_STYLE_BINDING_FAILED', '组件来源样式不匹配：' + check.targetId + ' / ' + check.property, assertion.id, {
              defectClass: 'source-parity',
              scope: {
                componentContractId: contract.id,
                pageInstanceId: assertion.pageInstanceId,
                stateMatrixEntryId: entry.id,
                viewportId: viewport.id,
                assertionId: assertion.id,
                targetIds: [check.targetId],
              },
              check: { kind: check.kind, property: check.property, expected: check.expected, actual },
              evidence: [{ kind: 'source-baseline', id: assertion.baselineEvidenceItemId, path: baseline.path }],
              source: { sourceId: assertion.sourceId, sourceKind: 'figma', evidenceItemIds: [assertion.baselineEvidenceItemId] },
            });
          }
          continue;
        }
        if (skipVisualDiagnostics) continue;
        const diagnosticStartedAt = performance.now();
        const difference = await imageDifference(page, baseline.dataUrl, thresholds.channelTolerance, host);
        visualDiagnosticDurationMs += performance.now() - diagnosticStartedAt;
        if (difference.ratio <= thresholds.maxDifferentPixelRatio) continue;
        const prefix = safeEvidenceName('component-parity', contract.id, entry.id, viewport.id, assertion.id, checkIndex);
        const actualScreenshot = join(evidenceRoot, prefix + '-actual.png');
        const differenceScreenshot = join(evidenceRoot, prefix + '-difference.png');
        await writeFile(actualScreenshot, difference.actualScreenshot);
        await writeDataUrl(differenceScreenshot, difference.differenceDataUrl);
        const message = '隔离 Lit Host 与组件来源截图差异超限：' + (difference.ratio * 100).toFixed(3) + '%。';
        const diagnostic = {
          defectClass: 'source-parity',
          scope: {
            componentContractId: contract.id,
            pageInstanceId: assertion.pageInstanceId,
            stateMatrixEntryId: entry.id,
            viewportId: viewport.id,
            assertionId: assertion.id,
          },
          check: { kind: check.kind, expected: thresholds.maxDifferentPixelRatio, actual: difference.ratio },
          evidence: [
            { kind: 'source-baseline', id: assertion.baselineEvidenceItemId, path: baseline.path },
            { kind: 'actual-screenshot', path: actualScreenshot },
            { kind: 'difference-screenshot', path: differenceScreenshot },
          ],
          source: {
            sourceId: assertion.sourceId,
            sourceKind: 'figma',
            evidenceItemIds: [assertion.baselineEvidenceItemId],
          },
          difference: { ratio: difference.ratio, regions: difference.differenceRegions },
        };
        if (model.visualPolicy.mode === 'exact') {
          repairBlock('AIH_VISUAL_SOURCE_PARITY_FAILED', message, assertion.id, diagnostic);
        } else {
          evidence.push(createRepairDiagnostic('canonical-ui-runtime', {
            blockerCode: 'AIH_VISUAL_PIXEL_DIAGNOSTIC',
            message,
            location: assertion.id,
            ...diagnostic,
          }));
        }
      }
    } finally {
      await context.close();
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
    for (const targetId of asset.consumerTargets) {
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

function productUrl(base, routePath) {
  const url = new URL(routePath, base);
  url.searchParams.set('review', '0');
  return url.href;
}

function reviewUrl(base, routePath) {
  const url = new URL(routePath, base);
  url.searchParams.set('review', '1');
  return url.href;
}

async function verifyNoReviewTools(page, routePath) {
  if (await page.locator('[data-review-tool]').count() !== 0) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', 'review=0 仍加载了 Review Tool。', routePath);
  }
  const loadedBuiltIns = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('inconsistency-annotator') || name.includes('interaction-branch-driver')));
  if (loadedBuiltIns.length > 0) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', 'review=0 仍请求了内置 Review Tool 模块。', routePath);
  }
}

async function verifyBuiltInReviewTools(page, model, route) {
  const routePath = route.path;
  const tool = page.locator('inconsistency-annotator[data-review-tool="inconsistency-annotator"]');
  if (await tool.count() !== 1) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', 'review=1 未显示唯一的不一致标记工具。', routePath);
    return;
  }
  const toolbar = tool.locator('.ia-toolbar');
  if (await toolbar.count() !== 1 || !await toolbar.isVisible()) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', 'review=1 未显示不一致标记工具栏。', routePath);
    return;
  }
  const placement = await toolbar.evaluate((element) => {
    const style = getComputedStyle(element);
    return { position: style.position, right: style.right, top: style.top };
  });
  if (placement.position !== 'fixed' || placement.right === 'auto' || placement.top === 'auto') {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具未固定在页面右上方。', routePath);
  }
  const driver = page.locator('psp-interaction-branch-driver[data-review-tool="interaction-branch-driver"]');
  if (await driver.count() !== 1) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', 'review=1 未显示唯一的交互分支驱动器。', routePath);
    return;
  }
  const scenario = model.scenarios.find((item) => item.routeId === route.id);
  if (!scenario) return;
  const action = driver.locator('[data-scenario-id="' + scenario.id + '"]');
  if (await action.count() !== 1) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '交互分支驱动器缺少当前 Route 的 Scenario：' + scenario.id, routePath);
    return;
  }
  await action.click();
  try {
    await driver.locator('[role="status"]').filter({ hasText: '已达到声明的最终状态' }).waitFor({ timeout: 6000 });
  } catch {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '交互分支驱动器未完成 Scenario：' + scenario.id, routePath);
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
              const entry = { type, size: value.size };
              if (type === 'image/png') {
                const bitmap = await createImageBitmap(value);
                const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                const context = canvas.getContext('2d', { willReadFrequently: true });
                context.drawImage(bitmap, 0, 0);
                const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
                let redPixels = 0;
                for (let index = 0; index < pixels.length; index += 4) {
                  if (pixels[index] > 190 && pixels[index + 1] < 120 && pixels[index + 2] < 130 && pixels[index + 3] > 200) {
                    redPixels += 1;
                  }
                }
                entry.image = { width: bitmap.width, height: bitmap.height, redPixels };
                bitmap.close();
              }
              write.types.push(entry);
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
  const copiedImage = writes[0]?.types?.find((item) => item.type === 'image/png')?.image;
  if (
    !copiedImage
    || copiedImage.width < viewport.width
    || copiedImage.height <= viewport.height
    || copiedImage.redPixels < 100
  ) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具复制的 PNG 缺少有效视口、图例或红色标记绘制。', routePath);
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

  const [feedbackDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('[data-action="feedback"]').click(),
  ]);
  if (!feedbackDownload.suggestedFilename().endsWith('.json')) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具导出的 Feedback Packet 不是 JSON。', routePath);
    return;
  }
  const feedbackPath = await feedbackDownload.path();
  if (!feedbackPath) {
    block('AIH_CANONICAL_UI_RUNTIME_FAILED', '无法读取不一致标记工具导出的 Feedback Packet。', routePath);
    return;
  }
  const packet = JSON.parse(await readFile(feedbackPath, 'utf8'));
  const packetSchema = JSON.parse(await readFile(
    repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/review-feedback-packet.schema.json'),
    'utf8',
  ));
  const validatePacket = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(packetSchema);
  if (!validatePacket(packet)) {
    block(
      'AIH_CANONICAL_UI_RUNTIME_FAILED',
      '不一致标记工具导出的 Feedback Packet 不符合 Schema：' + JSON.stringify(validatePacket.errors),
      routePath,
    );
  }
}

async function verifyReviewToolWorkflow(viewport, base, model, route) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: viewport.width, height: viewport.height },
  });
  const page = await context.newPage();
  try {
    await installClipboardProbe(page);
    await page.goto(new URL(route.path, base).href, { waitUntil: 'networkidle' });
    await verifyNoReviewTools(page, route.path);
    await page.goto(reviewUrl(base, route.path), { waitUntil: 'networkidle' });
    await verifyBuiltInReviewTools(page, model, route);
    await verifyReviewToolCopy(page, route.path);
  } finally {
    await context.close();
  }
}

async function hideReviewToolsForProductEvidence(page) {
  await page.locator('[data-review-tool]').evaluateAll((elements) => {
    for (const element of elements) element.setAttribute('hidden', '');
  });
}

async function verifyStateGallery(viewport, base, model) {
  const { context, page } = await guardedPage(viewport, base);
  const location = '/__review/components';
  try {
    const selectedContractIds = new Set(model.componentContracts.filter((item) => componentFilter.size === 0 || componentFilter.has(item.componentId)).map((item) => item.id));
    const legalEntries = model.stateMatrix.filter((entry) => entry.classification === 'legal' && entry.renderInGallery && selectedContractIds.has(entry.componentContractId));
    const galleryUrl = new URL(location, base);
    galleryUrl.searchParams.set('review', '1');
    for (const componentId of componentFilter) galleryUrl.searchParams.append('__pspComponentFilter', componentId);
    await page.goto(galleryUrl.href, { waitUntil: 'domcontentloaded' });
    await page.locator('psp-state-gallery').waitFor({ state: 'attached', timeout: 60000 });
    if (await page.locator('psp-state-gallery').count() !== 1) {
      block('AIH_STATE_GALLERY_FAILED', '缺少唯一的 /__review/components State Gallery。', location);
      return;
    }
    await page.waitForFunction(
      (expected) => (
        document.querySelector('psp-state-gallery')
          ?.shadowRoot
          ?.querySelectorAll('[data-state-gallery] iframe')
          .length === expected
      ),
      legalEntries.length,
      { timeout: 60000 },
    );
    const renderedIds = await page.locator('[data-state-gallery] [data-state-matrix-id]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-state-matrix-id')));
    if (JSON.stringify([...renderedIds].sort()) !== JSON.stringify(legalEntries.map((entry) => entry.id).sort())) {
      block('AIH_STATE_GALLERY_FAILED', 'State Gallery 必须精确渲染全部合法 Matrix Entry，且不得渲染互斥或不可达组合。', location);
    }
    for (const entry of legalEntries) {
      const card = page.locator('[data-state-matrix-id="' + entry.id + '"]');
      const axes = model.stateAxes.filter((axis) => axis.componentContractId === entry.componentContractId);
      const renderedAxisIds = await card.locator('[data-state-axis-id]').evaluateAll(
        (nodes) => nodes.map((node) => node.getAttribute('data-state-axis-id')),
      );
      if (
        await card.count() !== 1
        || JSON.stringify([...renderedAxisIds].sort()) !== JSON.stringify(axes.map((axis) => axis.id).sort())
      ) {
        block('AIH_STATE_GALLERY_FAILED', 'State Gallery 条目未展示完整且唯一的状态轴元数据：' + entry.id, location);
      }
      const frame = page.frames().find((item) => {
        try { return new URL(item.url()).searchParams.get('__pspStateMatrix') === entry.id; }
        catch { return false; }
      });
      if (!frame) {
        block('AIH_STATE_GALLERY_FAILED', 'State Gallery 条目缺少可运行预览：' + entry.id, location);
        continue;
      }
      const contract = model.componentContracts.find((item) => item.id === entry.componentContractId);
      const mapping = contract?.mappingId
        ? model.componentMappings.find((item) => item.id === contract.mappingId)
        : null;
      const host = contract ? await verifyMatrixMount({
        surface: frame,
        model,
        contract,
        entry,
        mapping,
        block,
        code: 'AIH_STATE_GALLERY_FAILED',
        location,
      }) : null;
      if (host && evidenceRoot) {
        const screenshot = join(evidenceRoot, safeEvidenceName('component', contract.id, entry.id) + '.png');
        await host.screenshot({ path: screenshot, animations: 'disabled' });
        evidence.push({
          kind: 'component',
          componentContractId: contract.id,
          stateMatrixEntryId: entry.id,
          screenshot,
        });
      }
    }
  } finally {
    await context.close();
  }
}

async function capture(page, evidenceRoot, item) {
  const parts = [item.kind, item.viewportId, item.routeId, item.scenarioId].filter(Boolean);
  const screenshot = join(evidenceRoot, parts.join('-') + '.png');
  await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled', style: PRODUCT_SCREENSHOT_STYLE });
  evidence.push({ ...item, screenshot });
}

try {
  const project = await loadProject(root);
  const stage = project.stages?.['product-design'];
  if (stage?.status !== 'active') throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const authorityPath = artifactMemberPath(paths, requestedActor);
  const model = await extractCanonicalUi(root, authorityPath);
  const selectedRoutes = model.routes.filter((item) => routeFilter.size === 0 || routeFilter.has(item.id));
  const selectedViewports = model.viewports.filter((item) => viewportFilter.size === 0 || viewportFilter.has(item.id));
  const selectedScenarios = model.scenarios.filter((item) => (
    (scenarioFilter.size === 0 || scenarioFilter.has(item.id))
    && (routeFilter.size === 0 || routeFilter.has(item.routeId))
  ));
  const selectedScreenIds = new Set(selectedRoutes.map((item) => item.screenId));
  const selectedComponentIds = new Set(model.screens.filter((item) => selectedScreenIds.has(item.id)).flatMap((item) => item.componentIds));
  const selectedTargetIds = new Set([
    ...selectedScreenIds,
    ...selectedComponentIds,
    ...model.controls.filter((item) => selectedComponentIds.has(item.componentId)).map((item) => item.id),
    ...model.states.filter((item) => selectedScreenIds.has(item.ownerId) || selectedComponentIds.has(item.ownerId)).map((item) => item.id),
  ]);
  const selectedAssets = model.assets.filter((item) => routeFilter.size === 0 || item.consumerTargets.some((targetId) => selectedTargetIds.has(targetId)));
  const selectedTokens = model.tokens.filter((item) => item.targetIds.some((targetId) => selectedTargetIds.has(targetId)));
  const selectedTokenTargets = new Map(selectedTokens.map((token) => [
    token.id,
    token.targetIds.filter((targetId) => selectedTargetIds.has(targetId)),
  ]));
  if (routeFilter.size > 0 && selectedRoutes.length !== routeFilter.size) block('AIH_INCREMENTAL_SCOPE_INVALID', '增量校验引用未知 Route。', [...routeFilter].join(', '));
  if (viewportFilter.size > 0 && selectedViewports.length !== viewportFilter.size) block('AIH_INCREMENTAL_SCOPE_INVALID', '增量校验引用未知 Viewport。', [...viewportFilter].join(', '));
  if (scenarioFilter.size > 0 && selectedScenarios.length !== scenarioFilter.size) block('AIH_INCREMENTAL_SCOPE_INVALID', '增量校验引用未知 Scenario 或跨 Route Scenario。', [...scenarioFilter].join(', '));
  if (componentFilter.size > 0 && model.components.filter((item) => componentFilter.has(item.id)).length !== componentFilter.size) block('AIH_INCREMENTAL_SCOPE_INVALID', '增量校验引用未知 Component。', [...componentFilter].join(', '));
  if (model.actor !== requestedActor) block('AIH_REFERENCE_UNRESOLVED', '应用 actor 与目录参与者不一致。', authorityPath);
  const areaPath = repositoryFile(root, paths.authorityRoot + '/' + requestedActor);
  await validateFigmaImplementationPolicy(model, areaPath);
  const registry = artifactDefinition(project, 'canonical-ui-prototype', 'product-design');
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
  reviewAddress = reviewUrl(base, '/');
  browser = await chromium.launch({ headless: true });

  if (selectedViewports[0]) {
    try {
      if (!skipStateGallery) await verifyStateGallery(selectedViewports[0], base, model);
    } catch (error) {
      block(error.code || 'AIH_STATE_GALLERY_FAILED', 'State Gallery 回归失败：' + error.message, '/__review/components');
    }
  }

  try {
    await runComponentSourceParityAssertions(base, model, parityEvidence, thresholds);
  } catch (error) {
    block(error.code || 'AIH_VISUAL_SOURCE_PARITY_FAILED', '组件来源一致性回归失败：' + error.message, 'componentSourceParityAssertions');
  }

  if (selectedViewports[0] && selectedRoutes[0]) {
    try {
      await verifyReviewToolWorkflow(selectedViewports[0], base, model, selectedRoutes[0]);
    } catch (error) {
      block(error.code || 'AIH_CANONICAL_UI_RUNTIME_FAILED', '不一致标记工具复制回归失败：' + error.message, model.routes[0].path);
    }
  }

  for (const viewport of selectedViewports) {
    for (const route of selectedRoutes) {
      const { context, page } = await guardedPage(viewport, base);
      let screen = null;
      try {
        await page.goto(productUrl(base, route.path), { waitUntil: 'networkidle' });
        await verifyNoReviewTools(page, route.path);
        currentRepairContext = {
          location: route.path,
          scope: { routeId: route.id, viewportId: viewport.id },
          screenshot: routeScreenshotPath(route.id, viewport.id),
        };
        screen = await verifyBaseSemantics(page, model, route, viewport);
        await observeTokens(
          page,
          model,
          selectedTokens,
          selectedTokenTargets,
          areaPath,
          route.path,
          { routeId: route.id, viewportId: viewport.id },
          currentRepairContext.screenshot,
        );
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

  for (const scenario of selectedScenarios) {
    const route = model.routes.find((item) => item.id === scenario.routeId);
    for (const viewportId of scenario.viewportIds.filter((item) => viewportFilter.size === 0 || viewportFilter.has(item))) {
      const viewport = model.viewports.find((item) => item.id === viewportId);
      if (!route || !viewport) continue;
      const { context, page } = await guardedPage(viewport, base);
      try {
        await page.goto(reviewUrl(base, route.path), { waitUntil: 'networkidle' });
        currentRepairContext = {
          location: scenario.id + ' / ' + viewport.id,
          scope: { routeId: route.id, viewportId: viewport.id, scenarioId: scenario.id },
          screenshot: routeScreenshotPath(route.id, viewport.id, scenario.id),
        };
        const screen = await verifyBaseSemantics(page, model, route, viewport, scenario.id);
        await observeTokens(
          page,
          model,
          selectedTokens,
          selectedTokenTargets,
          areaPath,
          scenario.id + ' / ' + viewport.id,
          { routeId: route.id, viewportId: viewport.id, scenarioId: scenario.id },
          currentRepairContext.screenshot,
        );
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
            }, action.resultingStateIds, { timeout: 5000 });
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
        await hideReviewToolsForProductEvidence(page);
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

  currentRepairContext = null;
  for (const asset of selectedAssets) {
    if (!loadedAssets.has(asset.id)) repairBlock('AIH_ASSET_MISSING', '资源未成功加载：' + asset.path, asset.id, {
      defectClass: 'asset-binding',
      scope: { assetId: asset.id },
      check: { kind: 'asset-loaded', expected: true, actual: false },
      evidence: [{ kind: 'asset', id: asset.id, path: asset.path }],
    });
    for (const targetId of asset.consumerTargets) {
      if (!usedAssetTargets.get(asset.id)?.has(targetId)) {
        repairBlock('AIH_ASSET_CSS_BYPASS', '已分类 asset 未在声明目标中实际使用：' + asset.id + ' / ' + targetId, asset.path, {
          defectClass: 'asset-binding',
          scope: { assetId: asset.id, targetIds: [targetId] },
          check: { kind: 'asset-consumed', expected: true, actual: false },
          evidence: [{ kind: 'asset', id: asset.id, path: asset.path }],
        });
      }
    }
  }
  for (const token of selectedTokens) {
    for (const targetId of selectedTokenTargets.get(token.id) || []) {
      if (!usedTokenTargets.get(token.id)?.has(targetId) && !tokenFailureKeys.has(token.id + '/' + targetId)) {
        block(
          'AIH_VISUAL_STYLE_BINDING_FAILED',
          'Token 声明目标未在已选 Route/Scenario 中观测到实际消费：' + token.id + ' / ' + targetId,
          token.id,
        );
      }
    }
  }
} catch (error) {
  block(error.code || (String(error.message).includes('Executable') ? 'AIH_BROWSER_UNAVAILABLE' : 'AIH_CANONICAL_UI_RUNTIME_FAILED'), error.message);
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
}

const totalDurationMs = performance.now() - startedAt;
const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  blockers,
  evidence,
  metrics: {
    totalDurationMs: Math.round(totalDurationMs),
    browserGateDurationMs: Math.round(Math.max(0, totalDurationMs - visualDiagnosticDurationMs)),
    visualDiagnosticDurationMs: Math.round(visualDiagnosticDurationMs),
    selected: {
      routes: [...routeFilter],
      viewports: [...viewportFilter],
      scenarios: [...scenarioFilter],
      components: [...componentFilter],
    },
  },
  ...(evidenceRoot ? { evidenceRoot } : {}),
  ...(reviewAddress ? { reviewAddress } : {}),
};
if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Canonical UI Prototype 浏览器验收通过；证据位于操作系统临时目录。');
else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
if (result.status !== 'PASS') process.exitCode = 1;
