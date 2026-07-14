import {
  access,
  mkdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  joinRepositoryPath,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
  stageHasUserFiles,
  workspaceRootMarker,
} from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');
const operationId = 'initialize-workspace';
let result;

async function exists(path) {
  try {
    await access(repositoryFile(root, path));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function validatorEvidence(validation) {
  let evidence = validation.stderr.trim() || validation.stdout.trim();
  try {
    const parsed = JSON.parse(validation.stdout);
    evidence = (parsed.blockers || []).map((item) => item.code + ': ' + item.message).join('; ');
  } catch {
    // Keep raw validator evidence.
  }
  return evidence;
}

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const operation = manifest.operations.find((item) => item.id === operationId && item.kind === 'workspace');
  if (!operation) {
    throw Object.assign(new Error('Harness manifest 未声明 workspace operation：' + operationId), {
      code: 'AIH_CONTRACT_INVALID',
    });
  }
  const marker = workspaceRootMarker(manifest);
  if (!marker) {
    throw Object.assign(new Error('Harness manifest 未声明 workspace Scope 或目录标记。'), {
      code: 'AIH_SCOPE_INVALID',
    });
  }

  const stages = Object.entries(project.stages).filter(([, stage]) => stage.status !== 'unavailable');
  const initialized = stages.filter(([, stage]) => stage.status !== 'uninitialized');
  if (initialized.length > 0) {
    throw Object.assign(new Error(
      '纯脚手架初始化要求所有阶段均为 uninitialized；当前已实例化：'
      + initialized.map(([stageId]) => stageId).join(', '),
    ), { code: 'AIH_WORKSPACE_NOT_EMPTY' });
  }

  for (const [stageId, stage] of stages) {
    if (await stageHasUserFiles(root, stage.root, [marker])) {
      throw Object.assign(new Error('阶段目录包含用户实例文件：' + stageId + ' (' + stage.root + ')'), {
        code: 'AIH_PARTIAL_INITIALIZATION',
      });
    }
  }

  const targets = stages.map(([, stage]) => joinRepositoryPath(stage.root, marker)).sort();
  if (dryRun) {
    result = {
      status: 'PASS',
      mode: 'dry-run',
      operation: operationId,
      state: 'pure-scaffold',
      targets,
      blockers: [],
    };
  } else {
    const createdFiles = [];
    const createdRoots = [];
    try {
      for (const [, stage] of stages) {
        if (!await exists(stage.root)) {
          await mkdir(repositoryFile(root, stage.root), { recursive: true });
          createdRoots.push(stage.root);
        }
        const markerPath = joinRepositoryPath(stage.root, marker);
        if (!await exists(markerPath)) {
          await writeFile(repositoryFile(root, markerPath), '', 'utf8');
          createdFiles.push(markerPath);
        }
      }

      const validation = spawnSync(
        process.execPath,
        [resolve(import.meta.dirname, 'validate-harness.mjs'), '--json'],
        {
          cwd: root,
          encoding: 'utf8',
          env: {
            ...process.env,
            PSP_REPOSITORY_ROOT: root,
            AI_HARNESS_ROOT: root,
          },
          timeout: 30_000,
          windowsHide: true,
        },
      );
      if (validation.status !== 0) {
        throw Object.assign(new Error('工作区初始化后 Harness 校验失败：' + validatorEvidence(validation)), {
          code: 'AIH_VALIDATION_FAILED',
        });
      }

      result = {
        status: 'PASS',
        mode: 'initialize',
        operation: operationId,
        state: 'pure-scaffold',
        outputs: targets,
        blockers: [],
      };
    } catch (error) {
      for (const path of [...createdFiles].reverse()) await rm(repositoryFile(root, path), { force: true });
      for (const path of [...createdRoots].reverse()) {
        await rm(repositoryFile(root, path), { recursive: true, force: true });
      }
      throw error;
    }
  }
} catch (error) {
  result = {
    status: 'BLOCKED',
    mode: dryRun ? 'dry-run' : 'initialize',
    operation: operationId,
    blockers: [{
      code: error.code || 'AIH_VALIDATION_FAILED',
      message: error.message,
    }],
  };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') {
  console.log('[PASS] ' + (dryRun ? '纯脚手架工作区初始化预检通过。' : '纯脚手架工作区已初始化。'));
  for (const path of result.targets || result.outputs || []) console.log('  ' + path);
} else {
  for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
}

if (result.status !== 'PASS') process.exitCode = 1;
