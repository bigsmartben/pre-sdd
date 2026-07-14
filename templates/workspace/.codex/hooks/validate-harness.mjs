import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let inputText = '';
for await (const chunk of process.stdin) inputText += chunk;
let event = {};
try {
  event = inputText.trim() ? JSON.parse(inputText) : {};
} catch {
  // 输入异常时回退到当前目录。
}

function emit(additionalContext, systemMessage) {
  process.stdout.write(JSON.stringify({
    ...(systemMessage ? { systemMessage } : {}),
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
  }));
}

const cwd = resolve(typeof event.cwd === 'string' ? event.cwd : process.cwd());
let root = cwd;
while (true) {
  if (existsSync(join(root, 'psp.project.yaml')) && existsSync(join(root, '.psp', 'harness'))) break;
  const parent = dirname(root);
  if (parent === root) {
    root = null;
    break;
  }
  root = parent;
}
if (!root) {
  const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (gitRoot.status === 0) root = gitRoot.stdout.trim();
}
if (!root) {
  emit('AIH_HOOK_DEGRADED：无法确定 PSP 工作区根目录。', 'Repository Harness Hook 无法定位工作区。');
  process.exit(0);
}
const adapter = join(root, '.psp', 'harness', 'scripts', 'invoke-pre-sdd.mjs');
if (!existsSync(adapter)) {
  emit('AIH_HOOK_DEGRADED：缺少 pre-sdd 工作区适配器。', 'Repository Harness Hook 缺失。');
  process.exit(0);
}

const validation = spawnSync(process.execPath, [adapter, 'harness', 'validate:harness'], {
  cwd: root,
  encoding: 'utf8',
  timeout: 30_000,
  windowsHide: true,
});
if (validation.status === 0) {
  emit('Repository Harness 契约校验 PASS。继续前读取 AGENTS.md、HARNESS.md、psp.project.yaml 与 Manifest。');
} else {
  const details = validation.stderr.trim() || validation.stdout.trim() || '运行时未返回证据';
  emit('AIH_VALIDATION_FAILED：' + details, 'Repository Harness 契约校验失败。');
}
