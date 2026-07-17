import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build, createServer } from 'vite';
import { artifactPaths, loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const require = createRequire(process.env.PRE_SDD_DEPENDENCY_ENTRY || process.env.PRE_SDD_RUNTIME_ENTRY || import.meta.url);

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function dependencyAliases() {
  return [
    { find: 'lit', replacement: require.resolve('lit') },
    { find: 'msw/browser', replacement: require.resolve('msw/browser') },
    { find: 'msw', replacement: require.resolve('msw') },
  ];
}

async function typescriptFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
    }
  }
  await visit(root);
  return files.sort();
}

function dependencyRoot(specifier) {
  let directory = dirname(require.resolve(specifier));
  while (dirname(directory) !== directory) {
    try {
      require.resolve(join(directory, 'package.json'));
      return directory;
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error('无法定位领域运行依赖：' + specifier);
}

async function prototypeRoot() {
  const { project } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  if (stage?.status !== 'active' && process.env.AI_HARNESS_INITIALIZING !== 'product-design') {
    throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  }
  if (!paths?.area) throw Object.assign(new Error('项目未绑定 Canonical UI Prototype Area。'), { code: 'AIH_PROJECT_BINDING_INVALID' });
  return repositoryFile(root, project.stages['product-design'].root + '/' + project.stages['product-design'].areas[paths.area].root);
}

async function typecheck() {
  const area = await prototypeRoot();
  const sourceConfig = JSON.parse(await readFile(resolve(area, 'tsconfig.json'), 'utf8'));
  const temporary = await mkdtemp(join(tmpdir(), 'psp-canonical-typecheck-'));
  try {
    const configPath = resolve(temporary, 'tsconfig.json');
    await writeFile(configPath, JSON.stringify({
      compilerOptions: {
        ...sourceConfig.compilerOptions,
        paths: {
          lit: [resolve(dependencyRoot('lit'), 'development/index.d.ts')],
          msw: [resolve(dependencyRoot('msw'), 'lib/core/index.d.mts')],
          'msw/browser': [resolve(dependencyRoot('msw'), 'lib/browser/index.d.mts')],
        },
      },
      files: [
        ...await typescriptFiles(resolve(area, 'src')),
        resolve(dependencyRoot('vite'), 'client.d.ts'),
      ],
    }, null, 2), 'utf8');
    const typescript = resolve(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
    const result = spawnSync(process.execPath, [typescript, '--project', configPath, '--pretty', 'false'], {
      cwd: area,
      stdio: 'inherit',
      windowsHide: true,
    });
    if (result.status === 0) console.log('[PASS] Canonical UI Prototype TypeScript 校验通过。');
    return result.status ?? 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function buildPrototype() {
  const checked = await typecheck();
  if (checked !== 0) return checked;
  const area = await prototypeRoot();
  await build({ root: area, configFile: false, resolve: { alias: dependencyAliases() }, build: { emptyOutDir: true } });
  console.log('[PASS] Canonical UI Prototype 构建通过。');
  return 0;
}

async function dev() {
  const area = await prototypeRoot();
  const server = await createServer({ root: area, configFile: false, resolve: { alias: dependencyAliases() }, server: { port: 4173 } });
  await server.listen();
  server.printUrls();
  const localUrl = server.resolvedUrls?.local?.[0];
  if (!localUrl) {
    await server.close();
    throw Object.assign(new Error('开发服务器已启动，但没有返回可访问的本地地址。'), { code: 'AIH_CANONICAL_UI_SERVER_FAILED' });
  }
  console.log('[READY] Canonical UI Prototype 评审地址：' + new URL(localUrl).href);
  return await new Promise((resolveExit) => {
    const close = async () => { await server.close(); resolveExit(0); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  });
}

function installBrowser() {
  const playwrightRoot = dirname(require.resolve('playwright/package.json'));
  return spawnSync(process.execPath, [resolve(playwrightRoot, 'cli.js'), 'install', 'chromium'], {
    stdio: 'inherit',
    windowsHide: true,
  }).status ?? 1;
}

const capability = argument('capability');
let status = 1;
try {
  if (capability === 'typecheck') status = await typecheck();
  else if (capability === 'build') status = await buildPrototype();
  else if (capability === 'dev') status = await dev();
  else if (capability === 'install-browser') status = installBrowser();
  else throw Object.assign(new Error('未知 Canonical UI Prototype capability：' + capability), { code: 'AIH_COMMAND_INVALID' });
} catch (error) {
  console.error('[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message);
  status = 1;
}
process.exitCode = status;
