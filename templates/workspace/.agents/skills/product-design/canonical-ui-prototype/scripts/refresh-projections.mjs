import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitManagedWrites } from '../../../../runtime/artifact-transaction.mjs';
import {
  actorPartition,
  artifactDefinition,
  artifactPaths,
  loadProject,
  repositoryRootFrom,
} from '../../../../runtime/project.mjs';
import { canonicalExpectedOutputs } from './project.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

export async function refreshCanonicalUiProjections(rootDirectory, options = {}) {
  const operationId = options.operationId || 'refresh-canonical-ui-projections';
  const dryRun = options.dryRun === true;
  const project = await loadProject(rootDirectory);
  if (operationId !== 'refresh-canonical-ui-projections') {
    fail('AIH_CONTRACT_INVALID', 'Canonical UI 不支持该投影刷新动作：' + operationId);
  }
  const operation = {
    id: operationId,
    stage: 'product-design',
    artifact: 'canonical-ui-prototype',
    outputRole: 'generated-support',
  };

  const stage = project.stages?.[operation.stage];
  if (stage?.status === 'published') fail('AIH_STAGE_LOCKED', '阶段已经发布并锁定；请先执行 Reopen：' + operation.stage);
  if (stage?.status !== 'active') fail('AIH_STAGE_UNINITIALIZED', '阶段尚未初始化，不能刷新投影：' + operation.stage);

  const registry = artifactDefinition(project, operation.artifact, operation.stage);
  const paths = artifactPaths(project, operation.artifact, operation.stage);
  const bindings = (paths?.memberOutputs || []).filter((item) => item.role === operation.outputRole);
  if (
    !registry
    || registry.authorityKind !== 'area-set'
    || paths?.authorityKind !== 'area-set'
    || bindings.length === 0
  ) {
    fail('AIH_PROJECT_BINDING_INVALID', 'Canonical UI 投影刷新缺少 Area Set 或 generated-support 项目绑定。');
  }

  const expected = (await canonicalExpectedOutputs(rootDirectory, project))
    .filter((item) => item.role === operation.outputRole);
  for (const output of expected) {
    if (!actorPartition(output.actor)) fail('AIH_PROJECT_BINDING_INVALID', '投影缺少合法 ACTOR-NNN 分区：' + output.output);
    const allowed = bindings.some((binding) => (
      output.output === binding.root + '/' + output.actor + '/' + binding.member
    ));
    if (!allowed) fail('AIH_PATH_OUTSIDE_ROOT', 'Projector 返回未登记的 generated-support 路径：' + output.output);
  }

  const writes = expected.map((item) => ({ target: item.output, content: item.content }));
  if (dryRun || writes.length === 0) {
    return {
      status: 'PASS',
      mode: 'dry-run',
      operation: operation.id,
      artifact: operation.artifact,
      authority: [...new Set(expected.map((item) => item.authorityPath))],
      targets: writes.map((item) => item.target),
      blockers: [],
    };
  }

  const transactionId = await commitManagedWrites({
    root: rootDirectory,
    ownerId: operation.artifact,
    writes,
  });
  return {
    status: 'PASS',
    mode: 'commit',
    operation: operation.id,
    artifact: operation.artifact,
    transactionId,
    authority: [...new Set(expected.map((item) => item.authorityPath))],
    outputs: expected.map((item) => ({ output: item.output, role: item.role })),
    blockers: [],
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  let result;
  try {
    result = await refreshCanonicalUiProjections(root, {
      operationId: argument('operation'),
      dryRun,
    });
  } catch (error) {
    result = {
      status: 'BLOCKED',
      mode: dryRun ? 'dry-run' : 'commit',
      operation: argument('operation'),
      artifact: 'canonical-ui-prototype',
      blockers: [{
        code: error.code || 'AIH_ARTIFACT_TRANSACTION_FAILED',
        message: error.message,
      }],
    };
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'PASS') console.log('[PASS] Canonical UI generated-support 投影' + (dryRun ? '预检' : '刷新') + '完成。');
  else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
  if (result.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
