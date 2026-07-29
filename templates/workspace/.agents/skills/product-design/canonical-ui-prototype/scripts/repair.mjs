import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import {
  artifactCollectionMembers,
  artifactDefinition,
  artifactMemberPath,
  artifactPaths,
  loadProject,
  repositoryFile,
  repositoryRootFrom,
} from '../../../../runtime/project.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const actorIndex = process.argv.indexOf('--actor');
const requestedActor = actorIndex >= 0 ? process.argv[actorIndex + 1] : null;
const sessionIndex = process.argv.indexOf('--session');
const requestedSession = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : null;
const newSession = process.argv.includes('--new-session');
const REPAIR_ACTION = {
  prerequisiteCommands: ['canonical-ui-input'],
  repairCommands: ['canonical-ui-runtime', 'canonical-ui-contract-tests'],
};
const REPAIR_CHECKS = {
  'canonical-ui-input': {
    path: '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs',
    args: [],
  },
  'canonical-ui-runtime': {
    path: '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs',
    args: [],
  },
  'canonical-ui-contract-tests': {
    path: '.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs',
    args: [],
  },
};

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

async function loadRepairContract(project) {
  const artifact = artifactDefinition(project, 'canonical-ui-prototype', 'product-design');
  if (!artifact?.contract) fail('AIH_CONTRACT_INVALID', 'Canonical UI Prototype 未登记 Artifact Contract。');
  const contract = parseYaml(await readFile(repositoryFile(root, artifact.contract), 'utf8'));
  const repair = contract?.spec?.repair;
  if (
    repair?.mode !== 'agent-single-attempt'
    || repair?.maxAttempts !== 1
    || !repair.packetSchema
    || !repair.actionReportSchema
    || !repair.implementationPolicy
  ) {
    fail('AIH_CONTRACT_INVALID', 'Canonical UI Artifact Contract 缺少单次 Agent 修复契约。');
  }
  return repair;
}

function parseGateOutput(execution, commandId) {
  const stdout = execution.stdout?.trim() || '';
  try {
    return { gateId: commandId, ...JSON.parse(stdout) };
  } catch {
    return {
      gateId: commandId,
      status: 'BLOCKED',
      blockers: [{
        code: 'AIH_VALIDATION_FAILED',
        message: '无法解析 ' + commandId + ' 的结构化输出。',
        detail: execution.stderr?.trim() || stdout,
      }],
      evidence: [],
    };
  }
}

function runGate(commandId, actor) {
  const command = REPAIR_CHECKS[commandId];
  if (!command) {
    return {
      gateId: commandId,
      status: 'BLOCKED',
      blockers: [{ code: 'AIH_COMMAND_INVALID', message: '修复操作引用未知模块命令：' + commandId }],
      evidence: [],
    };
  }
  const execution = spawnSync(
    process.execPath,
    [repositoryFile(root, command.path), ...command.args, '--actor', actor, '--json'],
    {
      cwd: root,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 600_000,
    },
  );
  return parseGateOutput(execution, commandId);
}

function runGates(commandIds, actor) {
  return commandIds.map((commandId) => runGate(commandId, actor));
}

function blockersFrom(gates) {
  return gates.flatMap((gate) => (gate.blockers || []).map((blocker) => ({ gateId: gate.gateId, ...blocker })));
}

function repairFailures(gates) {
  const failures = new Map();
  for (const gate of gates) {
    for (const item of gate.evidence || []) {
      if (item.kind !== 'repair-diagnostic' || item.gateId !== gate.gateId) continue;
      const { kind: _kind, actor: _actor, ...failure } = item;
      failures.set(failure.diagnosticId, failure);
    }
  }
  return [...failures.values()];
}

function uncoveredBlockers(gates, failures) {
  const diagnosticIds = new Set(failures.map((item) => item.diagnosticId));
  return blockersFrom(gates).filter((blocker) => !blocker.diagnosticId || !diagnosticIds.has(blocker.diagnosticId));
}

async function schema(path) {
  return JSON.parse(await readFile(repositoryFile(root, path), 'utf8'));
}

