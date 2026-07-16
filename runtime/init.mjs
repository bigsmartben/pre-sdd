import { access, cp, lstat, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { dispatchHarness, packageRoot, runtimeWorkspace } from './dispatch.mjs';

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function containsNodeModules(root) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') return true;
    if (entry.isDirectory() && await containsNodeModules(join(root, entry.name))) return true;
  }
  return false;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

async function snapshotRuntime(workspaceRoot) {
  const target = join(workspaceRoot, '.psp', 'runtime', 'pre-sdd');
  await mkdir(target, { recursive: true });
  for (const entry of ['bin', 'runtime']) {
    await cp(join(packageRoot, entry), join(target, entry), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
  }
  await cp(join(packageRoot, 'package.json'), join(target, 'package.json'), {
    force: false,
    errorOnExist: true,
  });
}

export async function initializeWorkspace(targetInput) {
  const target = resolve(targetInput);
  let targetStat;
  try {
    targetStat = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') fail('PRE_SDD_TARGET_INVALID', '目标目录不存在：' + target);
    throw error;
  }
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) {
    fail('PRE_SDD_TARGET_INVALID', '目标必须是已存在的真实目录：' + target);
  }

  const ownedEntries = (await readdir(runtimeWorkspace)).sort();
  const collisions = [];
  for (const entry of ownedEntries) {
    if (await exists(join(target, entry))) collisions.push(entry);
  }
  if (collisions.length) {
    fail('PRE_SDD_PATH_COLLISION', '脚手架归属路径已存在：' + collisions.join(', '));
  }

  const parent = dirname(target);
  const staging = await mkdtemp(join(parent, '.pre-sdd-stage-'));
  const moved = [];
  try {
    for (const entry of ownedEntries) {
      await cp(join(runtimeWorkspace, entry), join(staging, entry), {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
    }
    await snapshotRuntime(staging);
    const validations = [
      ['init:workspace', []],
      ['validate:harness', []],
      ['validate:workspace', []],
      ['validate:product', []],
      ['validate:architecture', []],
    ];
    for (const [script, args] of validations) {
      const status = await dispatchHarness(script, staging, args);
      if (status !== 0) fail('PRE_SDD_TEMPLATE_INVALID', '工作区模板验证失败：' + script);
    }
    if (await containsNodeModules(staging)) {
      fail('PRE_SDD_TEMPLATE_INVALID', '工作区模板不得包含 node_modules。');
    }

    for (const entry of ownedEntries) {
      await rename(join(staging, entry), join(target, entry));
      moved.push(entry);
    }
    console.log('[PASS] pre-sdd 纯工作区已初始化：' + target);
    console.log('  产品设计：uninitialized');
    console.log('  架构设计：uninitialized');
    return 0;
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of [...moved].reverse()) {
      try {
        await rename(join(target, entry), join(staging, entry));
      } catch (rollbackError) {
        rollbackFailures.push(entry + ': ' + rollbackError.message);
      }
    }
    if (rollbackFailures.length) {
      error.code = 'PRE_SDD_ROLLBACK_FAILED';
      error.message += '；回滚失败：' + rollbackFailures.join('; ');
    }
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
