#!/usr/bin/env node
import { resolve } from 'node:path';
import { dispatchHarness } from '../runtime/dispatch.mjs';
import { initializeWorkspace } from '../runtime/init.mjs';

function usage() {
  console.log('用法：');
  console.log('  pre-sdd init <已存在目录>');
  console.log('  pre-sdd harness <npm-script> [-- <参数>]');
}

const args = process.argv.slice(2);
let status = 0;
try {
  if (args[0] === 'init' && args.length === 2) {
    status = await initializeWorkspace(args[1]);
  } else if (args[0] === 'harness' && args[1]) {
    const forwarded = args.slice(2);
    let workspaceRoot = process.cwd();
    const workspaceIndex = forwarded.indexOf('--workspace');
    if (workspaceIndex >= 0) {
      const workspaceValue = forwarded[workspaceIndex + 1];
      if (!workspaceValue || workspaceValue === '--') {
        throw Object.assign(new Error('--workspace 必须提供目标工作区路径。'), { code: 'PRE_SDD_USAGE_INVALID' });
      }
      workspaceRoot = resolve(workspaceValue);
      forwarded.splice(workspaceIndex, 2);
    }
    if (forwarded[0] === '--') forwarded.shift();
    status = await dispatchHarness(args[1], workspaceRoot, forwarded);
  } else if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
  } else {
    usage();
    throw Object.assign(new Error('不支持的命令或参数。'), { code: 'PRE_SDD_USAGE_INVALID' });
  }
} catch (error) {
  console.error('[' + (error.code || 'PRE_SDD_INITIALIZATION_FAILED') + '] ' + error.message);
  status = 1;
}

process.exitCode = status;
