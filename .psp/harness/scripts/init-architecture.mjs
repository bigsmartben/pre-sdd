import {
  access,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { writeExpectedOutputs } from './lib/rendering.mjs';
import {
  artifactPaths,
  joinRepositoryPath,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const dryRun = process.argv.includes('--dry-run');
const json = process.argv.includes('--json');
const operationId = 'initialize-architecture';
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

async function directoryHasFiles(path) {
  let entries;
  try {
    entries = await readdir(repositoryFile(root, path), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) return true;
    if (await directoryHasFiles(path + '/' + entry.name)) return true;
  }
  return false;
}

async function templateFiles(templateRoot, relative = '') {
  const directory = relative ? templateRoot + '/' + relative : templateRoot;
  const entries = await readdir(repositoryFile(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...await templateFiles(templateRoot, next));
    else if (entry.isFile()) files.push({ source: templateRoot + '/' + next, relative: next });
  }
  return files;
}

async function rollback(createdFiles, stageRoot, stageRootExisted) {
  for (const path of [...createdFiles].reverse()) await rm(repositoryFile(root, path), { force: true });
  if (!stageRootExisted) await rm(repositoryFile(root, stageRoot), { recursive: true, force: true });
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
  const operation = manifest.operations.find((item) => item.id === operationId);
  if (!operation) {
    throw Object.assign(new Error('Harness manifest 未声明 operation：' + operationId), {
      code: 'AIH_CONTRACT_INVALID',
    });
  }
  const stage = project.stages?.[operation.stage];
  if (!stage) {
    throw Object.assign(new Error('项目未绑定 operation 阶段：' + operation.stage), {
      code: 'AIH_PROJECT_BINDING_INVALID',
    });
  }
  if (stage.status === operation.toState) {
    throw Object.assign(new Error('阶段已经完成初始化：' + operation.stage), {
      code: 'AIH_STAGE_ALREADY_INITIALIZED',
    });
  }
  if (stage.status !== operation.fromState) {
    throw Object.assign(new Error('阶段状态不允许初始化：' + stage.status), {
      code: stage.blockerCode || 'AIH_PROJECT_BINDING_INVALID',
    });
  }

  const upstream = spawnSync(process.execPath, [resolve(import.meta.dirname, 'validate-product.mjs'), '--strict', '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PSP_REPOSITORY_ROOT: root,
      AI_HARNESS_ROOT: root,
    },
    timeout: 30_000,
    windowsHide: true,
  });
  if (upstream.status !== 0) {
    throw Object.assign(new Error('产品严格门禁未通过：' + validatorEvidence(upstream)), {
      code: 'AIH_UPSTREAM_NOT_READY',
    });
  }

  const modelCopies = [];
  const outputTargets = [];
  for (const registry of manifest.artifactRegistry.filter((item) => item.stage === operation.stage)) {
    const paths = artifactPaths(project, registry.id, registry.stage);
    if (!paths) {
      throw Object.assign(new Error('项目缺少 Artifact 绑定：' + registry.id), {
        code: 'AIH_PROJECT_BINDING_INVALID',
      });
    }
    modelCopies.push({ source: registry.template, target: paths.internalModel });
    outputTargets.push(...paths.outputPaths);
  }

  const areaCopies = [];
  for (const [areaId, templateRoot] of Object.entries(operation.areaTemplates)) {
    const area = stage.areas?.[areaId];
    if (!area) {
      throw Object.assign(new Error('项目缺少 Area 绑定：' + areaId), {
        code: 'AIH_PROJECT_BINDING_INVALID',
      });
    }
    for (const file of await templateFiles(templateRoot)) {
      areaCopies.push({
        source: file.source,
        target: joinRepositoryPath(stage.root, area.root, file.relative),
      });
    }
  }

  const stageRootExisted = await exists(stage.root);
  if (await directoryHasFiles(stage.root)) {
    throw Object.assign(new Error('用户目录中已存在文件，初始化不会覆盖：' + stage.root), {
      code: 'AIH_USER_CHANGE_COLLISION',
    });
  }

  const targets = [
    ...modelCopies.map((item) => item.target),
    ...outputTargets,
    ...areaCopies.map((item) => item.target),
    'psp.project.yaml',
  ];
  const duplicate = targets.find((path, index) => targets.indexOf(path) !== index);
  if (duplicate) {
    throw Object.assign(new Error('初始化目标重复：' + duplicate), {
      code: 'AIH_PROJECT_BINDING_INVALID',
    });
  }

  if (dryRun) {
    result = {
      status: 'PASS',
      mode: 'dry-run',
      operation: operationId,
      stage: operation.stage,
      fromState: operation.fromState,
      toState: operation.toState,
      upstream: { stage: 'product-design', command: 'validate:product:strict', status: 'PASS' },
      targets: targets.sort(),
      blockers: [],
    };
  } else {
    const createdFiles = [];
    try {
      for (const item of [...modelCopies, ...areaCopies]) {
        const absolute = repositoryFile(root, item.target);
        await mkdir(dirname(absolute), { recursive: true });
        await copyFile(repositoryFile(root, item.source), absolute);
        createdFiles.push(item.target);
      }

      const outputs = await writeExpectedOutputs(root, project, manifest, operation.stage);
      for (const output of outputs) {
        if (!createdFiles.includes(output.output)) createdFiles.push(output.output);
      }

      const validation = spawnSync(process.execPath, [resolve(import.meta.dirname, 'validate-architecture.mjs'), '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          PSP_REPOSITORY_ROOT: root,
          AI_HARNESS_ROOT: root,
          AI_HARNESS_INITIALIZING: operation.stage,
        },
        timeout: 30_000,
        windowsHide: true,
      });
      if (validation.status !== 0) {
        throw Object.assign(new Error('初始化结构校验失败：' + validatorEvidence(validation)), {
          code: 'AIH_VALIDATION_FAILED',
        });
      }

      const originalProject = await readFile(repositoryFile(root, 'psp.project.yaml'), 'utf8');
      project.stages[operation.stage].status = operation.toState;
      const temporaryProject = 'psp.project.yaml.init.tmp';
      try {
        await writeFile(repositoryFile(root, temporaryProject), stringifyYaml(project), 'utf8');
        await rename(repositoryFile(root, temporaryProject), repositoryFile(root, 'psp.project.yaml'));
      } catch (error) {
        await rm(repositoryFile(root, temporaryProject), { force: true });
        await writeFile(repositoryFile(root, 'psp.project.yaml'), originalProject, 'utf8');
        throw error;
      }

      result = {
        status: 'PASS',
        mode: 'initialize',
        operation: operationId,
        stage: operation.stage,
        fromState: operation.fromState,
        toState: operation.toState,
        upstream: { stage: 'product-design', command: 'validate:product:strict', status: 'PASS' },
        outputs: ['psp.project.yaml', ...createdFiles].sort(),
        blockers: [],
      };
    } catch (error) {
      await rollback(createdFiles, stage.root, stageRootExisted);
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
  console.log('[PASS] ' + (dryRun ? '架构初始化预检通过。' : '架构 Package 已原子初始化。'));
  for (const path of result.targets || result.outputs || []) console.log('  ' + path);
} else {
  for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
}

if (result.status !== 'PASS') process.exitCode = 1;
