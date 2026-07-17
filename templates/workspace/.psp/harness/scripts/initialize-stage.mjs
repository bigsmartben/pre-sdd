import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { executeRegisteredCommand } from './lib/execute-command.mjs';
import { executeHandoff } from './run-handoff.mjs';
import { resolveHarness, selectorPatterns } from './lib/routing.mjs';
import {
  artifactPaths,
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
const operationArgument = process.argv.indexOf('--operation');
const operationId = operationArgument >= 0 ? process.argv[operationArgument + 1] : null;
let result;

async function exists(path) {
  try { await access(repositoryFile(root, path)); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function templateFiles(templateRoot, relative = '') {
  const directory = joinRepositoryPath(templateRoot, relative);
  const entries = await readdir(repositoryFile(root, directory), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (['node_modules', 'dist', '.vite'].includes(entry.name)) continue;
    const next = joinRepositoryPath(relative, entry.name);
    if (entry.isDirectory()) files.push(...await templateFiles(templateRoot, next));
    else if (entry.isFile()) files.push({ source: joinRepositoryPath(templateRoot, next), relative: next });
  }
  return files;
}

async function rollback(paths, stageRoot, stageRootExisted) {
  for (const path of [...new Set(paths)].reverse()) await rm(repositoryFile(root, path), { recursive: true, force: true });
  if (!stageRootExisted) await rm(repositoryFile(root, stageRoot), { recursive: true, force: true });
  else {
    const createdRoots = new Set(paths
      .filter((path) => path.startsWith(stageRoot + '/'))
      .map((path) => stageRoot + '/' + path.slice(stageRoot.length + 1).split('/')[0]));
    for (const path of createdRoots) await rm(repositoryFile(root, path), { recursive: true, force: true });
  }
}

function readinessPath(scope, project, manifest) {
  const patterns = selectorPatterns(scope.selector, project, manifest);
  const concrete = patterns.find((path) => !path.includes('*'));
  if (!concrete) {
    throw Object.assign(new Error('上游 Scope 没有可解析的 readiness 路径：' + scope.id), { code: 'AIH_SCOPE_INVALID' });
  }
  return concrete;
}

function executeUpstreamReadiness(project, manifest, scopeIds) {
  if (!scopeIds?.length) return;
  const scopes = new Map(manifest.scopes.map((scope) => [scope.id, scope]));
  const paths = scopeIds.map((scopeId) => {
    const scope = scopes.get(scopeId);
    if (!scope || scope.status !== 'active') {
      throw Object.assign(new Error('阶段初始化引用未知或不可用的上游 Scope：' + scopeId), { code: 'AIH_SCOPE_INVALID' });
    }
    return readinessPath(scope, project, manifest);
  });
  const resolution = resolveHarness(manifest, project, paths, 'readiness', root);
  if (resolution.status !== 'READY') {
    const first = resolution.blockers[0] || { code: 'AIH_UPSTREAM_NOT_READY', message: '上游 readiness 无法解析。' };
    throw Object.assign(new Error(first.message || first.meaning), { code: first.code });
  }
  const commands = new Map(manifest.commands.map((command) => [command.id, command]));
  for (const commandId of resolution.commandIds) {
    const command = commands.get(commandId);
    if (!command) throw Object.assign(new Error('上游 readiness 引用未知命令：' + commandId), { code: 'AIH_COMMAND_INVALID' });
    const validation = executeRegisteredCommand(root, command);
    if (validation.status !== 'PASS') {
      const evidence = validation.stderr || validation.stdout || '';
      throw Object.assign(new Error('上游 readiness 未通过：' + command.run + (evidence ? '\n' + evidence : '')), {
        code: validation.blockers[0] || 'AIH_UPSTREAM_NOT_READY',
      });
    }
  }
}

try {
  if (!operationId) throw Object.assign(new Error('initialize-stage 必须提供 --operation。'), { code: 'AIH_COMMAND_INVALID' });
  const { project, manifest } = await loadProjectAndManifest(root);
  const operation = manifest.operations.find((item) => item.id === operationId && item.kind === 'stage');
  if (!operation) throw Object.assign(new Error('Manifest 未声明阶段初始化 operation：' + operationId), { code: 'AIH_CONTRACT_INVALID' });
  const stage = project.stages?.[operation.stage];
  if (!stage) throw Object.assign(new Error('项目未绑定阶段：' + operation.stage), { code: 'AIH_PROJECT_BINDING_INVALID' });
  if (stage.status === operation.toState) throw Object.assign(new Error('阶段已经初始化：' + operation.stage), { code: 'AIH_STAGE_ALREADY_INITIALIZED' });
  if (stage.status !== operation.fromState) throw Object.assign(new Error('阶段状态不允许初始化：' + stage.status), { code: 'AIH_PROJECT_BINDING_INVALID' });

  if (operation.upstreamHandoff) {
    const handoff = await executeHandoff(root, operation.upstreamHandoff.from, operation.upstreamHandoff.to);
    if (handoff.status !== 'PASS') {
      const first = handoff.blockers[0] || { code: 'AIH_UPSTREAM_NOT_READY' };
      throw Object.assign(new Error('上游移交门禁未通过：' + first.code), { code: first.code });
    }
  }
  executeUpstreamReadiness(project, manifest, operation.upstreamScopes);

  const copies = [];
  const generatedTargets = [];
  const inputRoots = [];
  for (const registry of manifest.artifactRegistry.filter((item) => item.stage === operation.stage)) {
    const paths = artifactPaths(project, registry.id, registry.stage);
    if (!paths) throw Object.assign(new Error('项目缺少 Artifact 绑定：' + registry.id), { code: 'AIH_PROJECT_BINDING_INVALID' });
    if (registry.authorityKind === 'internal-model') copies.push({ source: registry.template, target: paths.authorityPath });
    if (paths.inputRoot) inputRoots.push(paths.inputRoot);
    generatedTargets.push(...paths.outputPaths);
  }
  for (const [areaId, templateRoot] of Object.entries(operation.areaTemplates || {})) {
    const area = stage.areas?.[areaId];
    if (!area) throw Object.assign(new Error('项目缺少 Area 绑定：' + areaId), { code: 'AIH_PROJECT_BINDING_INVALID' });
    for (const file of await templateFiles(templateRoot)) {
      copies.push({ source: file.source, target: joinRepositoryPath(stage.root, area.root, file.relative) });
    }
  }

  const stageRootExisted = await exists(stage.root);
  if (await stageHasUserFiles(root, stage.root, [workspaceRootMarker(manifest)].filter(Boolean))) {
    throw Object.assign(new Error('目标阶段已有用户文件：' + stage.root), { code: 'AIH_USER_CHANGE_COLLISION' });
  }
  const targets = [...copies.map((item) => item.target), ...inputRoots, ...generatedTargets, 'psp.project.yaml'];
  const duplicate = targets.find((path, index) => targets.indexOf(path) !== index);
  if (duplicate) throw Object.assign(new Error('初始化目标重复：' + duplicate), { code: 'AIH_PROJECT_BINDING_INVALID' });

  if (dryRun) {
    result = { status: 'PASS', mode: 'dry-run', operation: operationId, stage: operation.stage, targets: targets.sort(), blockers: [] };
  } else {
    const created = [];
    try {
      for (const item of copies) {
        const target = repositoryFile(root, item.target);
        await mkdir(dirname(target), { recursive: true });
        await copyFile(repositoryFile(root, item.source), target);
        created.push(item.target);
      }
      for (const inputRoot of inputRoots) {
        await mkdir(repositoryFile(root, inputRoot), { recursive: true });
        created.push(inputRoot);
      }
      const commands = new Map(manifest.commands.map((command) => [command.id, command]));
      for (const commandId of operation.commands || []) {
        const command = commands.get(commandId);
        if (!command) throw Object.assign(new Error('初始化引用未知命令：' + commandId), { code: 'AIH_COMMAND_INVALID' });
        const validation = executeRegisteredCommand(root, command, {
          environment: { AI_HARNESS_INITIALIZING: operation.stage },
        });
        if (validation.status !== 'PASS') {
          const evidence = validation.stderr || validation.stdout || '';
          throw Object.assign(new Error('初始化命令失败：' + command.run + (evidence ? '\n' + evidence : '')), { code: validation.blockers[0] || 'AIH_VALIDATION_FAILED' });
        }
      }
      for (const path of generatedTargets) if (await exists(path)) created.push(path);

      const originalProject = await readFile(repositoryFile(root, 'psp.project.yaml'), 'utf8');
      project.stages[operation.stage].status = operation.toState;
      const temporary = 'psp.project.yaml.init.tmp';
      try {
        await writeFile(repositoryFile(root, temporary), stringifyYaml(project), 'utf8');
        await rename(repositoryFile(root, temporary), repositoryFile(root, 'psp.project.yaml'));
      } catch (error) {
        await rm(repositoryFile(root, temporary), { force: true });
        await writeFile(repositoryFile(root, 'psp.project.yaml'), originalProject, 'utf8');
        throw error;
      }
      result = { status: 'PASS', mode: 'initialize', operation: operationId, stage: operation.stage, outputs: ['psp.project.yaml', ...created].sort(), blockers: [] };
    } catch (error) {
      await rollback([...created, ...generatedTargets], stage.root, stageRootExisted);
      throw error;
    }
  }
} catch (error) {
  result = { status: 'BLOCKED', mode: dryRun ? 'dry-run' : 'initialize', operation: operationId, blockers: [{ code: error.code || 'AIH_VALIDATION_FAILED', message: error.message }] };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] 通用阶段初始化' + (dryRun ? '预检' : '') + '通过。');
else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
if (result.status !== 'PASS') process.exitCode = 1;
