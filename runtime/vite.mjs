import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build, createServer } from 'vite';
import { boundArea, loadWorkspace } from './workspace.mjs';
import { runTypecheck } from './typecheck.mjs';

const require = createRequire(import.meta.url);

function dependencyAliases() {
  return [
    { find: 'lit', replacement: require.resolve('lit') },
    { find: 'msw', replacement: require.resolve('msw') },
    { find: 'msw/browser', replacement: require.resolve('msw/browser') },
  ];
}

async function htmlMockRoot(workspaceRoot) {
  const { root, project } = await loadWorkspace(workspaceRoot);
  const binding = boundArea(project, 'html-mock');
  if (binding.stage.status !== 'active') {
    throw Object.assign(new Error('产品设计阶段尚未初始化，不能运行 HTML Mock。'), {
      code: 'AIH_STAGE_UNINITIALIZED',
    });
  }
  return resolve(root, ...binding.path.split('/'));
}

export async function runBuild(workspaceRoot, packageRoot) {
  const typecheck = await runTypecheck(workspaceRoot, packageRoot);
  if (typecheck !== 0) return typecheck;
  try {
    const root = await htmlMockRoot(workspaceRoot);
    await build({
      root,
      configFile: false,
      resolve: { alias: dependencyAliases() },
      build: { emptyOutDir: true },
    });
    console.log('[PASS] HTML Mock Vite 构建通过。');
    return 0;
  } catch (error) {
    console.error('[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message);
    return 1;
  }
}

export async function runDev(workspaceRoot) {
  try {
    const root = await htmlMockRoot(workspaceRoot);
    const server = await createServer({
      root,
      configFile: false,
      resolve: { alias: dependencyAliases() },
      server: { port: 4173 },
    });
    await server.listen();
    server.printUrls();
    return await new Promise((resolveExit) => {
      const close = async () => {
        await server.close();
        resolveExit(0);
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    });
  } catch (error) {
    console.error('[' + (error.code || 'AIH_VALIDATION_FAILED') + '] ' + error.message);
    return 1;
  }
}
