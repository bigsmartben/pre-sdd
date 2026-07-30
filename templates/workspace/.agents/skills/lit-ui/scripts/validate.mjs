import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readMapping, validateMapping } from './lib/mapping.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function regularFiles(root) {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) output.push(...await regularFiles(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function add(blockers, code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

const root = resolve(argument('root', process.cwd()));
const scaffoldMode = process.argv.includes('--scaffold');
const capabilityRoot = resolve(root, '.agents/skills/lit-ui');
const templateRoot = resolve(capabilityRoot, 'template');
const implementationRoot = resolve(root, argument('implementation', 'src/ui'));
const implementation = scaffoldMode && !(await exists(implementationRoot))
  ? resolve(templateRoot, 'src/ui')
  : implementationRoot;
const reviewRoot = resolve(root, argument('review', await exists(resolve(root, 'src/review')) ? 'src/review' : '.agents/skills/lit-ui/template/src/review'));
const mappingArgument = argument('mapping', '');
const uihtmlArgument = argument('uihtml', '');
const blockers = [];

const requiredCapabilityFiles = [
  'contracts/framework.yaml',
  'contracts/mapping.yaml',
  'contracts/blocker-codes.yaml',
  'templates/Mapping.html',
  'scripts/mapping-workflow.mjs',
  'scripts/validate.mjs',
  'template/src/ui/main.ts',
  'template/src/review/review-main.ts',
];
for (const item of requiredCapabilityFiles) {
  if (!(await exists(resolve(capabilityRoot, item)))) {
    add(blockers, 'LIT_UI_SCAFFOLD_INCOMPLETE', 'Lit UI 能力快照缺少必要文件。', item);
  }
}

const frameworkPath = resolve(capabilityRoot, 'contracts/framework.yaml');
if (await exists(frameworkPath)) {
  const framework = parseYaml(await readFile(frameworkPath, 'utf8'));
  const owners = new Map();
  for (const [concept, definition] of Object.entries(framework.concepts ?? {})) {
    for (const responsibility of definition.owns ?? []) {
      if (owners.has(responsibility)) {
        add(
          blockers,
          'LITSPEC_RESPONSIBILITY_COLLISION',
          `${responsibility} 同时由 ${owners.get(responsibility)} 与 ${concept} 拥有。`,
          'contracts/framework.yaml',
        );
      } else owners.set(responsibility, concept);
    }
  }
  if (!(framework.forbidden ?? []).includes('centralized-ui-table')) {
    add(blockers, 'GENERIC_UI_IR_REQUIRED', 'Framework 未明确禁止集中式 UI 总表。', 'contracts/framework.yaml');
  }
  if (framework.projectData || framework.routes || framework.pages) {
    add(blockers, 'PROJECT_DATA_IN_FRAMEWORK_CONTRACT', 'Framework Contract 含具体项目事实。', 'contracts/framework.yaml');
  }
}

for (const directory of ['models', 'components', 'pages', 'routes', 'events', 'motions', 'ports']) {
  if (!(await exists(resolve(implementation, directory)))) {
    add(blockers, 'LIT_MODULE_AUTHORITY_MISSING', `缺少真实模块目录 ${directory}。`, relative(root, implementation));
  }
}
if (!(await exists(resolve(implementation, 'main.ts')))) {
  add(blockers, 'LIT_MODULE_AUTHORITY_MISSING', '缺少 src/ui/main.ts 直接组合入口。', relative(root, implementation));
}

const adapterFiles = [
  resolve(templateRoot, 'src/adapters/real/browser-host-adapter.ts'),
  resolve(templateRoot, 'src/testing/mock-host-adapter.ts'),
  resolve(templateRoot, 'src/adapters/real/fetch-service-adapter.ts'),
  resolve(templateRoot, 'src/testing/mock-service-adapter.ts'),
  resolve(templateRoot, 'src/testing/port-contract.ts'),
];
if ((await Promise.all(adapterFiles.map(exists))).some((value) => !value)) {
  add(blockers, 'PORT_ADAPTER_CONTRACT_MISMATCH', '缺少真实/Mock Adapter 或共同 Contract Test。', 'lit-ui/template/src');
} else {
  const [realHost, mockHost, realService, mockService] = await Promise.all(
    adapterFiles.slice(0, 4).map((path) => readFile(path, 'utf8')),
  );
  if (
    !realHost.includes('implements HostPort')
    || !mockHost.includes('implements HostPort')
    || !realService.includes('implements ServicePort')
    || !mockService.includes('implements ServicePort')
  ) {
    add(blockers, 'PORT_ADAPTER_CONTRACT_MISMATCH', '真实与 Mock Adapter 未实现同一 Host/Service Port。', 'lit-ui/template/src');
  }
}
const eventContractPath = resolve(implementation, 'events/index.ts');
if (!(await exists(eventContractPath)) || !(await readFile(eventContractPath, 'utf8')).includes('HostEventMap')) {
  add(blockers, 'HOST_EVENT_CONTRACT_MISSING', '缺少稳定类型化 HostEventMap。', relative(root, eventContractPath));
}

