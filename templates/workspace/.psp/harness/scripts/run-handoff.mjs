import { loadProjectAndManifest, repositoryRootFrom } from './lib/repository.mjs';
import { executeRegisteredCommand } from './lib/execute-command.mjs';
import { collectDependencyIds, dagNodes, handoffEdge } from './lib/project-dag.mjs';
import { stageIsReadable } from './lib/stage-state.mjs';
import { pathToFileURL } from 'node:url';

const root = repositoryRootFrom(import.meta.dirname);

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function scopeStage(scope) {
  return ['static', 'workspace', 'domain'].includes(scope?.selector?.type)
    ? null
    : scope?.selector?.stage;
}

function receiptFailure(from, to, profile, code, message) {
  return {
    status: 'FAIL',
    from,
    to,
    profile,
    validation: [],
    blockers: [{ code, message }],
    downstreamAction: 'NOT_RUN',
  };
}

export async function executeHandoff(rootDirectory, from, to, options = {}) {
  const { project, manifest } = await loadProjectAndManifest(rootDirectory);
  const scopes = new Map(manifest.scopes.map((scope) => [scope.id, scope]));
  const nodes = dagNodes(manifest);
  const profiles = new Map(manifest.validationProfiles.map((profile) => [profile.id, profile]));
  const source = scopes.get(from);
  const consumer = scopes.get(to);
  const profile = source?.readinessProfile || null;

  if (!nodes.has(from) || !nodes.has(to) || !source || !consumer) {
    return receiptFailure(from, to, profile, 'AIH_DAG_NODE_UNKNOWN', 'handoff 来源或目标不是项目 DAG 中的已知节点。');
  }
  if (!handoffEdge(manifest, from, to)) {
    return receiptFailure(from, to, profile, 'AIH_HANDOFF_UNREACHABLE', '项目 DAG 未声明从来源到目标的显式 handoff 边。');
  }

  const scopeIds = [...collectDependencyIds(manifest, from), from];
  const profileIds = [];
  for (const scopeId of scopeIds) {
    const scope = scopes.get(scopeId);
    if (!scope) {
      return receiptFailure(from, to, profile, 'AIH_DAG_NODE_UNKNOWN', '项目 DAG 依赖节点未绑定 Scope：' + scopeId);
    }
    if (!profileIds.includes(scope.readinessProfile)) profileIds.push(scope.readinessProfile);
  }

  for (const scopeId of scopeIds) {
    const scope = scopes.get(scopeId);
    const stageId = scopeStage(scope);
    if (scope.status !== 'active') {
      return receiptFailure(from, to, profile, scope.blockerCode || 'AIH_UPSTREAM_NOT_READY', 'Scope 不可消费：' + scopeId);
    }
    if (stageId && !stageIsReadable(project.stages?.[stageId])) {
      return receiptFailure(from, to, profile, 'AIH_STAGE_UNINITIALIZED', '移交来源或上游阶段尚未 active 或 published：' + stageId);
    }
  }

  const commandIds = new Set();
  for (const profileId of profileIds) {
    const selectedProfile = profiles.get(profileId);
    if (!selectedProfile) {
      return receiptFailure(from, to, profile, 'AIH_PROFILE_INVALID', '移交引用未知 Profile：' + profileId);
    }
    for (const commandId of selectedProfile.commands) commandIds.add(commandId);
  }
  const selectedCommands = manifest.commands.filter((command) => commandIds.has(command.id));
  const validation = [];
  let failed = false;
  for (const command of selectedCommands) {
    if (failed) {
      validation.push({
        id: command.id,
        command: command.run,
        status: 'NOT_RUN',
        blockers: [],
      });
      continue;
    }
    const item = executeRegisteredCommand(rootDirectory, command, options);
    validation.push(item);
    if (item.status === 'FAIL') failed = true;
  }

  return {
    status: failed ? 'FAIL' : 'PASS',
    from,
    to,
    profile,
    validation,
    blockers: validation.flatMap((item) => item.blockers || []).map((code) => ({ code })),
    downstreamAction: 'NOT_RUN',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const from = argument('from');
  const to = argument('to');
  let result;
  try {
    if (!from || !to) throw Object.assign(new Error('handoff 必须同时提供 --from 与 --to。'), { code: 'AIH_COMMAND_INVALID' });
    result = await executeHandoff(root, from, to);
  } catch (error) {
    result = receiptFailure(from, to, null, error.code || 'AIH_VALIDATION_FAILED', error.message);
  }

  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'PASS') console.log('[PASS] 移交门禁已实际执行；未启动下游。');
  else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + (blocker.message || '移交失败'));
  if (result.status !== 'PASS') process.exitCode = 1;
}
