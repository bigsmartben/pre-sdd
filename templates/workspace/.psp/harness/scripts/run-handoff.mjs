import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeRegisteredCommand } from './lib/execute-command.mjs';
import { collectDependencyIds, dagNodes, handoffEdge } from './lib/project-dag.mjs';
import {
  artifactPaths,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from './lib/repository.mjs';
import { stageIsReadable } from './lib/stage-state.mjs';

const root = repositoryRootFrom(import.meta.dirname);

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function argumentsFor(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--' + name && process.argv[index + 1]) values.push(process.argv[++index]);
  }
  return values;
}

function scopeStage(scope) {
  return ['static', 'workspace', 'domain'].includes(scope?.selector?.type) ? null : scope?.selector?.stage;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function integrityDigest(receipt) {
  const unsigned = structuredClone(receipt);
  delete unsigned.integrity;
  return sha256(JSON.stringify(canonical(unsigned)));
}

async function receiptValidator(rootDirectory, manifest) {
  try {
    const schema = JSON.parse(await readFile(repositoryFile(rootDirectory, manifest.schemas.handoffReceipt), 'utf8'));
    return new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  } catch (error) {
    error.code = 'AIH_SCHEMA_INVALID';
    throw error;
  }
}

function schemaMessage(validate) {
  return (validate.errors || [])
    .map((error) => (error.instancePath || '/') + ' ' + error.message)
    .join('; ');
}

function invalidReceiptResponse(receipt, message) {
  const result = blockedPreflight(
    typeof receipt?.from === 'string' ? receipt.from : null,
    typeof receipt?.to === 'string' ? receipt.to : null,
    'AIH_SCHEMA_INVALID',
    'Handoff Receipt 不符合登记 Schema：' + message,
  );
  result.operation = 'HANDOFF_RECEIPT_INSPECTION';
  result.receipt = { status: 'INVALID', path: null };
  return result;
}

async function collectFiles(rootDirectory, relative, output) {
  let entries;
  try {
    entries = await readdir(repositoryFile(rootDirectory, relative), { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOTDIR') {
      output.add(relative);
      return;
    }
    if (error.code === 'ENOENT') throw Object.assign(new Error('来源路径不存在：' + relative), { code: 'AIH_SOURCE_IDENTITY_INVALID' });
    throw error;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative + '/' + entry.name;
    if (entry.isDirectory()) await collectFiles(rootDirectory, path, output);
    else if (entry.isFile()) output.add(path);
  }
}

async function scopeFiles(rootDirectory, project, scope) {
  const files = new Set();
  if (scope.selector.type === 'artifact') {
    for (const artifactId of scope.selector.artifacts) {
      const paths = artifactPaths(project, artifactId, scope.selector.stage);
      if (!paths) throw Object.assign(new Error('来源 Artifact 无法解析：' + artifactId), { code: 'AIH_SOURCE_IDENTITY_INVALID' });
      await collectFiles(rootDirectory, paths.authorityPath, files);
    }
  } else if (scope.selector.type === 'stage') {
    await collectFiles(rootDirectory, project.stages[scope.selector.stage].root, files);
  } else {
    throw Object.assign(new Error('handoff 来源必须是 Stage 或 Artifact Scope：' + scope.id), { code: 'AIH_SOURCE_IDENTITY_INVALID' });
  }
  return [...files].sort();
}

async function sourceSnapshot(rootDirectory, project, manifest, scopeIds) {
  const paths = new Set();
  for (const scopeId of scopeIds) {
    const scope = manifest.scopes.find((item) => item.id === scopeId);
    for (const path of await scopeFiles(rootDirectory, project, scope)) paths.add(path);
  }
  const entries = [];
  for (const path of [...paths].sort()) {
    entries.push({ path, sha256: sha256(await readFile(repositoryFile(rootDirectory, path))) });
  }
  return { digest: sha256(JSON.stringify(entries)), paths: entries };
}

function catalogedBlockers(manifest, validation) {
  const catalog = new Map((manifest.blockers || []).map((item) => [item.code, item]));
  const output = [];
  for (const item of validation) {
    for (const blocker of item.blockers || []) {
      const code = typeof blocker === 'string' ? blocker : blocker.code;
      const declared = catalog.get(code);
      output.push({
        code,
        message: declared?.meaning || '验证命令失败。',
        gateClass: declared?.gateClass || (declared?.domain ? 'domain-diagnostic' : 'safety-structure'),
        source: item.id,
      });
    }
  }
  return output;
}

function combinedValidationStatus(validation) {
  if (validation.some((item) => item.status === 'BLOCKED')) return 'BLOCKED';
  if (validation.some((item) => item.status === 'FAIL')) return 'FAIL';
  if (validation.some((item) => item.status === 'NOT_RUN')) return 'NOT_RUN';
  return 'PASS';
}

function blockedPreflight(from, to, code, message) {
  return {
    protocol: 'pre-sdd-harness/v3',
    operation: 'HANDOFF_PREFLIGHT',
    from,
    to,
    validation: { status: 'BLOCKED', commands: [], blockers: [{ code, message, gateClass: 'safety-structure' }] },
    decision: { status: 'PENDING', actor: null, acceptedRisks: [] },
    receipt: { status: 'NOT_CREATED', path: null },
    confirmable: false,
    risks: [],
    downstreamAction: 'NOT_RUN',
  };
}

export async function preflightHandoff(rootDirectory, from, to, options = {}) {
  const { project, manifest } = await loadProjectAndManifest(rootDirectory);
  const scopes = new Map(manifest.scopes.map((scope) => [scope.id, scope]));
  const nodes = dagNodes(manifest);
  const source = scopes.get(from);
  const consumer = scopes.get(to);
  if (!nodes.has(from) || !nodes.has(to) || !source || !consumer) {
    return blockedPreflight(from, to, 'AIH_DAG_NODE_UNKNOWN', 'handoff 来源或目标不是项目 DAG 中的已知节点。');
  }
  const edge = handoffEdge(manifest, from, to);
  if (!edge) return blockedPreflight(from, to, 'AIH_HANDOFF_UNREACHABLE', '项目 DAG 未声明指定 handoff 授权边。');

  const scopeIds = [...collectDependencyIds(manifest, from), from];
  for (const scopeId of scopeIds) {
    const scope = scopes.get(scopeId);
    const stageId = scopeStage(scope);
    if (!scope || scope.status !== 'active') {
      return blockedPreflight(from, to, scope?.blockerCode || 'AIH_UPSTREAM_NOT_READY', '来源或 Dependency Scope 不可消费：' + scopeId);
    }
    if (stageId && !stageIsReadable(project.stages?.[stageId])) {
      return blockedPreflight(from, to, 'AIH_STAGE_UNINITIALIZED', '来源或 Dependency 阶段尚未 active 或 published：' + stageId);
    }
  }

  const profile = manifest.validationProfiles.find((item) => item.id === edge.profile);
  if (!profile || !profile.allowedContexts.includes('handoff')) {
    return blockedPreflight(from, to, 'AIH_PROFILE_INVALID', 'handoff 边引用未知或上下文不合法的 Profile：' + edge.profile);
  }
  const commands = new Map(manifest.commands.map((item) => [item.id, item]));
  const validation = [];
  let failed = false;
  for (const commandId of profile.commands) {
    const command = commands.get(commandId);
    if (!command || !command.allowedContexts.includes('handoff')) {
      validation.push({ id: commandId, command: command?.run || null, status: 'BLOCKED', blockers: ['AIH_EXECUTION_CONTEXT_INVALID'], durationMs: 0 });
      failed = true;
      continue;
    }
    if (failed) {
      validation.push({ id: command.id, command: command.run, status: 'NOT_RUN', blockers: [], durationMs: 0 });
      continue;
    }
    const started = Date.now();
    const item = executeRegisteredCommand(rootDirectory, command, {
      ...options,
      arguments: command.id === 'project-consistency' ? ['--scope', from, '--json'] : [],
      timeout: Math.min(command.timeoutMs, profile.timeoutMs),
    });
    item.durationMs = Date.now() - started;
    validation.push(item);
    if (item.status === 'FAIL' || item.status === 'BLOCKED') failed = true;
  }
  const blockers = catalogedBlockers(manifest, validation);
  const safetyBlockers = blockers.filter((item) => item.gateClass === 'safety-structure');
  const risks = blockers.filter((item) => item.gateClass === 'domain-diagnostic');
  let snapshot;
  try {
    snapshot = await sourceSnapshot(rootDirectory, project, manifest, scopeIds);
  } catch (error) {
    return blockedPreflight(from, to, error.code || 'AIH_SOURCE_IDENTITY_INVALID', error.message);
  }
  const token = sha256(JSON.stringify(canonical({
    protocol: manifest.standard.protocol,
    standardVersion: manifest.standard.version,
    manifestVersion: manifest.version,
    from,
    to,
    profile: profile.id,
    profileVersion: profile.version,
    sourceDigest: snapshot.digest,
    validation: validation.map((item) => ({ id: item.id, status: item.status, blockers: item.blockers || [] })),
  })));
  return {
    protocol: manifest.standard.protocol,
    standardVersion: manifest.standard.version,
    operation: 'HANDOFF_PREFLIGHT',
    from,
    to,
    dependencyClosure: scopeIds,
    profile: { id: profile.id, version: profile.version },
    source: { version: manifest.version, ...snapshot },
    validation: { status: combinedValidationStatus(validation), commands: validation, blockers },
    decision: { status: 'PENDING', actor: null, acceptedRisks: [] },
    receipt: { status: 'NOT_CREATED', path: null },
    confirmable: safetyBlockers.length === 0,
    risks,
    preflightToken: token,
    downstreamAction: 'NOT_RUN',
  };
}

function receiptPath(from, to, id) {
  return '.psp/handoffs/receipts/' + from + '--' + to + '--' + id + '.json';
}

async function atomicWriteJson(rootDirectory, path, value) {
  const absolute = repositoryFile(rootDirectory, path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = absolute + '.tmp-' + process.pid;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  await rename(temporary, absolute);
}

export async function confirmHandoff(rootDirectory, from, to, confirmation) {
  const preflight = await preflightHandoff(rootDirectory, from, to);
  if (!preflight.confirmable) return preflight;
  if (!confirmation.actor || confirmation.token !== preflight.preflightToken) {
    return blockedPreflight(from, to, 'AIH_HANDOFF_CONFIRMATION_INVALID', '确认主体或 preflight token 无效。');
  }
  const accepted = new Set(confirmation.acceptedRisks || []);
  const missing = preflight.risks.filter((item) => !accepted.has(item.code));
  if (missing.length > 0) {
    const result = structuredClone(preflight);
    result.confirmable = false;
    result.validation.blockers.push({ code: 'AIH_RISK_ACCEPTANCE_REQUIRED', message: '必须逐项接受所有已展示的领域风险。', gateClass: 'safety-structure' });
    return result;
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const path = receiptPath(from, to, id);
  const receipt = {
    protocol: preflight.protocol,
    standardVersion: preflight.standardVersion,
    id,
    from,
    to,
    dependencyClosure: preflight.dependencyClosure,
    profile: preflight.profile,
    source: preflight.source,
    validation: preflight.validation,
    decision: { status: 'CONFIRMED', actor: confirmation.actor, confirmedAt: now, acceptedRisks: [...accepted].sort() },
    receipt: { status: 'VALID', createdAt: now, revokedAt: null, revokeReason: null },
    downstreamAction: 'NOT_RUN',
  };
  receipt.integrity = { algorithm: 'sha256', digest: integrityDigest(receipt) };
  const { manifest } = await loadProjectAndManifest(rootDirectory);
  const validateReceipt = await receiptValidator(rootDirectory, manifest);
  if (!validateReceipt(receipt)) return invalidReceiptResponse(receipt, schemaMessage(validateReceipt));
  await atomicWriteJson(rootDirectory, path, receipt);
  return { ...receipt, operation: 'HANDOFF_RECORDED', confirmable: false, path };
}

export async function inspectReceipt(rootDirectory, path) {
  const receipt = JSON.parse(await readFile(repositoryFile(rootDirectory, path), 'utf8'));
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return invalidReceiptResponse(receipt, '根值必须是对象。');
  }
  if (receipt.protocol !== 'pre-sdd-harness/v3') {
    return blockedPreflight(receipt.from, receipt.to, 'AIH_PROTOCOL_UNSUPPORTED', 'Receipt 不是 pre-sdd-harness/v3。');
  }
  const { project, manifest } = await loadProjectAndManifest(rootDirectory);
  const validateReceipt = await receiptValidator(rootDirectory, manifest);
  if (!validateReceipt(receipt)) return invalidReceiptResponse(receipt, schemaMessage(validateReceipt));
  if (receipt.integrity.digest !== integrityDigest(receipt)) {
    receipt.receipt.status = 'INVALID';
    receipt.validation.blockers.push({ code: 'AIH_RECEIPT_TAMPERED', message: 'Receipt 完整性摘要不匹配。', gateClass: 'safety-structure' });
    return receipt;
  }
  if (receipt.receipt.status === 'REVOKED') return receipt;
  const current = await sourceSnapshot(rootDirectory, project, manifest, receipt.dependencyClosure);
  const currentProfile = manifest.validationProfiles.find((item) => item.id === receipt.profile.id);
  const currentEdge = handoffEdge(manifest, receipt.from, receipt.to);
  if (
    current.digest !== receipt.source.digest
    || manifest.version !== receipt.source.version
    || manifest.standard.version !== receipt.standardVersion
    || currentProfile?.version !== receipt.profile.version
    || currentEdge?.profile !== receipt.profile.id
  ) receipt.receipt.status = 'STALE';
  return receipt;
}

export async function revokeReceipt(rootDirectory, path, actor, reason) {
  const receipt = await inspectReceipt(rootDirectory, path);
  if (receipt.receipt?.status === 'INVALID' || receipt.protocol !== 'pre-sdd-harness/v3') return receipt;
  if (receipt.receipt?.status === 'REVOKED') {
    return blockedPreflight(receipt.from, receipt.to, 'AIH_RECEIPT_STATE_INVALID', 'Receipt 已撤销，不能重复执行状态转换。');
  }
  if (!actor || !reason) return blockedPreflight(receipt.from, receipt.to, 'AIH_HANDOFF_CONFIRMATION_INVALID', '撤销必须提供 actor 与 reason。');
  receipt.receipt = { ...receipt.receipt, status: 'REVOKED', revokedAt: new Date().toISOString(), revokeReason: reason, revokedBy: actor };
  receipt.integrity = { algorithm: 'sha256', digest: integrityDigest(receipt) };
  const { manifest } = await loadProjectAndManifest(rootDirectory);
  const validateReceipt = await receiptValidator(rootDirectory, manifest);
  if (!validateReceipt(receipt)) return invalidReceiptResponse(receipt, schemaMessage(validateReceipt));
  await atomicWriteJson(rootDirectory, path, receipt);
  return receipt;
}

async function main() {
  const from = argument('from');
  const to = argument('to');
  const path = argument('receipt');
  let result;
  try {
    if (process.argv.includes('--status')) {
      if (!path) throw Object.assign(new Error('--status 需要 --receipt。'), { code: 'AIH_COMMAND_INVALID' });
      result = await inspectReceipt(root, path);
    } else if (process.argv.includes('--revoke')) {
      if (!path) throw Object.assign(new Error('--revoke 需要 --receipt。'), { code: 'AIH_COMMAND_INVALID' });
      result = await revokeReceipt(root, path, argument('actor'), argument('reason'));
    } else {
      if (!from || !to) throw Object.assign(new Error('handoff 必须同时提供 --from 与 --to。'), { code: 'AIH_COMMAND_INVALID' });
      if (process.argv.includes('--reject')) {
        result = await preflightHandoff(root, from, to);
        result.decision = { status: 'REJECTED', actor: argument('actor'), rejectedAt: new Date().toISOString(), acceptedRisks: [] };
      } else if (process.argv.includes('--confirm')) {
        result = await confirmHandoff(root, from, to, {
          actor: argument('actor'),
          token: argument('preflight-token'),
          acceptedRisks: argumentsFor('accept-risk'),
        });
      } else {
        result = await preflightHandoff(root, from, to);
      }
    }
  } catch (error) {
    const code = error.code || (error instanceof SyntaxError ? 'AIH_SCHEMA_INVALID' : 'AIH_VALIDATION_FAILED');
    result = blockedPreflight(from, to, code, error.message);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('[' + (result.receipt?.status || result.operation || 'BLOCKED') + '] downstreamAction=NOT_RUN');
  const blocked = result.validation?.status === 'BLOCKED' || result.receipt?.status === 'INVALID';
  if (blocked) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
