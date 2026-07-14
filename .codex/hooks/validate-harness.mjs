import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

let inputText = '';
for await (const chunk of process.stdin) {
  inputText += chunk;
}

let event = {};
try {
  event = inputText.trim() ? JSON.parse(inputText) : {};
} catch {
  // Hook 输入异常不应让仓库无法启动；下方会使用 process.cwd()。
}

function emit(additionalContext, systemMessage) {
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  }));
}

const cwd = typeof event.cwd === 'string' ? event.cwd : process.cwd();
const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
});

if (gitRoot.status !== 0) {
  emit(
    'AIH_HOOK_DEGRADED：无法确定 Git 根目录。继续前请定位 PSP 仓库并运行 npm run validate:harness。',
    'Repository Harness SessionStart Hook 无法定位仓库根目录。',
  );
  process.exit(0);
}

const root = gitRoot.stdout.trim();
const validator = join(root, '.psp', 'harness', 'scripts', 'validate-harness.mjs');
const requiredDependencies = ['ajv', 'toml', 'yaml', 'picomatch'];

if (!existsSync(validator)) {
  emit(
    'AIH_HOOK_DEGRADED：Harness validator 缺失。只允许修复 Harness 契约，不要声明仓库门禁通过。',
    'Repository Harness validator 缺失。',
  );
  process.exit(0);
}

const missingDependencies = requiredDependencies.filter((name) => !existsSync(join(root, 'node_modules', name)));
if (missingDependencies.length > 0) {
  emit(
    `AIH_HOOK_DEGRADED：缺少 ${missingDependencies.join(', ')}。修改前运行 npm install，再运行 npm run validate:harness。`,
  );
  process.exit(0);
}

const validation = spawnSync(process.execPath, [validator, '--json'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 25_000,
  windowsHide: true,
});

let result;
try {
  result = JSON.parse(validation.stdout);
} catch {
  result = null;
}

if (validation.status === 0 && result?.status === 'PASS') {
  emit(
    'Repository Harness 契约校验 PASS。变更前读取 psp.project.yaml、.psp/harness/HARNESS.md 与绑定的 manifest；使用 $apply-repository-harness 调用 resolver，并执行全部返回命令。',
  );
  process.exit(0);
}

const details = result?.blockers
  ?.map((blocker) => `${blocker.code}: ${blocker.message}`)
  .join('；') || validation.stderr.trim() || 'validator 未返回可解析结果';

emit(
  `AIH_VALIDATION_FAILED：${details}。只允许修复 Harness 契约；修复后运行 npm run validate:harness。`,
  'Repository Harness 契约校验失败。',
);
