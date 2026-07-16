import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import picomatch from 'picomatch';
import { parse as parseYaml } from 'yaml';
import {
  artifactPaths,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function repositoryPath(path) {
  return relative(root, path).split(sep).join('/');
}

function semanticFacts(model) {
  return {
    routes: model.routes,
    screens: model.screens,
    components: model.components,
    componentInventory: model.componentInventory,
    componentMappings: model.componentMappings,
    componentVariantCoverage: model.componentVariantCoverage,
    controls: model.controls,
    states: model.states,
    events: model.events,
    actions: model.actions,
    scenarios: model.scenarios,
    mockBehaviors: model.mockBehaviors,
    traceability: model.traceability,
    gaps: model.gaps,
  };
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

async function readState(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function walk(directory, visit, relativePath = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const nextRelative = relativePath ? relativePath + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === '.vite') continue;
      await walk(resolve(directory, entry.name), visit, nextRelative);
    } else if (entry.isFile()) {
      await visit(resolve(directory, entry.name), nextRelative);
    }
  }
}

async function areaSnapshots(areaPath, allowedPatterns) {
  const allowed = {};
  const protectedFiles = {};
  const isAllowed = picomatch(allowedPatterns, { dot: true });
  await walk(areaPath, async (path, relativePath) => {
    const target = isAllowed(relativePath) ? allowed : protectedFiles;
    target[repositoryPath(path)] = await hashFile(path);
  });
  return { allowed, protectedFiles };
}

async function upstreamProtectedFiles(project, policyPaths) {
  const result = {};
  for (const artifactId of ['capabilities', 'interactions']) {
    const paths = artifactPaths(project, artifactId, 'product-design');
    if (!paths) continue;
    for (const path of [paths.authorityPath, ...paths.outputPaths]) {
      const absolute = repositoryFile(root, path);
      result[path] = await hashFile(absolute);
    }
  }
  for (const path of policyPaths) result[path] = await hashFile(repositoryFile(root, path));
  return result;
}

async function protectedSnapshot(project, model, areaPath, policyPaths) {
  const area = await areaSnapshots(areaPath, model.repairPolicy.allowedImplementationPaths);
  return {
    hashes: {
      businessSemantics: sha256(JSON.stringify(semanticFacts(model))),
      visualPolicy: sha256(JSON.stringify(model.visualPolicy)),
      repairPolicy: sha256(JSON.stringify(model.repairPolicy)),
      protectedFiles: {
        ...area.protectedFiles,
        ...await upstreamProtectedFiles(project, policyPaths),
      },
    },
    allowedFiles: area.allowed,
  };
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
  const actionSchemaPath = contract?.spec?.repair?.actionSchema;
  if (!implementationPolicy || !packetSchemaPath || !actionSchemaPath) {
    const error = new Error('Canonical UI Artifact Contract 缺少视觉修复实现策略、Packet Schema 或 Action Schema。');
    error.code = 'AIH_CONTRACT_INVALID';
    throw error;
  }
  return {
    contractPath: artifact.contract,
    packetSchemaPath,
    actionSchemaPath,
    implementationPolicy,
  };
}

function changedEntries(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => before[key] !== after[key]).sort();
}

