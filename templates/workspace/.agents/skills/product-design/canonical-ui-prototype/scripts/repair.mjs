import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import {
  artifactCollectionMembers,
  artifactMemberPath,
  artifactPaths,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const actorIndex = process.argv.indexOf('--actor');
const requestedActor = actorIndex >= 0 ? process.argv[actorIndex + 1] : null;

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function loadRepairContract(manifest) {
  const artifact = manifest.artifactRegistry?.find((item) => item.id === 'canonical-ui-prototype');
  if (!artifact?.contract) {
    const error = new Error('Canonical UI Prototype 未登记 Artifact Contract。');
    error.code = 'AIH_CONTRACT_INVALID';
    throw error;
  }
  const contract = parseYaml(await readFile(repositoryFile(root, artifact.contract), 'utf8'));
  const implementationPolicy = contract?.spec?.repair?.implementationPolicy;
  const packetSchemaPath = contract?.spec?.repair?.packetSchema;
  if (!implementationPolicy || !packetSchemaPath) {
    const error = new Error('Canonical UI Artifact Contract 缺少视觉修复实现策略或 Packet Schema。');
    error.code = 'AIH_CONTRACT_INVALID';
    throw error;
  }
  return {
    packetSchemaPath,
    implementationPolicy,
  };
}

function parseGateOutput(execution, commandId) {
  const stdout = execution.stdout?.trim() || '';
  try {
    return JSON.parse(stdout);
  } catch {
    return {
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

function runGate(manifest, commandId, actor) {
  const command = manifest.commands.find((item) => item.id === commandId);
  if (!command || command.executor?.kind !== 'module') {
    return {
      status: 'BLOCKED',
      blockers: [{ code: 'AIH_COMMAND_INVALID', message: '修复操作引用未知模块命令：' + commandId }],
      evidence: [],
    };
  }
  const execution = spawnSync(
    process.execPath,
    [repositoryFile(root, command.executor.path), ...(command.executor.args || []), '--actor', actor, '--json'],
    {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180_000,
    },
  );
  return parseGateOutput(execution, commandId);
}

function repairFailures(runtime, repairableCodes) {
  const allowed = new Set(repairableCodes);
  return (runtime.evidence || [])
    .filter((item) => item.kind === 'source-parity-failure' && allowed.has(item.blockerCode))
    .map((item) => ({
      blockerCode: item.blockerCode,
      assertionId: item.assertionId,
      sourceId: item.sourceId,
      sourceKind: item.sourceKind,
      sourceEvidenceItemIds: item.sourceEvidenceItemIds,
      ...(item.designContextEvidenceItemId ? { designContextEvidenceItemId: item.designContextEvidenceItemId } : {}),
      ...(item.designContext ? { designContext: item.designContext } : {}),
      ...(item.baselineEvidenceItemId ? { baselineEvidenceItemId: item.baselineEvidenceItemId } : {}),
      checkKind: item.checkKind,
      ...(item.targetId ? { targetId: item.targetId } : {}),
      ...(item.styleProperty ? { styleProperty: item.styleProperty } : {}),
      routeId: item.routeId,
      viewportId: item.viewportId,
      ...(item.scenarioId ? { scenarioId: item.scenarioId } : {}),
      ...(typeof item.differenceRatio === 'number' ? { differenceRatio: item.differenceRatio } : {}),
      ...(Array.isArray(item.differenceRegions) ? { differenceRegions: item.differenceRegions } : {}),
      ...(typeof item.expectedStyle === 'string' ? { expectedStyle: item.expectedStyle } : {}),
      ...(typeof item.actualStyle === 'string' ? { actualStyle: item.actualStyle } : {}),
      message: item.message,
      ...(item.sourceBaseline ? { sourceBaseline: item.sourceBaseline } : {}),
      actualScreenshot: item.actualScreenshot,
      ...(item.differenceScreenshot ? { differenceScreenshot: item.differenceScreenshot } : {}),
    }));
}

async function writePacket(path, packet) {
  const schema = JSON.parse(await readFile(repositoryFile(
    root,
    '.agents/skills/product-design/canonical-ui-prototype/repair-packet.schema.json',
  ), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (!validate(packet)) {
    const error = new Error('Repair Packet 不符合 Schema：' + JSON.stringify(validate.errors));
    error.code = 'AIH_VISUAL_REPAIR_PACKET_FAILED';
    throw error;
  }
  await writeFile(path, JSON.stringify(packet, null, 2) + '\n', 'utf8');
}

function emit(result, code = null) {
  if (json || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
  else console.log('[PASS] Canonical UI Prototype 视觉修复门禁通过。');
  if (code) console.error('[' + code + '] ' + (result.message || result.status));
}

async function main() {
  const { project, manifest } = await loadProjectAndManifest(root);
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const stage = project.stages?.['product-design'];
  if (stage?.status === 'published') {
    const error = new Error('产品设计阶段已经发布并锁定；Repair 前必须先执行 Reopen。');
    error.code = 'AIH_STAGE_LOCKED';
    throw error;
  }
  if (stage?.status !== 'active' || !paths?.area) {
    const error = new Error('产品设计阶段或 Canonical UI Prototype Area 尚未激活。');
    error.code = 'AIH_STAGE_UNINITIALIZED';
    throw error;
  }
  const members = await artifactCollectionMembers(root, paths);
  const actor = requestedActor || (members.length === 1 ? members[0].actor : null);
  if (!actor) {
    const error = new Error('视觉修复必须用 --actor ACTOR-NNN 指定一个独立应用。');
    error.code = 'AIH_COMMAND_INVALID';
    throw error;
  }
  const authorityPath = artifactMemberPath(paths, actor);
  const model = await extractCanonicalUi(root, authorityPath);
  const {
    implementationPolicy,
  } = await loadRepairContract(manifest);
  const sessionId = Buffer.from(root + ':' + actor).toString('base64url');
  const sessionRoot = resolve(tmpdir(), 'psp-canonical-ui-repair-' + sessionId);
  const statePath = resolve(sessionRoot, 'state.json');
  const packetPath = resolve(sessionRoot, 'repair-packet.json');
  await mkdir(sessionRoot, { recursive: true });

  let state = await readState(statePath);

  const input = runGate(manifest, 'canonical-ui-input', actor);
  if (input.status !== 'PASS') {
    if (state) await rm(sessionRoot, { recursive: true, force: true });
    const code = input.blockers?.[0]?.code || 'AIH_VALIDATION_FAILED';
    emit({ status: 'BLOCKED', blockers: input.blockers || [] }, code);
    return 1;
  }

  const runtime = runGate(manifest, 'canonical-ui-runtime', actor);
  if (runtime.status === 'PASS') {
    const attemptHistory = state
      ? [...state.attempts, {
          attempt: state.attempts.length + 1,
          failures: state.lastFailures,
        }]
      : [];
    await rm(sessionRoot, { recursive: true, force: true });
    emit({ status: 'PASS', attempts: attemptHistory.length, attemptHistory });
    return 0;
  }

  const blockerCodes = new Set((runtime.blockers || []).map((item) => item.code));
  const repairable = new Set(model.repairPolicy.repairableBlockerCodes);
  const containsNonRepairable = [...blockerCodes].some((code) => !repairable.has(code));
  if (
    model.visualPolicy.mode !== 'exact'
    || model.repairPolicy.enabled !== true
    || containsNonRepairable
  ) {
    if (state) await rm(sessionRoot, { recursive: true, force: true });
    const code = runtime.blockers?.[0]?.code || 'AIH_VALIDATION_FAILED';
    emit({ status: 'BLOCKED', blockers: runtime.blockers || [], evidence: runtime.evidence || [] }, code);
    return 1;
  }

  const failures = repairFailures(runtime, model.repairPolicy.repairableBlockerCodes);
  if (failures.length === 0) {
    emit({
      status: 'BLOCKED',
      message: '可修复视觉失败没有生成可执行差异证据。',
      blockers: runtime.blockers || [],
    }, 'AIH_VISUAL_REPAIR_PACKET_FAILED');
    return 1;
  }

  if (!state) {
    state = {
      attempts: [],
      lastFailures: failures,
    };
  } else {
    state.attempts.push({
      attempt: state.attempts.length + 1,
      failures: state.lastFailures,
    });
    state.lastFailures = failures;
  }

  const exhausted = state.attempts.length >= model.repairPolicy.maxAttempts;
  const nextAttempt = exhausted
    ? model.repairPolicy.maxAttempts
    : state.attempts.length + 1;
  const packet = {
    version: '4.0.0',
    status: exhausted ? 'BLOCKED' : 'REPAIR_REQUIRED',
    workspaceRoot: root,
    attempt: nextAttempt,
    maxAttempts: model.repairPolicy.maxAttempts,
    repairableBlockerCodes: model.repairPolicy.repairableBlockerCodes,
    allowedImplementationPaths: model.repairPolicy.allowedImplementationPaths,
    implementationPolicy,
    failures,
    attempts: state.attempts,
  };
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await writePacket(packetPath, packet);

  if (exhausted) {
    emit({
      status: 'BLOCKED',
      message: 'Canonical UI Prototype 连续 3 次实现修复后仍未通过视觉验收。',
      repairPacket: packetPath,
      attempts: state.attempts,
    }, 'AIH_VISUAL_REPAIR_EXHAUSTED');
    return 1;
  }
  emit({
    status: 'REPAIR_REQUIRED',
    message: '读取 Repair Packet，修复实现后重新运行 canonical-ui-repair；代码修改不需要 hash 或 Action Report 前置许可。',
    attempt: nextAttempt,
    repairPacket: packetPath,
    failures,
  }, 'AIH_VISUAL_REPAIR_REQUIRED');
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
