import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactCollectionMembers,
  artifactPaths,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { coverageCandidate, stableJson } from '../../../mockcase-coverage/scripts/lib.mjs';
import { extractCanonicalUi } from './extract.mjs';

function sha256(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function replaceMockCases(source, mockCases) {
  const pattern = /(?:^|\n)([ \t]*)(?:"mockCases"|mockCases)\s*:\s*/g;
  let match;
  let selected = null;
  while ((match = pattern.exec(source))) selected = { ...match, valueStart: pattern.lastIndex };
  if (!selected || source[selected.valueStart] !== '[') fail('AIH_MOCKCASE_APPLY_FAILED', 'canonical-ui.ts 缺少静态 mockCases 数组。');
  let quote = null;
  let escaped = false;
  let depth = 0;
  let end = -1;
  for (let index = selected.valueStart; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  if (end < 0) fail('AIH_MOCKCASE_APPLY_FAILED', 'canonical-ui.ts 的 mockCases 数组未闭合。');
  const formatted = JSON.stringify(mockCases, null, 2).replaceAll('\n', '\n' + selected[1]);
  return source.slice(0, selected.valueStart) + formatted + source.slice(end);
}

async function durable(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function commitWrites(root, writes, lockPath, verify) {
  const transactionId = randomUUID();
  const staged = [];
  const backups = [];
  let lock;
  let ownsLock = false;
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    try {
      lock = await open(lockPath, 'wx');
      ownsLock = true;
    } catch (error) {
      if (error.code === 'EEXIST') fail('AIH_USER_CHANGE_COLLISION', 'MockCase 候选已有进行中的写入。');
      throw error;
    }
    await lock.writeFile(JSON.stringify({ transactionId, pid: process.pid }) + '\n');
    await lock.sync();
    await lock.close();
    lock = null;
    for (let index = 0; index < writes.length; index += 1) {
      const target = repositoryFile(root, writes[index].path);
      const next = target + `.aih-${transactionId}-${index}.new`;
      const backup = target + `.aih-${transactionId}-${index}.bak`;
      await durable(next, writes[index].content);
      staged.push(next);
      backups.push({ target, backup });
    }
    const movedBackups = [];
    try {
      for (const item of backups) {
        await rename(item.target, item.backup);
        movedBackups.push(item);
      }
    } catch (error) {
      for (const item of movedBackups.reverse()) await rename(item.backup, item.target);
      throw error;
    }
    try {
      for (let index = 0; index < backups.length; index += 1) await rename(staged[index], backups[index].target);
      await verify();
    } catch (error) {
      for (const item of backups) {
        await rm(item.target, { force: true });
        try { await rename(item.backup, item.target); } catch { /* Report original transaction failure. */ }
      }
      throw error;
    }
    await Promise.all(backups.map((item) => rm(item.backup, { force: true })));
    return transactionId;
  } finally {
    if (lock) await lock.close();
    await Promise.all(staged.map((path) => rm(path, { force: true })));
    if (ownsLock) await rm(lockPath, { force: true });
  }
}

function verifyAppliedModel(root, actor) {
  const validator = repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs');
  const child = spawnSync(process.execPath, [validator, '--actor', actor, '--json'], {
    cwd: root,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  let output;
  try { output = JSON.parse(child.stdout || '{}'); } catch { /* Use stable apply blocker below. */ }
  if (child.status !== 0 || output?.status !== 'PASS') {
    const first = output?.blockers?.[0];
    fail(first?.code || 'AIH_MOCKCASE_APPLY_FAILED', first?.message || child.stderr || '应用后的 Canonical UI 输入校验失败。');
  }
}

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const dryRun = process.argv.includes('--dry-run');
let result;
try {
  const actor = argument('--actor');
  const inputPath = argument('--input');
  if (!actor || !/^ACTOR-[0-9]{3}$/.test(actor)) fail('AIH_SCOPE_UNRESOLVED', '必须提供 --actor ACTOR-NNN。');
  if (!inputPath) fail('AIH_COMMAND_INVALID', '必须提供 --input <temporary-candidate.json>。');
  const { project, manifest } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  if (stage?.status === 'published') fail('AIH_STAGE_LOCKED', 'Product Design 已发布；应用 MockCase 前必须 Reopen。');
  if (stage?.status !== 'active') fail('AIH_STAGE_UNINITIALIZED', 'Product Design 尚未初始化。');
  const operation = manifest.operations.find((item) => item.id === 'apply-mockcase-candidate' && item.kind === 'artifact');
  if (!operation?.artifacts?.includes('canonical-ui-prototype')) fail('AIH_CONTRACT_INVALID', 'Manifest 未登记 Product Design MockCase Apply Operation。');

  const candidate = JSON.parse(await readFile(resolve(process.cwd(), inputPath), 'utf8'));
  const candidateSchema = JSON.parse(await readFile(repositoryFile(root, '.agents/skills/mockcase-coverage/candidate.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const validateCandidate = ajv.compile(candidateSchema);
  if (!validateCandidate(candidate)) fail('AIH_ARTIFACT_SCHEMA_FAILED', 'MockCase Candidate Schema 校验失败：' + JSON.stringify(validateCandidate.errors));
  if (candidate.actor !== actor) fail('AIH_SCOPE_UNRESOLVED', '候选 Actor 与命令 Actor 不一致。');
  if (candidate.status !== 'PASS' || candidate.gaps.length > 0) fail('AIH_MOCKCASE_UPSTREAM_GAP', '候选包含上游 gap，拒绝 Apply。');
  const { candidateHash, ...candidateBody } = candidate;
  if (candidateHash !== sha256(stableJson(candidateBody))) fail('AIH_MOCKCASE_CANDIDATE_STALE', '候选内容哈希不匹配。');

  const current = await coverageCandidate(candidate.scope);
  if (current.inputHash !== candidate.inputHash || current.targetModelHash !== candidate.targetModelHash) {
    fail('AIH_MOCKCASE_CANDIDATE_STALE', 'Use Cases、Canonical UI、Manifest 或目标模型已变化；请重新分析。');
  }
  if (stableJson(current) !== stableJson(candidate)) {
    fail('AIH_MOCKCASE_CANDIDATE_STALE', '候选不再等于当前输入与 Scope 的确定性生成结果；请重新生成。');
  }
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const member = (await artifactCollectionMembers(root, paths)).find((item) => item.actor === actor);
  if (!member) fail('AIH_SCOPE_UNRESOLVED', 'Canonical UI Actor 不存在：' + actor);
  const sourcePath = repositoryFile(root, member.authorityPath);
  const source = await readFile(sourcePath, 'utf8');
  if (sha256(source) !== candidate.targetModelHash) fail('AIH_MOCKCASE_CANDIDATE_STALE', '目标 canonical-ui.ts 在 Apply 前发生变化。');
  const model = await extractCanonicalUi(root, member.authorityPath);
  const scopeScenarioIds = new Set(candidate.scope.scenarioIds);
  const stale = new Set(candidate.staleCaseIds);
  const outsideCollision = model.mockCases.find((item) => candidate.generatedCases.some((generated) => generated.id === item.id) && !stale.has(item.id));
  if (outsideCollision) fail('AIH_USER_CHANGE_COLLISION', '生成 Case ID 与现有非 stale Case 冲突：' + outsideCollision.id);
  if (model.mockCases.some((item) => stale.has(item.id) && item.scenarioId && !scopeScenarioIds.has(item.scenarioId))) {
    fail('AIH_SCOPE_UNRESOLVED', '候选试图删除 Scope 外 stale Case。');
  }
  const mockCases = [
    ...model.mockCases.filter((item) => !stale.has(item.id)),
    ...candidate.generatedCases,
  ].sort((left, right) => left.id.localeCompare(right.id));
  const nextModel = { ...model, mockCases };
  const canonicalSchema = JSON.parse(await readFile(repositoryFile(root, manifest.artifactRegistry.find((item) => item.id === 'canonical-ui-prototype').schema), 'utf8'));
  const validateCanonical = ajv.compile(canonicalSchema);
  if (!validateCanonical(nextModel)) fail('AIH_ARTIFACT_SCHEMA_FAILED', '应用后的 Canonical UI Schema 校验失败：' + JSON.stringify(validateCanonical.errors));
  const nextSource = replaceMockCases(source, mockCases);
  const projection = JSON.stringify(nextModel, null, 2) + '\n';
  const projectionBinding = paths.memberOutputs.find((item) => item.role === 'generated-support');
  if (!projectionBinding) fail('AIH_PROJECT_BINDING_INVALID', 'Canonical UI 缺少 generated-support 投影绑定。');
  const projectionPath = `${projectionBinding.root}/${actor}/${projectionBinding.member}`;
  const writes = [
    { path: member.authorityPath, content: nextSource },
    { path: projectionPath, content: projection },
  ];
  if (dryRun) {
    result = { status: 'PASS', mode: 'dry-run', operation: 'apply-mockcase-candidate', actor, mappedCaseIds: candidate.generatedCases.map((item) => item.id), removedStaleCaseIds: candidate.staleCaseIds, targets: writes.map((item) => item.path), coverage: candidate.coverageAfter, lifecycle: 'MAPPED', blockers: [] };
  } else {
    const latest = await readFile(sourcePath, 'utf8');
    if (sha256(latest) !== candidate.targetModelHash) fail('AIH_MOCKCASE_CANDIDATE_STALE', '目标 canonical-ui.ts 在事务提交前发生变化。');
    const transactionId = await commitWrites(
      root,
      writes,
      repositoryFile(root, '.psp/transactions/mockcase-coverage.lock'),
      () => verifyAppliedModel(root, actor),
    );
    result = { status: 'PASS', mode: 'commit', operation: 'apply-mockcase-candidate', transactionId, actor, mappedCaseIds: candidate.generatedCases.map((item) => item.id), removedStaleCaseIds: candidate.staleCaseIds, targets: writes.map((item) => item.path), coverage: candidate.coverageAfter, lifecycle: 'MAPPED', reviewEvidence: 'STALE', validation: [{ id: 'canonical-ui-input', status: 'PASS', blockers: [] }], blockers: [] };
  }
} catch (error) {
  result = { status: 'BLOCKED', mode: dryRun ? 'dry-run' : 'commit', operation: 'apply-mockcase-candidate', blockers: [{ code: error.code || 'AIH_MOCKCASE_APPLY_FAILED', message: error.message }] };
}

console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
