import { randomUUID } from 'node:crypto';
import {
  access,
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

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
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

async function acquireLock(root, artifactId, transactionId) {
  const lockPath = TRANSACTION_ROOT + '/' + artifactId + '.lock';
  const absolute = repositoryFile(root, lockPath);
  await mkdir(dirname(absolute), { recursive: true });
  if (await exists(absolute)) {
    let lock = null;
    try { lock = JSON.parse(await readFile(absolute, 'utf8')); } catch { /* stale malformed lock */ }
    if (processIsAlive(lock?.pid)) {
      fail('AIH_USER_CHANGE_COLLISION', '产物已有进行中的写入：' + artifactId);
    }
    await rm(absolute, { force: true });
  }
  let handle;
  try {
    handle = await open(absolute, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') fail('AIH_USER_CHANGE_COLLISION', '产物已有进行中的写入：' + artifactId);
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
  if (!argument) fail('AIH_COMMAND_INVALID', '产物写入必须提供 --input <候选文件> 或 --input -。');
  const absolute = resolve(process.cwd(), argument);
  if (!(await stat(absolute)).isFile()) fail('AIH_PATH_INVALID', '写入输入不是普通文件：' + argument);
  return readFile(absolute, 'utf8');
}

function parseCandidate(text, format) {
  try {
    if (['yaml', 'json'].includes(format)) return parseStructuredText(text, format);
  } catch (error) {
    fail('AIH_ARTIFACT_SCHEMA_FAILED', '候选结构化数据无法解析：' + error.message);
  }
  fail('AIH_CONTRACT_INVALID', '产物写入不支持格式：' + format);
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
  let result;
  let lockPath = null;
  const stagedPaths = [];
  try {
    const { project, manifest } = await loadProjectAndManifest(root);
    const operation = manifest.operations.find((item) => item.id === operationId && item.kind === 'artifact');
    if (!operation) fail('AIH_CONTRACT_INVALID', 'Manifest 未声明产物写入 operation：' + operationId);
    if (operation.stage !== stageId || !operation.artifacts.includes(artifactId)) {
      fail('AIH_CONTRACT_INVALID', '产物不属于当前写入 operation：' + artifactId);
    }
    const stage = project.stages?.[stageId];
    if (stage?.status !== 'active') fail('AIH_STAGE_UNINITIALIZED', '阶段尚未初始化，不能更新产物：' + stageId);
    const registry = manifest.artifactRegistry.find((item) => item.id === artifactId && item.stage === stageId);
    if (!registry || registry.authorityKind !== 'internal-model') {
      fail('AIH_CONTRACT_INVALID', '产物写入只支持 internal-model（内部模型）产物：' + artifactId);
    }
    const paths = artifactPaths(project, artifactId, stageId);
    if (!paths || paths.authorityKind !== 'internal-model') {
      fail('AIH_PROJECT_BINDING_INVALID', '项目缺少产物内部模型绑定：' + artifactId);
    }
    const data = parseCandidate(await readCandidate(inputArgument), registry.format);
    const schema = JSON.parse(await readFile(repositoryFile(root, registry.schema), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const validate = ajv.compile(schema);
    if (!validate(data)) {
      const detail = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
      fail('AIH_ARTIFACT_SCHEMA_FAILED', '候选结构化数据不符合 Schema：' + detail);
    }
    const authorityContent = stringifyStructured(data, registry.format);
    const preparedOutputs = await prepareOutputs({
      root,
      project,
      manifest,
      stageId,
      artifactId,
      data,
    });
    const expectedOutputPaths = [...paths.outputPaths].sort();
    const actualOutputPaths = preparedOutputs.map((item) => item.output).sort();
    if (
      expectedOutputPaths.length !== actualOutputPaths.length
      || expectedOutputPaths.some((path, index) => path !== actualOutputPaths[index])
    ) {
      fail('AIH_CONTRACT_INVALID', '领域适配器返回的输出与项目绑定不一致：' + artifactId);
    }
    const writes = [
      { target: paths.authorityPath, content: authorityContent },
      ...preparedOutputs.map((item) => ({ target: item.output, content: item.content })),
    ];
    if (new Set(writes.map((item) => item.target)).size !== writes.length) {
      fail('AIH_PROJECT_BINDING_INVALID', '产物写入目标路径重复：' + artifactId);
    }
    if (dryRun) {
      result = {
        status: 'PASS',
        mode: 'dry-run',
        operation: operationId,
        artifact: artifactId,
        targets: writes.map((item) => item.target),
        blockers: [],
      };
    } else {
      const transactionId = randomUUID();
      lockPath = await acquireLock(root, artifactId, transactionId);
      for (let index = 0; index < writes.length; index += 1) {
        const staged = repositoryFile(root, writes[index].target + '.aih-' + transactionId + '-' + index + '.new');
        stagedPaths.push(staged);
        await durableWrite(staged, writes[index].content);
      }
      for (let index = 0; index < writes.length; index += 1) {
        await replaceFile(stagedPaths[index], repositoryFile(root, writes[index].target));
      }
      result = {
        status: 'PASS',
        mode: 'commit',
        operation: operationId,
        artifact: artifactId,
        transactionId,
        authority: paths.authorityPath,
        outputs: preparedOutputs.map((item) => ({ output: item.output, role: item.role })),
        blockers: [],
      };
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
    await Promise.all(stagedPaths.map((path) => rm(path, { force: true })));
    if (lockPath) await rm(lockPath, { force: true });
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.status === 'PASS') console.log('[PASS] YAML 与 Markdown 产物' + (dryRun ? '预检' : '写入') + '完成。');
  else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
  if (result.status !== 'PASS') process.exitCode = 1;
  return result;
}
