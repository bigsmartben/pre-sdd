import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = resolve(argument('root', process.cwd()));
const mode = argument('mode', 'product');
const blockers = [];
if (!['product', 'review'].includes(mode)) {
  blockers.push({ code: 'VSD_BUILD_MODE_INVALID', message: 'Build mode 只能是 product 或 review。' });
}
const required = mode === 'review'
  ? ['review.html', 'src/ui/main.ts', 'src/review/review-main.ts', '.psp/visual-spec/ready-authorization.json']
  : ['index.html', 'src/product-main.ts', 'src/ui/main.ts', 'src/adapters/real', '.psp/visual-spec/delivery-manifest.json'];
for (const path of required) {
  if (!existsSync(resolve(root, path))) blockers.push({ code: 'VSD_BUILD_INPUT_MISSING', message: `缺少 ${path}` });
}
if (blockers.length) {
  console.error(JSON.stringify({ status: 'BLOCKED', blockers }));
  process.exitCode = 1;
} else {
  const preflightScript = mode === 'review'
    ? resolve(root, '.agents/skills/visual-spec/scripts/authorize.mjs')
    : resolve(root, '.agents/skills/lit-ui/scripts/validate.mjs');
  const preflightArgs = mode === 'review'
    ? [preflightScript]
    : [preflightScript, '--phase', 'product'];
  const preflight = spawnSync(process.execPath, preflightArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PSP_REPOSITORY_ROOT: root },
  });
  if (preflight.status !== 0) {
    console.error(JSON.stringify({
      status: 'BLOCKED',
      blockers: [{
        code: mode === 'review' ? 'VSD_READY_AUTHORIZATION_INVALID' : 'VSD_DELIVERY_NOT_ACCEPTED',
        message: preflight.stdout || preflight.stderr,
      }],
    }));
    process.exitCode = 1;
  } else {
  const executable = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js');
  const config = resolve(root, mode === 'review' ? 'vite.review.config.ts' : 'vite.product.config.ts');
  const result = spawnSync(process.execPath, [executable, 'build', '--config', config], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    console.error(JSON.stringify({
      status: 'BLOCKED',
      blockers: [{ code: 'VSD_BUILD_FAILED', message: result.error?.message ?? `Vite exit ${result.status}` }],
    }));
    process.exitCode = 1;
  } else if (mode === 'product') {
    const recording = spawnSync(
      process.execPath,
      [resolve(root, '.agents/skills/lit-ui/scripts/record-uihtml.mjs'), '--from-build'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: {
          ...process.env,
          PSP_REPOSITORY_ROOT: root,
          PSP_UIHTML_BUILD_PARENT: String(process.pid),
        },
      },
    );
    if (recording.status !== 0) {
      console.error(JSON.stringify({
        status: 'BLOCKED',
        blockers: [{
          code: 'VSD_UIHTML_RECORD_FAILED',
          message: recording.stdout || recording.stderr,
        }],
      }));
      process.exitCode = 1;
    }
  }
  }
}
