import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { boundArea, loadWorkspace } from './workspace.mjs';

const require = createRequire(import.meta.url);

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

function packageRoot(specifier) {
  let directory = dirname(require.resolve(specifier));
  while (dirname(directory) !== directory) {
    try {
      require.resolve(join(directory, 'package.json'));
      return directory;
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error('无法定位运行时依赖：' + specifier);
}

export async function runTypecheck(workspaceRoot) {
  const { root, project } = await loadWorkspace(workspaceRoot);
  const binding = boundArea(project, 'html-mock');
  if (binding.stage.status !== 'active') {
    console.error('[AIH_STAGE_UNINITIALIZED] 产品设计阶段尚未初始化，不能执行 TypeScript 校验。');
    return 1;
  }

  const areaRoot = resolve(root, ...binding.path.split('/'));
  const sourceConfig = JSON.parse(await readFile(resolve(areaRoot, 'tsconfig.json'), 'utf8'));
  const litRoot = packageRoot('lit');
  const mswRoot = packageRoot('msw');
  const viteRoot = packageRoot('vite');
  const temporary = await mkdtemp(join(tmpdir(), 'pre-sdd-typecheck-'));
  try {
    const configPath = resolve(temporary, 'tsconfig.json');
    const config = {
      compilerOptions: {
        ...sourceConfig.compilerOptions,
        paths: {
          lit: [resolve(litRoot, 'development/index.d.ts')],
          msw: [resolve(mswRoot, 'lib/core/index.d.mts')],
          'msw/browser': [resolve(mswRoot, 'lib/browser/index.d.mts')],
        },
      },
      files: [
        ...await typescriptFiles(resolve(areaRoot, 'src')),
        resolve(viteRoot, 'client.d.ts'),
      ],
    };
    await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    const typescriptRoot = dirname(require.resolve('typescript/package.json'));
    const result = spawnSync(process.execPath, [resolve(typescriptRoot, 'bin', 'tsc'), '--project', configPath, '--pretty', 'false'], {
      cwd: areaRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) {
      process.stderr.write(result.stderr || result.stdout);
      return result.status ?? 1;
    }
    console.log('[PASS] HTML Mock TypeScript 校验通过。');
    return 0;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
