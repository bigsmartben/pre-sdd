import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { artifactMemberPath, artifactPaths, loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const value = (name) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const values = (name) => process.argv.flatMap((item, index) => item === '--' + name && process.argv[index + 1] ? [process.argv[index + 1]] : []);
const actor = value('actor');
const changedPaths = values('changed-path').map((item) => item.replaceAll('\\', '/').replace(/^\.\//, ''));
const explicitViewports = new Set(values('viewport'));
const includeVisualDiagnostics = process.argv.includes('--include-visual-diagnostics');

function sha256(valueToHash) {
  return 'sha256:' + createHash('sha256').update(valueToHash).digest('hex');
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function fileHash(path) {
  try { return sha256(await readFile(path)); } catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
}

function run(script, args) {
  const startedAt = performance.now();
  const child = spawnSync(process.execPath, [script, ...args, '--json'], { cwd: root, encoding: 'utf8', env: process.env, windowsHide: true, timeout: 240_000 });
  let output;
  try { output = JSON.parse(child.stdout || '{}'); }
  catch { output = { status: 'BLOCKED', blockers: [{ code: 'AIH_INCREMENTAL_VALIDATION_FAILED', message: child.stderr || '增量层未返回 JSON。' }] }; }
  return { status: child.status === 0 && output.status === 'PASS' ? 'PASS' : 'BLOCKED', durationMs: Math.round(performance.now() - startedAt), output };
}

function percentile(samples, ratio) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function summary(samples) {
  return { samples: samples.length, p50Ms: percentile(samples, 0.5), p95Ms: percentile(samples, 0.95) };
}

function impacted(model, normalizedPaths) {
  const components = new Set();
  const routes = new Set();
  const reasons = new Set();
  const addComponent = (componentId, reason) => {
    components.add(componentId);
    reasons.add(reason);
    for (const screen of model.screens.filter((item) => item.componentIds.includes(componentId))) {
      for (const route of model.routes.filter((item) => item.screenId === screen.id)) routes.add(route.id);
    }
  };
  const all = (reason) => {
    model.components.forEach((item) => components.add(item.id));
    model.routes.forEach((item) => routes.add(item.id));
    reasons.add(reason);
  };
  for (const path of normalizedPaths) {
    if (path === 'src/spec/canonical-ui.ts') { all('canonical-model-changed'); continue; }
    const contract = model.componentContracts.find((item) => item.implementationPaths.includes(path));
    if (contract) { addComponent(contract.componentId, 'component-implementation-changed'); continue; }
    if (path.startsWith('public/')) {
      const asset = model.assets.find((item) => item.path === path);
      if (!asset) { all('unregistered-asset-fallback'); continue; }
      const targets = new Set(asset.consumerTargets);
      for (const component of model.components) {
        if (targets.has(component.id) || component.controlIds.some((id) => targets.has(id)) || component.stateIds.some((id) => targets.has(id))) addComponent(component.id, 'asset-consumer-changed');
      }
      for (const screen of model.screens.filter((item) => targets.has(item.id))) for (const route of model.routes.filter((item) => item.screenId === screen.id)) routes.add(route.id);
      continue;
    }
    if (path.startsWith('src/mocks/')) { all('mock-behavior-changed'); continue; }
    if (/^(?:index\.html|package\.json|tsconfig\.json|vite\.config\.ts|src\/(?:main|state-gallery|mockcase-switcher|inconsistency-annotator)\.ts|src\/.*\.css)$/.test(path)) { all('shared-runtime-changed'); continue; }
    all('unknown-path-conservative-fallback');
  }
  return { components: [...components], routes: [...routes], reasons: [...reasons] };
}

if (!actor || changedPaths.length === 0) {
  const result = { status: 'BLOCKED', blockers: [{ code: 'AIH_INCREMENTAL_SCOPE_REQUIRED', message: '必须提供 --actor 与至少一个 --changed-path；正式 readiness 不使用此增量入口。' }] };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

const { project } = await loadProjectAndManifest(root);
const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
const authorityPath = artifactMemberPath(paths, actor);
const model = await extractCanonicalUi(root, authorityPath);
const areaRoot = repositoryFile(root, paths.authorityRoot + '/' + actor);
const normalizedPaths = changedPaths.map((path) => {
  const prefix = paths.authorityRoot + '/' + actor + '/';
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
});
const impact = impacted(model, normalizedPaths);
if (impact.routes.length === 0) model.routes.forEach((item) => impact.routes.push(item.id));
if (impact.components.length === 0) model.components.forEach((item) => impact.components.push(item.id));
const viewports = explicitViewports.size > 0 ? [...explicitViewports] : model.viewports.map((item) => item.id);
const scenarios = model.scenarios.filter((item) => impact.routes.includes(item.routeId)).map((item) => item.id);

for (const contract of model.componentContracts) if (!Array.isArray(contract.implementationPaths) || contract.implementationPaths.length === 0) {
  const result = { status: 'BLOCKED', blockers: [{ code: 'AIH_INCREMENTAL_SCOPE_INVALID', message: 'Component Contract 缺少 implementationPaths：' + contract.id }] };
  console.log(JSON.stringify(result, null, 2));
  process.exit(1);
}

const workspaceKey = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24);
const cachePath = resolve(tmpdir(), 'psp-incremental-validation-' + workspaceKey, actor + '.json');
let cache = { version: '1.0.0', layers: {}, history: [] };
if (await exists(cachePath)) {
  try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { /* Invalid cache is a deterministic miss. */ }
}
const implementationFiles = [...new Set(model.componentContracts.filter((item) => impact.components.includes(item.componentId)).flatMap((item) => item.implementationPaths))];
const globalFiles = ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts', 'src/main.ts', 'src/state-gallery.ts', 'src/mockcase-switcher.ts', 'src/inconsistency-annotator.ts'];
const hashes = {};
for (const path of [...new Set([authorityPath, ...implementationFiles.map((item) => paths.authorityRoot + '/' + actor + '/' + item), ...globalFiles.map((item) => paths.authorityRoot + '/' + actor + '/' + item)])]) {
  hashes[path] = await fileHash(repositoryFile(root, path));
}
const assetHashes = {};
for (const asset of model.assets) {
  assetHashes[asset.path] = await fileHash(resolve(areaRoot, asset.path));
}
const fingerprints = {
  staticInput: sha256(JSON.stringify({ authority: hashes[authorityPath], version: model.version })),
  assets: sha256(JSON.stringify({ assets: model.assets, designSources: model.designSources, assetHashes })),
  components: sha256(JSON.stringify({ components: impact.components, contracts: model.componentContracts.filter((item) => impact.components.includes(item.componentId)), matrix: model.stateMatrix, hashes })),
  routes: sha256(JSON.stringify({ routes: impact.routes, viewports, scenarios, mockCases: model.mockCases.filter((item) => impact.routes.includes(item.routeId)), hashes, assetHashes, includeVisualDiagnostics })),
};

const layers = [];
const blockers = [];
const executeLayer = (id, fingerprint, invalidationReason, execute) => {
  const previous = cache.layers[id];
  if (previous?.fingerprint === fingerprint && previous.status === 'PASS') {
    layers.push({ id, status: 'PASS', durationMs: 0, cacheHit: true, invalidationReason: null });
    return null;
  }
  const result = execute();
  layers.push({ id, status: result.status, durationMs: result.durationMs, cacheHit: false, invalidationReason: previous ? invalidationReason : 'cache-empty' });
  blockers.push(...(result.output.blockers || []));
  cache.layers[id] = { fingerprint, status: result.status, updatedAt: new Date().toISOString() };
  return result;
};

let inputResult = null;
const staticMiss = cache.layers['static-input']?.fingerprint !== fingerprints.staticInput || cache.layers['static-input']?.status !== 'PASS';
const assetMiss = cache.layers.assets?.fingerprint !== fingerprints.assets || cache.layers.assets?.status !== 'PASS';
if (staticMiss || assetMiss) inputResult = run(repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs'), ['--actor', actor]);
executeLayer('static-input', fingerprints.staticInput, 'canonical-input-changed', () => inputResult || { status: 'PASS', durationMs: 0, output: { blockers: [] } });
executeLayer('assets', fingerprints.assets, 'asset-or-source-evidence-changed', () => inputResult || { status: 'PASS', durationMs: 0, output: { blockers: [] } });

let componentResult = null;
if (blockers.length === 0) componentResult = executeLayer('components', fingerprints.components, 'component-contract-or-implementation-changed', () => run(
  repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs'),
  ['--actor', actor, ...impact.components.flatMap((item) => ['--component', item])],
));
else layers.push({ id: 'components', status: 'NOT_RUN', durationMs: 0, cacheHit: false, invalidationReason: 'upstream-blocked' });

let routeResult = null;
if (blockers.length === 0) routeResult = executeLayer('routes', fingerprints.routes, 'route-state-viewport-or-implementation-changed', () => run(
  repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs'),
  [
    '--actor', actor,
    ...impact.routes.flatMap((item) => ['--route', item]),
    ...viewports.flatMap((item) => ['--viewport', item]),
    ...scenarios.flatMap((item) => ['--scenario', item]),
    ...impact.components.flatMap((item) => ['--component', item]),
    '--skip-state-gallery',
    ...(includeVisualDiagnostics ? [] : ['--skip-visual-diagnostics']),
  ],
));
else layers.push({ id: 'routes', status: 'NOT_RUN', durationMs: 0, cacheHit: false, invalidationReason: 'upstream-blocked' });

const machineGateMs = layers.filter((item) => ['static-input', 'assets', 'components'].includes(item.id)).reduce((sum, item) => sum + item.durationMs, 0);
const browserRuntimeMs = routeResult?.output.metrics?.browserGateDurationMs ?? routeResult?.durationMs ?? 0;
const visualDiagnosticsMs = routeResult?.output.metrics?.visualDiagnosticDurationMs ?? 0;
cache.history.push({ at: new Date().toISOString(), machineGateMs, browserRuntimeMs, visualDiagnosticsMs, cacheHits: layers.filter((item) => item.cacheHit).length, layers: layers.length });
cache.history = cache.history.slice(-50);
await mkdir(dirname(cachePath), { recursive: true });
await writeFile(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');

const baseline = JSON.parse(await readFile(repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/performance-baseline.json'), 'utf8'));
const afterSamples = {
  machineGatesMs: cache.history.map((item) => item.machineGateMs),
  browserRuntimeMs: cache.history.map((item) => item.browserRuntimeMs),
  visualDiagnosticsMs: cache.history.map((item) => item.visualDiagnosticsMs),
};
const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  mode: 'incremental',
  formalReadiness: 'NOT_RUN',
  impact: { actor, changedPaths: normalizedPaths, ...impact, viewports, scenarios },
  layers,
  cache: { path: cachePath, hits: layers.filter((item) => item.cacheHit).length, misses: layers.filter((item) => !item.cacheHit && item.status !== 'NOT_RUN').length },
  performance: {
    before: Object.fromEntries(Object.entries(baseline.samples).map(([key, samples]) => [key, summary(samples)])),
    after: Object.fromEntries(Object.entries(afterSamples).map(([key, samples]) => [key, summary(samples)])),
    current: { machineGateMs, browserRuntimeMs, visualDiagnosticsMs },
  },
  blockers,
};
if (json || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
else console.log('[PASS] 受影响 Component/Route/Viewport 增量校验通过；正式 readiness 未运行。');
if (result.status !== 'PASS') process.exitCode = 1;