const moduleFiles = await regularFiles(implementation);
const forbiddenModelNames = /(?:canonical[-_.]?ui|lit[-_.]?ui[-_.]?spec|generic[-_.]?ui[-_.]?(?:model|ir)|state[-_.]?matrix)/i;
for (const path of moduleFiles) {
  const name = basename(path);
  const text = await readFile(path, 'utf8');
  if (forbiddenModelNames.test(name)) {
    add(blockers, 'GENERIC_UI_IR_REINTRODUCED', '发现集中式 UI 总表替身。', relative(root, path));
  }
  if (/\bcanonicalUi\b|canonical-ui|src\/spec\/canonical/i.test(text)) {
    add(blockers, 'CANONICAL_UI_RUNTIME_DEP_REMAINS', '产品运行代码仍依赖迁移前集中模型。', relative(root, path));
  }
  const aggregateKeys = new Set(
    [...text.matchAll(/\b(routes|pages|components|states|events|motions|ports)\s*:/g)].map((match) => match[1]),
  );
  if (/\bexport\s+const\b/.test(text) && aggregateKeys.size >= 4) {
    add(blockers, 'GENERIC_UI_IR_REINTRODUCED', '发现把多个核心概念聚合为同构 UI 总表的导出。', relative(root, path));
  }
  if (/(?:Mapping\.html|psp-mapping-data|business-cases|component-cases|src\/review)/i.test(text)) {
    add(blockers, 'GENERIC_UI_IR_RUNTIME_DEP', '产品运行模块依赖 Mapping、Case 或 Review 数据。', relative(root, path));
  }
  const importer = relative(implementation, path).split(/[\\/]/)[0];
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const target = match[1].match(/(?:^|\/)(models|components|pages|routes|events|motions|ports)(?:\/|$)/)?.[1];
    const allowed = {
      routes: new Set(['pages', 'models']),
      pages: new Set(['components', 'events', 'motions', 'ports', 'models']),
      components: new Set(['events', 'motions', 'models']),
      events: new Set(['models']),
      motions: new Set(['models']),
      ports: new Set(['models', 'events']),
      models: new Set(),
    }[importer];
    if (allowed && target && target !== importer && !allowed.has(target)) {
      add(blockers, 'LITSPEC_DEPENDENCY_INVALID', `${importer} 不得依赖 ${target}。`, relative(root, path));
    }
  }
  if (['components', 'pages'].includes(importer) && /\b(?:isMock|mockMode|environment\s*===\s*['"]mock)/i.test(text)) {
    add(blockers, 'LIT_COMPONENT_MOCK_COUPLED', 'Page/Component 不得按 Mock 环境分支。', relative(root, path));
  }
  if (importer === 'routes' && /\b(?:render|html)\s*(?:\(|`)/.test(text)) {
    add(blockers, 'LIT_ROUTE_PAGE_COLLISION', 'Route 不得拥有 Page 渲染。', relative(root, path));
  }
}

const projectPath = resolve(root, 'psp.project.yaml');
if (await exists(projectPath)) {
  const projectSource = await readFile(projectPath, 'utf8');
  if (/memberProjections:[\s\S]{0,500}(?:canonical|ui[-_ ]?ir)|\.psp\/models\/canonical/i.test(projectSource)) {
    add(blockers, 'HIDDEN_UI_IR_REMAINS', '项目仍声明隐藏 UI 投影。', 'psp.project.yaml');
  }
  if (/semanticEntry:\s*src\/spec\/|canonical-ui-prototype/i.test(projectSource)) {
    add(blockers, 'CANONICAL_UI_RUNTIME_DEP_REMAINS', '项目仍绑定迁移前语义入口。', 'psp.project.yaml');
  }
}
const packagePath = resolve(root, 'package.json');
if (await exists(packagePath)) {
  const packageSource = await readFile(packagePath, 'utf8');
  if (/refresh[^"\n]*(?:projection|canonical)/i.test(packageSource)) {
    add(blockers, 'CANONICAL_PROJECTION_REFRESH_REQUIRED', '脚本仍要求刷新迁移前投影。', 'package.json');
  }
}

for (const path of await regularFiles(reviewRoot)) {
  const text = await readFile(path, 'utf8');
  if (/\b(?:ProductRoute|ServicePort|BusinessState)\b/.test(text) || /src\/ui\/(?:routes|ports)/.test(text)) {
    add(blockers, 'REVIEW_TOOL_PRODUCT_OWNERSHIP', 'Review Tool 不得拥有产品 Route、State 或 Port。', relative(root, path));
  }
}
const reviewSource = (await Promise.all((await regularFiles(reviewRoot)).map((path) => readFile(path, 'utf8')))).join('\n');
if (!reviewSource.includes('conceptId')) {
  add(blockers, 'REVIEW_MARK_UNBOUND', 'Review 标记未绑定稳定 conceptId。', relative(root, reviewRoot));
}
const productConfigPath = resolve(templateRoot, 'vite.product.config.ts');
const reviewConfigPath = resolve(templateRoot, 'vite.review.config.ts');
if (await exists(productConfigPath) && await exists(reviewConfigPath)) {
  const [productConfig, reviewConfig] = await Promise.all([
    readFile(productConfigPath, 'utf8'),
    readFile(reviewConfigPath, 'utf8'),
  ]);
  if (/review(?:\.html|-main|\/review)/i.test(productConfig)) {
    add(blockers, 'REVIEW_TOOL_FAILURE_PROPAGATED', '产品入口依赖 Review Tool。', relative(root, productConfigPath));
  }
  if (productConfig.match(/outDir:\s*['"]([^'"]+)/)?.[1] === reviewConfig.match(/outDir:\s*['"]([^'"]+)/)?.[1]) {
    add(blockers, 'REVIEW_TOOL_HASH_LEAK', '产品与 Review 共用输出/哈希边界。', relative(root, productConfigPath));
  }
}

if (mappingArgument) {
  const mappingPath = resolve(root, mappingArgument);
  const siblings = await regularFiles(resolve(mappingPath, '..'));
  const parallel = siblings
    .filter((path) => path !== mappingPath && /(?:Preview\.html|mapping\.json)$/i.test(path))
    .map((path) => relative(root, path));
  blockers.push(...validateMapping(await readMapping(mappingPath), { parallelArtifacts: parallel }));
}

if (uihtmlArgument) {
  const uihtmlRoot = resolve(root, uihtmlArgument);
  const productFiles = await regularFiles(uihtmlRoot);
  if (!productFiles.length) add(blockers, 'UIHTML_RUNTIME_DEP_MISSING', 'UIHTML 产物为空。', uihtmlArgument);
  for (const path of productFiles) {
    if (!['.html', '.css', '.js', '.json', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2'].includes(extname(path).toLowerCase())) continue;
    const text = await readFile(path, 'utf8').catch(() => '');
    if (/(?:review-tools|review-main)/i.test(text)) {
      add(blockers, 'REVIEW_TOOL_IN_UIHTML', 'UIHTML 包含 Review Tool。', relative(root, path));
    }
    if (/(?:mock-adapter|MockServiceAdapter|MockHostAdapter)/i.test(text)) {
      add(blockers, 'MOCK_ADAPTER_IN_UIHTML', 'UIHTML 包含 Mock Adapter。', relative(root, path));
    }
    if (/(?:business-cases|component-cases|BUSINESS-CASE-|COMPONENT-CASE-)/i.test(text)) {
      add(blockers, 'UI_CASE_RUNTIME_DEP', 'UIHTML 依赖 Case 数据。', relative(root, path));
    }
    if (/(?:Mapping\.html|psp-mapping-data|review-tools|review-main|mock-adapter|business-cases|component-cases|generic-ui-ir)/i.test(text)) {
      add(blockers, 'NON_PRODUCT_DEPENDENCY_IN_UIHTML', 'UIHTML 含非产品依赖。', relative(root, path));
    }
  }
}

const controlPlaneNames = /(?:harness\.manifest|resolver|profile|run-gate|handoff|receipt-registry)/i;
for (const path of await regularFiles(capabilityRoot)) {
  if (controlPlaneNames.test(basename(path))) {
    add(blockers, 'CENTRAL_UI_CONTROL_PLANE_REINTRODUCED', '发现中央生命周期控制面文件。', relative(root, path));
  }
}

if (scaffoldMode) {
  for (const path of [
    resolve(root, 'Mapping.html'),
    resolve(root, 'src/ui'),
    resolve(root, 'UIHTML'),
  ]) {
    if (await exists(path)) {
      add(blockers, 'PRODUCT_INSTANCE_IN_SCAFFOLD', '脚手架模板含真实项目实例。', relative(root, path));
    }
  }
}

for (const path of await regularFiles(resolve(root, '.agents/skills/lit-ui'))) {
  const relativePath = relative(root, path);
  if (/(?:node_modules|[\\/](?:dist|UIHTML|\.vite|runtime-evidence)[\\/])/.test(relativePath)) {
    add(blockers, 'SCAFFOLD_BUILD_OUTPUT_LEAK', '能力模板包含依赖、构建或运行证据。', relativePath);
  }
}

const status = blockers.length ? 'BLOCKED' : 'PASS';
const output = { status, blockers, checks: {
  framework: blockers.some((item) => item.code.startsWith('LITSPEC_')) ? 'FAIL' : 'PASS',
  mapping: mappingArgument ? (blockers.some((item) => item.code.startsWith('MAPPING_')) ? 'FAIL' : 'PASS') : 'NOT_RUN',
  modules: blockers.some((item) => item.code.startsWith('LIT_') || item.code.startsWith('GENERIC_')) ? 'FAIL' : 'PASS',
  review: blockers.some((item) => item.code.startsWith('REVIEW_')) ? 'FAIL' : 'PASS',
  uihtml: uihtmlArgument ? (blockers.some((item) => item.code.includes('UIHTML')) ? 'FAIL' : 'PASS') : 'NOT_RUN',
}};
console.log(JSON.stringify(output));
process.exitCode = status === 'PASS' ? 0 : 1;
