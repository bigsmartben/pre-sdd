import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = resolve(argument('root', process.cwd()));
const mode = argument('mode', 'product');
const entry = mode === 'review' ? 'review.html' : 'index.html';
if (!existsSync(resolve(root, entry)) || !existsSync(resolve(root, 'src/ui/main.ts'))) {
  console.error(JSON.stringify({
    status: 'BLOCKED',
    blockers: [{ code: 'LIT_MODULE_AUTHORITY_MISSING', message: '工作区尚未拥有真实 src/ui 模块与 HTML 入口。' }],
  }));
  process.exitCode = 1;
} else {
  const executable = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
  const config = resolve(root, mode === 'review' ? 'vite.review.config.ts' : 'vite.product.config.ts');
  const result = spawnSync(executable, ['build', '--config', config], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    console.error(JSON.stringify({
      status: 'BLOCKED',
      blockers: [{ code: 'LIT_DIRECT_BUILD_FAILED', message: result.error.message }],
    }));
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
