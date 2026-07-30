import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { sha256, stableJson, validateWithSchema } from '../../visual-spec/scripts/lib/visual-spec.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const operation = argument('operation', 'validate');
const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
const staleScenarios = new Set();
let transactionId = null;

try {
  if (!['prepare', 'validate'].includes(operation)) {
    throw Object.assign(new Error('MockCase 只支持 prepare 或 validate。'), { code: 'MOCK_OPERATION_FORBIDDEN' });
  }
  const project = await loadProject(root);
  if (operation === 'validate') {
    const checklistPath = artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath;
    if (checklistPath) {
      const checklist = JSON.parse(await readFile(repositoryFile(root, checklistPath), 'utf8'));
      if (!(checklist.items ?? []).some((item) => item.requiredDeliveryLevel === 'USER_PATH')) {
        console.log(JSON.stringify({ status: 'PASS', operation, required: false, blockers: [], staleScenarios: [] }));
        process.exit(0);
      }
    }
  }
  const planPath = artifactPaths(project, 'user-path-plan', 'user-path-cases')?.authorityPath;
  const suitePath = artifactPaths(project, 'mock-scenario-suite', 'mockcase')?.authorityPath;
  if (!planPath || !suitePath) throw Object.assign(new Error('MockCase Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const planBytes = await readFile(repositoryFile(root, planPath));
  const plan = JSON.parse(planBytes);
  const planValidation = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, '../../user-path-cases/scripts/validate.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
    },
  );
  if (planValidation.status !== 0) {
    throw Object.assign(new Error(planValidation.stdout || planValidation.stderr), {
      code: 'MOCK_SOURCE_NOT_READY',
    });
  }
  blockers.push(...await validateWithSchema(
    root,
    '.agents/skills/user-path-cases/schemas/user-path-plan.schema.json',
    plan,
  ));
  if (plan.metadata?.status !== 'ready' || (plan.gaps ?? []).length) {
    blockers.push({ code: 'MOCK_SOURCE_NOT_READY', message: 'MockCase 只接受 Ready 且无 Gap 的 User Path Plan。' });
  }
  if (new Set((plan.paths ?? []).map((item) => item.pathId)).size !== (plan.paths ?? []).length) {
    blockers.push({ code: 'MOCK_SOURCE_INVALID', message: 'User Path Plan 包含重复 pathId。' });
  }
  if (blockers.length) throw new Error('User Path Plan 未满足 MockCase 输入条件。');
  const requiredSlots = [...new Set((plan.paths ?? []).flatMap((item) => item.scenarioSlots ?? []))].sort();
  if (operation === 'prepare') {
    let previous = null;
    try { previous = JSON.parse(await readFile(repositoryFile(root, suitePath), 'utf8')); } catch { /* initial */ }
    if (
      previous?.pathPlanLock?.revision === plan.metadata.revision
      && previous?.pathPlanLock?.digest !== sha256(planBytes)
    ) {
      throw Object.assign(new Error('Path Plan 相同 revision 对应不同字节。'), {
        code: 'VISUAL_SPEC_SOURCE_REVISION_REUSED',
      });
    }
    const existing = new Map((previous?.scenarios ?? []).map((item) => [item.scenarioId, item]));
    const scenarios = requiredSlots.map((scenarioId) => existing.get(scenarioId) ?? {
      scenarioId,
      status: 'draft',
      fixtures: [],
    });
    const gaps = scenarios.filter((item) => item.status !== 'ready' || !item.fixtures.length).map((item) => ({
      code: item.fixtures.length ? 'MOCK_SCENARIO_MISSING' : 'MOCK_FIXTURE_MISSING',
      scenarioId: item.scenarioId,
      reason: item.fixtures.length ? 'Scenario 尚未 ready' : 'Scenario 尚无 Fixture',
    }));
    const candidate = {
      schemaVersion: 'psp.dev/visual-spec/v1',
      metadata: {
        artifactId: 'MOCK-SCENARIO-SUITE',
        revision: previous?.metadata?.revision ?? 1,
        status: gaps.length ? 'draft' : 'ready',
      },
      pathPlanLock: {
        artifactId: 'USER-PATH-PLAN',
        path: planPath,
        revision: plan.metadata.revision,
        digest: sha256(planBytes),
      },
      scenarios,
      gaps,
    };
    if (previous) {
      const left = structuredClone(previous);
      const right = structuredClone(candidate);
      left.metadata.revision = 1;
      right.metadata.revision = 1;
      if (stableJson(left) !== stableJson(right)) candidate.metadata.revision = previous.metadata.revision + 1;
    }
    blockers.push(...await validateWithSchema(root, '.agents/skills/mockcase/schemas/mock-scenario-suite.schema.json', candidate));
    if (blockers.length) throw new Error('Mock Suite Schema 无效。');
    transactionId = await commitManagedWrites({
      root,
      ownerId: 'mock-scenario-suite',
      writes: [{ target: suitePath, content: stableJson(candidate) }],
    });
  } else {
    const suite = JSON.parse(await readFile(repositoryFile(root, suitePath), 'utf8'));
    blockers.push(...await validateWithSchema(root, '.agents/skills/mockcase/schemas/mock-scenario-suite.schema.json', suite));
    if (suite.metadata?.status !== 'ready') {
      blockers.push({ code: 'MOCK_SOURCE_NOT_READY', message: 'Mock Suite 状态不是 ready。' });
    }
    const lock = suite.pathPlanLock;
    if (lock.path !== planPath) blockers.push({ code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID', message: 'Mock Suite 未锁定正式 Path Plan。' });
    if (lock.revision === plan.metadata.revision && lock.digest !== sha256(planBytes)) {
      blockers.push({ code: 'VISUAL_SPEC_SOURCE_REVISION_REUSED', message: 'Path Plan 相同 revision 对应不同字节。' });
    }
    if (lock.revision !== plan.metadata.revision || lock.digest !== sha256(planBytes)) {
      for (const scenario of suite.scenarios ?? []) staleScenarios.add(scenario.scenarioId);
    }
    const actual = new Map((suite.scenarios ?? []).map((item) => [item.scenarioId, item]));
    if (actual.size !== (suite.scenarios ?? []).length) {
      blockers.push({ code: 'MOCK_SCENARIO_DUPLICATED', message: 'Mock Suite 包含重复 scenarioId。' });
    }
    const fixtureIds = (suite.scenarios ?? []).flatMap((item) => (item.fixtures ?? []).map((fixture) => fixture.fixtureId));
    if (new Set(fixtureIds).size !== fixtureIds.length) {
      blockers.push({ code: 'MOCK_FIXTURE_DUPLICATED', message: 'Mock Suite 包含重复 fixtureId。' });
    }
    for (const slot of requiredSlots) {
      const scenario = actual.get(slot);
      if (!scenario || scenario.status !== 'ready') blockers.push({ code: 'MOCK_SCENARIO_MISSING', message: `场景未 ready：${slot}` });
      else if (!scenario.fixtures.length) blockers.push({ code: 'MOCK_FIXTURE_MISSING', message: `场景无 Fixture：${slot}` });
    }
    for (const scenarioId of actual.keys()) {
      if (!requiredSlots.includes(scenarioId)) blockers.push({ code: 'MOCK_SCOPE_EXPANSION_FORBIDDEN', message: `Mock 擅自扩大 Path Plan：${scenarioId}` });
    }
    if ((suite.gaps ?? []).length) blockers.push({ code: 'MOCK_GAP_OPEN', message: 'Mock Suite 仍有 Gap。' });
  }
} catch (error) {
  if (!blockers.length || error.code) blockers.unshift({ code: error.code || 'MOCK_VALIDATION_FAILED', message: error.message });
}
const status = blockers.length ? 'BLOCKED' : staleScenarios.size ? 'STALE' : 'PASS';
console.log(JSON.stringify({ status, operation, transactionId, blockers, staleScenarios: [...staleScenarios].sort() }));
if (status !== 'PASS') process.exitCode = 1;