async function writePacket(path, packet, packetSchemaPath) {
  const packetSchema = await schema(packetSchemaPath);
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(packetSchema);
  if (!validate(packet)) {
    fail('AIH_UI_REPAIR_PACKET_FAILED', 'Repair Packet 不符合 Schema：' + JSON.stringify(validate.errors));
  }
  await writeFile(path, JSON.stringify(packet, null, 2) + '\n', 'utf8');
}

async function writeReport(path, report, repair) {
  const packetSchema = await schema(repair.packetSchema);
  const reportSchema = await schema(repair.actionReportSchema);
  const ajv = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } });
  ajv.addSchema(packetSchema);
  const validate = ajv.compile(reportSchema);
  if (!validate(report)) {
    fail('AIH_UI_REPAIR_PACKET_FAILED', 'Repair Action Report 不符合 Schema：' + JSON.stringify(validate.errors));
  }
  await writeFile(path, JSON.stringify(report, null, 2) + '\n', 'utf8');
}

function emit(result, code = null) {
  if (json || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
  else console.log('[PASS] Canonical UI 单次修复门禁通过。');
  if (code) console.error('[' + code + '] ' + (result.message || result.status));
}

async function main() {
  const project = await loadProject(root);
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const stage = project.stages?.['product-design'];
  if (stage?.status === 'published') fail('AIH_STAGE_LOCKED', '产品设计阶段已经发布并锁定；Repair 前必须先执行 Reopen。');
  if (stage?.status !== 'active' || !paths?.area) fail('AIH_STAGE_UNINITIALIZED', '产品设计阶段或 Canonical UI Prototype Area 尚未激活。');
  if ((newSession && requestedSession) || (!newSession && !requestedSession)) {
    fail('AIH_UI_REPAIR_SESSION_INVALID', '首次运行必须传 --new-session；修复后重跑必须传 --session <repairSessionId>。');
  }

  const members = await artifactCollectionMembers(root, paths);
  const actor = requestedActor || (members.length === 1 ? members[0].actor : null);
  if (!actor) fail('AIH_COMMAND_INVALID', 'Canonical UI 修复必须用 --actor ACTOR-NNN 指定一个独立应用。');

  const authorityPath = artifactMemberPath(paths, actor);
  const model = await extractCanonicalUi(root, authorityPath);
  const repair = await loadRepairContract(project);
  if (!repair.allowedVisualModes.includes(model.visualPolicy.mode)) {
    fail('AIH_VISUAL_POLICY_UNRESOLVED', 'Canonical UI 修复只支持 autonomous、guided 或 exact 已解析模式。');
  }
  const operation = REPAIR_ACTION;

  const rootKey = Buffer.from(root + ':' + actor).toString('base64url');
  const sessionRoot = resolve(tmpdir(), 'psp-canonical-ui-repair-' + rootKey);
  const statePath = resolve(sessionRoot, 'state.json');
  const packetPath = resolve(sessionRoot, 'repair-packet.json');
  const reportPath = resolve(sessionRoot, 'repair-action-report.json');
  if (newSession) await rm(sessionRoot, { recursive: true, force: true });
  await mkdir(sessionRoot, { recursive: true });

  const state = await readState(statePath);
  if (requestedSession && (
    !state
    || state.status !== 'REPAIR_REQUIRED'
    || state.repairSessionId !== requestedSession
    || state.actor !== actor
  )) {
    fail('AIH_UI_REPAIR_SESSION_INVALID', 'Repair Session 缺失、过期、已终止或与当前 Actor 不一致。');
  }

  const prerequisites = runGates(operation.prerequisiteCommands, actor);
  const prerequisiteBlockers = blockersFrom(prerequisites);
  if (prerequisiteBlockers.length > 0 || prerequisites.some((gate) => gate.status !== 'PASS')) {
    const code = prerequisiteBlockers[0]?.code || 'AIH_VALIDATION_FAILED';
    emit({ status: 'BLOCKED', blockers: prerequisiteBlockers }, code);
    return 1;
  }

  const gates = runGates(operation.repairCommands, actor);
  const allPass = gates.every((gate) => gate.status === 'PASS');
  if (allPass) {
    if (requestedSession) {
      const report = {
        version: '2.0.0',
        status: 'PASS',
        actor,
        repairSessionId: requestedSession,
        completedAt: new Date().toISOString(),
        attempts: 1,
        resolvedFailures: state.failures,
        validationGates: gates.map((gate) => ({
          gateId: gate.gateId,
          status: 'PASS',
          evidence: gate.evidence || [],
        })),
      };
      await writeReport(reportPath, report, repair);
      await Promise.all([rm(statePath, { force: true }), rm(packetPath, { force: true })]);
      emit({ status: 'PASS', attempts: 1, repairSessionId: requestedSession, repairActionReport: reportPath });
    } else {
      await rm(sessionRoot, { recursive: true, force: true });
      emit({ status: 'PASS', attempts: 0 });
    }
    return 0;
  }

  const failures = repairFailures(gates);
  const uncovered = uncoveredBlockers(gates, failures);
  if (newSession && (failures.length === 0 || uncovered.length > 0)) {
    await rm(sessionRoot, { recursive: true, force: true });
    emit({
      status: 'BLOCKED',
      message: '统一门禁包含不可修复失败或缺少完整 Repair Diagnostic。',
      blockers: blockersFrom(gates),
      uncoveredBlockers: uncovered,
    }, uncovered[0]?.code || 'AIH_UI_REPAIR_PACKET_FAILED');
    return 1;
  }

  if (requestedSession) {
    const terminal = { ...state, status: 'BLOCKED', completedAt: new Date().toISOString() };
    await writeFile(statePath, JSON.stringify(terminal, null, 2) + '\n', 'utf8');
    if (failures.length > 0 && uncovered.length === 0) {
      const packet = {
        version: '5.0.0',
        status: 'BLOCKED',
        workspaceRoot: root,
        actor,
        repairSessionId: requestedSession,
        attempt: 1,
        maxAttempts: 1,
        allowedImplementationPaths: model.repairPolicy.allowedImplementationPaths,
        implementationPolicy: repair.implementationPolicy,
        failures,
        attempts: [{ attempt: 1, failures: state.failures }],
      };
      await writePacket(packetPath, packet, repair.packetSchema);
    }
    emit({
      status: 'BLOCKED',
      message: 'Canonical UI 单次 Agent 实现修复后仍未通过统一门禁。',
      repairSessionId: requestedSession,
      ...(failures.length > 0 && uncovered.length === 0 ? { repairPacket: packetPath } : {}),
      blockers: blockersFrom(gates),
    }, 'AIH_UI_REPAIR_EXHAUSTED');
    return 1;
  }

  const repairSessionId = randomUUID();
  const nextState = {
    version: '1.0.0',
    status: 'REPAIR_REQUIRED',
    actor,
    repairSessionId,
    failures,
    createdAt: new Date().toISOString(),
  };
  const packet = {
    version: '5.0.0',
    status: 'REPAIR_REQUIRED',
    workspaceRoot: root,
    actor,
    repairSessionId,
    attempt: 1,
    maxAttempts: 1,
    allowedImplementationPaths: model.repairPolicy.allowedImplementationPaths,
    implementationPolicy: repair.implementationPolicy,
    failures,
    attempts: [],
  };
  await writeFile(statePath, JSON.stringify(nextState, null, 2) + '\n', 'utf8');
  await writePacket(packetPath, packet, repair.packetSchema);
  emit({
    status: 'REPAIR_REQUIRED',
    message: '读取 Repair Packet，执行一次实现修复后使用 --session 重新运行 canonical-ui-repair。',
    attempt: 1,
    repairSessionId,
    repairPacket: packetPath,
    failures,
  }, 'AIH_UI_REPAIR_REQUIRED');
  return 1;
}

let status = 1;
try {
  status = await main();
} catch (error) {
  emit({
    status: 'BLOCKED',
    message: error.message,
    blockers: [{ code: error.code || 'AIH_VALIDATION_FAILED', message: error.message }],
  }, error.code || 'AIH_VALIDATION_FAILED');
  status = 1;
}
process.exitCode = status;
