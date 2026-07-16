import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactPaths,
  loadProjectAndManifest,
  parseStructuredText,
  repositoryFile,
  repositoryRootFrom,
  stringifyStructured,
} from './repository.mjs';

const TRANSACTION_ROOT = '.psp/transactions';

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function fileSha256(path) {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function durableWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableJson(path, value) {
  await durableWrite(path, JSON.stringify(value, null, 2) + '\n');
}

async function durableCopy(source, target) {
  await copyFile(source, target);
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
    await rm(target, { force: true });
    await rename(source, target);
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function cleanupJournal(root, journalPath, journal) {
  for (const entry of journal.entries || []) {
    await rm(repositoryFile(root, entry.newPath), { force: true });
    await rm(repositoryFile(root, entry.backupPath), { force: true });
  }
  await rm(repositoryFile(root, journalPath), { force: true });
}

async function rollbackJournal(root, journalPath, journal) {
  for (const entry of [...(journal.entries || [])].reverse()) {
    const target = repositoryFile(root, entry.target);
    const backup = repositoryFile(root, entry.backupPath);
    if (entry.oldExists) {
      if (!await exists(backup)) {
        if (await fileSha256(target) === entry.oldSha256) continue;
        fail('AIH_ARTIFACT_RECOVERY_REQUIRED', '事务备份缺失，无法恢复旧版本：' + entry.target);
      }
      await durableCopy(backup, target);
    } else {
      await rm(target, { force: true });
    }
  }
  await cleanupJournal(root, journalPath, journal);
}

async function rollForwardJournal(root, journalPath, journal) {
  for (const entry of journal.entries || []) {
    const target = repositoryFile(root, entry.target);
    if (await fileSha256(target) === entry.newSha256) continue;
    const staged = repositoryFile(root, entry.newPath);
    if (!await exists(staged)) {
      fail('AIH_ARTIFACT_RECOVERY_REQUIRED', '事务暂存文件缺失，无法完成提交：' + entry.target);
    }
    const current = await fileSha256(target);
    if (current !== null && current !== entry.oldSha256) {
      fail('AIH_USER_CHANGE_COLLISION', '恢复事务时发现目标已被外部修改：' + entry.target);
    }
    await replaceFile(staged, target);
  }
  for (const entry of journal.entries || []) {
    if (await fileSha256(repositoryFile(root, entry.target)) !== entry.newSha256) {
      fail('AIH_ARTIFACT_RECOVERY_REQUIRED', '事务恢复后的内容哈希不一致：' + entry.target);
    }
  }
  await cleanupJournal(root, journalPath, journal);
}

async function recoverJournal(root, journalPath) {
  const absolute = repositoryFile(root, journalPath);
  if (!await exists(absolute)) return null;
  let journal;
  try {
    journal = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (error) {
    fail('AIH_ARTIFACT_RECOVERY_REQUIRED', '事务日志不可读：' + error.message);
  }
  if (['committing', 'committed'].includes(journal.state)) {
    await rollForwardJournal(root, journalPath, journal);
    return 'completed';
  }
  await rollbackJournal(root, journalPath, journal);
  return 'rolled-back';
}

async function acquireLock(root, artifactId, transactionId, journalPath) {
  const lockPath = TRANSACTION_ROOT + '/' + artifactId + '.lock';
  const absolute = repositoryFile(root, lockPath);
  await mkdir(dirname(absolute), { recursive: true });
  if (await exists(absolute)) {
    let lock = null;
    try { lock = JSON.parse(await readFile(absolute, 'utf8')); } catch { /* stale malformed lock */ }
    if (processIsAlive(lock?.pid)) {
      fail('AIH_USER_CHANGE_COLLISION', '产物已有进行中的事务：' + artifactId);
    }
    await recoverJournal(root, journalPath);
    await rm(absolute, { force: true });
  }
  let handle;
  try {
    handle = await open(absolute, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') fail('AIH_USER_CHANGE_COLLISION', '产物已有进行中的事务：' + artifactId);
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ transactionId, artifactId, pid: process.pid }) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return absolute;
}

async function readCandidate(argument) {
  if (argument === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  }
  if (!argument) fail('AIH_COMMAND_INVALID', '产物事务必须提供 --input <候选文件> 或 --input -。');
  const absolute = resolve(process.cwd(), argument);
  if (!(await stat(absolute)).isFile()) fail('AIH_PATH_INVALID', '事务输入不是普通文件：' + argument);
  return readFile(absolute, 'utf8');
}

function parseCandidate(text, format) {
  try {
    if (['yaml', 'json'].includes(format)) return parseStructuredText(text, format);
  } catch (error) {
    fail('AIH_ARTIFACT_SCHEMA_FAILED', '候选结构化数据无法解析：' + error.message);
  }
  fail('AIH_CONTRACT_INVALID', '产物事务不支持格式：' + format);
}

function canonicalText(data, format) {
  return stringifyStructured(data, format);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

export async function executeArtifactTransaction({ stageId, prepareOutputs }) {
  const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
  const json = process.argv.includes('--json');
  const dryRun = process.argv.includes('--dry-run');
  const operationId = argumentValue('--operation');
  const artifactId = argumentValue('--artifact');
  const inputArgument = argumentValue('--input');
  const expectedSha256 = argumentValue('--expected-sha256');
  let result;
  let lockPath = null;
  try {
    const { project, manifest } = await loadProjectAndManifest(root);
    const operation = manifest.operations.find((item) => item.id === operationId && item.kind === 'artifact');
    if (!operation) fail('AIH_CONTRACT_INVALID', 'Manifest 未声明产物事务 operation：' + operationId);
    if (operation.stage !== stageId || !operation.artifacts.includes(artifactId)) {
      fail('AIH_CONTRACT_INVALID', '产物不属于当前事务 operation：' + artifactId);
    }
    const stage = project.stages?.[stageId];
    if (stage?.status !== 'active') fail('AIH_STAGE_UNINITIALIZED', '阶段尚未初始化，不能更新产物：' + stageId);
    const registry = manifest.artifactRegistry.find((item) => item.id === artifactId && item.stage === stageId);
    if (!registry || registry.authorityKind !== 'internal-model') {
      fail('AIH_CONTRACT_INVALID', '产物事务只支持 internal-model（内部模型）产物：' + artifactId);
    }
    const paths = artifactPaths(project, artifactId, stageId);
    if (!paths || paths.authorityKind !== 'internal-model') {
      fail('AIH_PROJECT_BINDING_INVALID', '项目缺少产物内部模型绑定：' + artifactId);
    }
    const candidateText = await readCandidate(inputArgument);
    const data = parseCandidate(candidateText, registry.format);
    const schema = JSON.parse(await readFile(repositoryFile(root, registry.schema), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      const detail = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
      fail('AIH_ARTIFACT_SCHEMA_FAILED', '候选结构化数据不符合 Schema：' + detail);
    }
    const authorityContent = canonicalText(data, registry.format);
    const sourceSha256 = sha256(authorityContent);
    const preparedOutputs = await prepareOutputs({
      root,
      project,
      manifest,
      stageId,
      artifactId,
      data,
      sourceSha256,
    });
    const expectedOutputPaths = [...paths.outputPaths].sort();
    const actualOutputPaths = preparedOutputs.map((item) => item.output).sort();
    if (
      expectedOutputPaths.length !== actualOutputPaths.length
      || expectedOutputPaths.some((path, index) => path !== actualOutputPaths[index])
    ) {
      fail('AIH_CONTRACT_INVALID', '领域适配器返回的输出与项目绑定不一致：' + artifactId);
    }
    const currentSha256 = await fileSha256(repositoryFile(root, paths.authorityPath));
    const writes = [
      { target: paths.authorityPath, content: authorityContent },
      ...preparedOutputs.map((item) => ({ target: item.output, content: item.content })),
    ];
    if (new Set(writes.map((item) => item.target)).size !== writes.length) {
      fail('AIH_PROJECT_BINDING_INVALID', '产物事务目标路径重复：' + artifactId);
    }
    if (dryRun) {
      result = {
        status: 'PASS',
        mode: 'dry-run',
        operation: operationId,
        artifact: artifactId,
        currentSha256: currentSha256 || 'missing',
        sourceSha256,
        targets: writes.map((item) => item.target),
        blockers: [],
      };
    } else {
      if (!expectedSha256 || !/^(missing|[a-f0-9]{64})$/.test(expectedSha256)) {
        fail('AIH_COMMAND_INVALID', '提交产物事务必须提供 --expected-sha256 <旧版本哈希|missing>。');
      }
      const transactionId = randomUUID();
      const journalPath = TRANSACTION_ROOT + '/' + artifactId + '.json';
      lockPath = await acquireLock(root, artifactId, transactionId, journalPath);
      await recoverJournal(root, journalPath);
      const currentAfterLock = await fileSha256(repositoryFile(root, paths.authorityPath));
      if ((currentAfterLock || 'missing') !== expectedSha256) {
        fail('AIH_USER_CHANGE_COLLISION', '取得事务锁前内部模型已变化：' + paths.authorityPath);
      }
      const journal = {
        version: 1,
        transactionId,
        operation: operationId,
        artifact: artifactId,
        state: 'preparing',
        entries: writes.map((item, index) => ({
          target: item.target,
          newPath: item.target + '.aih-' + transactionId + '-' + index + '.new',
          backupPath: item.target + '.aih-' + transactionId + '-' + index + '.old',
          oldExists: false,
          oldSha256: null,
          newSha256: sha256(item.content),
        })),
      };
      try {
        for (let index = 0; index < writes.length; index += 1) {
          const write = writes[index];
          const entry = journal.entries[index];
          const target = repositoryFile(root, entry.target);
          const staged = repositoryFile(root, entry.newPath);
          const backup = repositoryFile(root, entry.backupPath);
          await mkdir(dirname(target), { recursive: true });
          entry.oldExists = await exists(target);
          entry.oldSha256 = entry.oldExists ? await fileSha256(target) : null;
          await durableWrite(staged, write.content);
          if (entry.oldExists) await durableCopy(target, backup);
        }
        journal.state = 'prepared';
        await durableJson(repositoryFile(root, journalPath), journal);
        journal.state = 'committing';
        await durableJson(repositoryFile(root, journalPath), journal);
        let replaced = 0;
        for (const entry of journal.entries) {
          await replaceFile(repositoryFile(root, entry.newPath), repositoryFile(root, entry.target));
          replaced += 1;
          if (process.env.NODE_ENV === 'test' && Number(process.env.AI_HARNESS_TRANSACTION_FAIL_AFTER_RENAMES) === replaced) {
            fail('AIH_ARTIFACT_TRANSACTION_FAILED', '测试注入：提交第 ' + replaced + ' 个目标后失败。');
          }
          if (process.env.NODE_ENV === 'test' && Number(process.env.AI_HARNESS_TRANSACTION_CRASH_AFTER_RENAMES) === replaced) {
            process.exit(86);
          }
        }
        for (const entry of journal.entries) {
          if (await fileSha256(repositoryFile(root, entry.target)) !== entry.newSha256) {
            fail('AIH_ARTIFACT_TRANSACTION_FAILED', '提交后内容哈希不一致：' + entry.target);
          }
        }
        journal.state = 'committed';
        await durableJson(repositoryFile(root, journalPath), journal);
        await cleanupJournal(root, journalPath, journal);
        result = {
          status: 'PASS',
          mode: 'commit',
          operation: operationId,
          artifact: artifactId,
          transactionId,
          previousSha256: expectedSha256,
          sourceSha256,
          authority: paths.authorityPath,
          outputs: preparedOutputs.map((item) => ({ output: item.output, role: item.role })),
          blockers: [],
        };
      } catch (error) {
        try {
          journal.state = 'rolling-back';
          await durableJson(repositoryFile(root, journalPath), journal);
          await rollbackJournal(root, journalPath, journal);
        } catch (recoveryError) {
          fail('AIH_ARTIFACT_RECOVERY_REQUIRED', error.message + '; 自动恢复失败：' + recoveryError.message);
        }
        if (!error.code?.startsWith('AIH_')) error.code = 'AIH_ARTIFACT_TRANSACTION_FAILED';
        throw error;
      }
    }
  } catch (error) {
    result = {
      status: 'BLOCKED',
      mode: dryRun ? 'dry-run' : 'commit',
      operation: operationId,
      artifact: artifactId,
      blockers: [{ code: error.code || 'AIH_ARTIFACT_TRANSACTION_FAILED', message: error.message }],
    };
  } finally {
    if (lockPath) await rm(lockPath, { force: true });
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'PASS') console.log('[PASS] YAML 与 Markdown 产物事务' + (dryRun ? '预检' : '提交') + '完成。');
  else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
  if (result.status !== 'PASS') process.exitCode = 1;
  return result;
}