function protectedChanges(before, after) {
  const changes = [];
  for (const key of ['businessSemantics', 'visualPolicy', 'repairPolicy']) {
    if (before[key] !== after[key]) changes.push(key);
  }
  changes.push(...changedEntries(before.protectedFiles, after.protectedFiles));
  return changes;
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

function runGate(manifest, commandId) {
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
    [repositoryFile(root, command.executor.path), ...(command.executor.args || []), '--json'],
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

function actionError(message) {
  const error = new Error(message);
  error.code = 'AIH_VISUAL_REPAIR_ACTION_INVALID';
  return error;
}

async function readActionReport(path, schemaPath, expectedAttempt, implementationChanges, previousFailures) {
  const report = await readState(path);
  if (!report) throw actionError('实现文件已改变，但缺少 Repair Action Report：' + path);
  const schema = JSON.parse(await readFile(repositoryFile(root, schemaPath), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  if (!validate(report)) {
    throw actionError('Repair Action Report 不符合 Schema：' + JSON.stringify(validate.errors));
  }
  if (report.attempt !== expectedAttempt) {
    throw actionError('Repair Action Report attempt 与当前修复轮次不一致。');
  }

  const actualPaths = new Set(implementationChanges);
  const reportedPaths = new Set(report.actions.flatMap((action) => action.modifiedPaths));
  const missingPaths = implementationChanges.filter((path) => !reportedPaths.has(path));
  const extraPaths = [...reportedPaths].filter((path) => !actualPaths.has(path));
  if (missingPaths.length > 0 || extraPaths.length > 0) {
    throw actionError('Repair Action Report 修改路径与实际变更不一致：missing=' + missingPaths.join(',') + '; extra=' + extraPaths.join(','));
  }

  const failuresByAssertion = new Map();
  const knownEvidenceItemIds = new Set();
  for (const failure of previousFailures) {
    if (!failuresByAssertion.has(failure.assertionId)) failuresByAssertion.set(failure.assertionId, []);
    failuresByAssertion.get(failure.assertionId).push(failure);
    for (const evidenceItemId of failure.sourceEvidenceItemIds) knownEvidenceItemIds.add(evidenceItemId);
  }
  for (const evidenceItemId of report.sourceResolution.sourceEvidenceItemIds) {
    if (!knownEvidenceItemIds.has(evidenceItemId)) {
      throw actionError('Source Resolution 引用未知来源证据：' + evidenceItemId);
    }
  }
  const coveredAssertions = new Set();
  for (const action of report.actions) {
    for (const assertionId of action.failureAssertionIds) {
      const failures = failuresByAssertion.get(assertionId);
      if (!failures) throw actionError('Repair Action 引用未知失败断言：' + assertionId);
      coveredAssertions.add(assertionId);
      for (const failure of failures) {
        if (failure.sourceId !== action.sourceId) {
          throw actionError('Repair Action 的 sourceId 与失败断言不一致：' + assertionId);
        }
        for (const evidenceItemId of failure.sourceEvidenceItemIds) {
          if (!action.sourceEvidenceItemIds.includes(evidenceItemId)) {
            throw actionError('Repair Action 缺少失败断言要求的来源证据：' + evidenceItemId);
          }
        }
      }
    }
  }
  const uncovered = [...failuresByAssertion.keys()].filter((assertionId) => !coveredAssertions.has(assertionId));
  if (uncovered.length > 0) throw actionError('Repair Action Report 未覆盖失败断言：' + uncovered.join(', '));
  return report;
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
  if (stage?.status !== 'active' || !paths?.area) {
    const error = new Error('产品设计阶段或 Canonical UI Prototype Area 尚未激活。');
    error.code = 'AIH_STAGE_UNINITIALIZED';
    throw error;
  }
  const model = await extractCanonicalUi(root, paths.authorityPath);
  const {
    contractPath,
    packetSchemaPath,
    actionSchemaPath,
    implementationPolicy,
  } = await loadRepairContract(manifest);
  const areaPath = repositoryFile(root, stage.root + '/' + stage.areas[paths.area].root);
  const sessionId = createHash('sha256').update(root).digest('hex').slice(0, 20);
  const sessionRoot = resolve(tmpdir(), 'psp-canonical-ui-repair-' + sessionId);
  const statePath = resolve(sessionRoot, 'state.json');
  const packetPath = resolve(sessionRoot, 'repair-packet.json');
  const actionReportPath = resolve(sessionRoot, 'repair-action.json');
  await mkdir(sessionRoot, { recursive: true });

  const snapshot = await protectedSnapshot(project, model, areaPath, [contractPath, packetSchemaPath, actionSchemaPath]);
  let state = await readState(statePath);
  let implementationChanges = [];
  let pendingActionReport = null;
  if (state) {
    const changes = protectedChanges(state.protectedHashes, snapshot.hashes);
    if (changes.length > 0) {
      const packet = {
        version: '4.0.0',
        status: 'BLOCKED',
        workspaceRoot: root,
        attempt: Math.min(state.attempts.length + 1, model.repairPolicy.maxAttempts),
        maxAttempts: model.repairPolicy.maxAttempts,
        repairableBlockerCodes: model.repairPolicy.repairableBlockerCodes,
        allowedImplementationPaths: model.repairPolicy.allowedImplementationPaths,
        actionReportPath,
        implementationPolicy,
        protectedHashes: state.protectedHashes,
        failures: state.lastFailures,
        attempts: state.attempts,
      };
      await writePacket(packetPath, packet);
      emit({
        status: 'BLOCKED',
        blocker: {
          code: 'AIH_VISUAL_REPAIR_SCOPE_VIOLATION',
          message: '视觉修复期间修改了受保护输入：' + changes.join(', '),
        },
        repairPacket: packetPath,
      }, 'AIH_VISUAL_REPAIR_SCOPE_VIOLATION');
      return 1;
    }
    implementationChanges = changedEntries(state.allowedFiles, snapshot.allowedFiles);
    if (implementationChanges.length > 0) {
      try {
        pendingActionReport = await readActionReport(
          actionReportPath,
          actionSchemaPath,
          state.attempts.length + 1,
          implementationChanges,
          state.lastFailures,
        );
      } catch (error) {
        emit({
          status: 'BLOCKED',
          message: error.message,
          blockers: [{ code: error.code, message: error.message }],
          actionReportPath,
        }, error.code);
        return 1;
      }
    }
  }

  const input = runGate(manifest, 'canonical-ui-input');
  if (input.status !== 'PASS') {
    if (state) await rm(sessionRoot, { recursive: true, force: true });
    const code = input.blockers?.[0]?.code || 'AIH_VALIDATION_FAILED';
    emit({ status: 'BLOCKED', blockers: input.blockers || [] }, code);
    return 1;
  }

  const runtime = runGate(manifest, 'canonical-ui-runtime');
  if (runtime.status === 'PASS') {
    const attemptHistory = state
      ? [
          ...state.attempts,
          ...(pendingActionReport ? [{
            attempt: state.attempts.length + 1,
            failures: state.lastFailures,
            sourceResolution: pendingActionReport.sourceResolution,
            actions: pendingActionReport.actions,
          }] : []),
        ]
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
      protectedHashes: snapshot.hashes,
      allowedFiles: snapshot.allowedFiles,
      attempts: [],
      lastFailures: failures,
    };
  } else {
    if (pendingActionReport) {
      state.attempts.push({
        attempt: state.attempts.length + 1,
        failures,
        sourceResolution: pendingActionReport.sourceResolution,
        actions: pendingActionReport.actions,
      });
      state.allowedFiles = snapshot.allowedFiles;
      await rm(actionReportPath, { force: true });
    }
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
    actionReportPath,
    implementationPolicy,
    protectedHashes: state.protectedHashes,
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
    message: '读取 Repair Packet，仅修改允许的实现路径；将 Repair Action Report 写入 actionReportPath 后重新运行 canonical-ui-repair。',
    attempt: nextAttempt,
    repairPacket: packetPath,
    actionReportPath,
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
