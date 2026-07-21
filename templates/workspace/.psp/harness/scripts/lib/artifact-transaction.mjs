import { randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactMemberPath,
  artifactPaths,
  actorPartition,
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

async function filesBelow(directory) {
  if (!(await exists(directory))) return [];
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(directory);
  return files;
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

async function readCandidateSet(argument, paths, format) {
  if (!argument || argument === '-') {
    fail('AIH_COMMAND_INVALID', '集合产物写入必须提供 --input <候选目录>。');
  }
  const absolute = resolve(process.cwd(), argument);
  let info;
  try { info = await stat(absolute); } catch { fail('AIH_PATH_INVALID', '候选目录不存在：' + argument); }
  if (!info.isDirectory()) fail('AIH_PATH_INVALID', '集合产物输入必须是目录：' + argument);
  const entries = await readdir(absolute, { withFileTypes: true });
  if (entries.length === 0) fail('AIH_ARTIFACT_INCOMPLETE', '候选目录没有参与者分区。');
  const members = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !actorPartition(entry.name)) {
      fail('AIH_PATH_INVALID', '候选目录只能包含 ACTOR-NNN 子目录：' + entry.name);
    }
    const actorRoot = resolve(absolute, entry.name);
    const children = await readdir(actorRoot, { withFileTypes: true });
    if (children.length !== 1 || !children[0].isFile() || children[0].name !== paths.member) {
      fail('AIH_PATH_INVALID', entry.name + ' 必须且只能包含 ' + paths.member + '。');
    }
    const text = await readFile(resolve(actorRoot, paths.member), 'utf8');
    const data = parseCandidate(text, format);
    const declaredActor = data?.metadata?.actor;
    if (declaredActor !== entry.name) {
      fail('AIH_ARTIFACT_SCHEMA_FAILED', '目录参与者与 metadata.actor 不一致：' + entry.name + ' / ' + declaredActor);
    }
    members.push({ actor: entry.name, data, content: text });
  }
  return members.sort((left, right) => left.actor.localeCompare(right.actor));
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

export async function executeArtifactTransaction({ stageId, prepareOutputs, prepareCandidate = null }) {
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
    if (!registry || !['internal-model', 'internal-model-set'].includes(registry.authorityKind)) {
      fail('AIH_CONTRACT_INVALID', '产物写入只支持 internal-model 或 internal-model-set（内部模型集合）产物：' + artifactId);
    }
    const paths = artifactPaths(project, artifactId, stageId);
    if (!paths || !['internal-model', 'internal-model-set'].includes(paths.authorityKind)) {
      fail('AIH_PROJECT_BINDING_INVALID', '项目缺少产物内部模型绑定：' + artifactId);
    }
    const schema = JSON.parse(await readFile(repositoryFile(root, registry.schema), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const validate = ajv.compile(schema);
    const collection = paths.authorityKind === 'internal-model-set';
    let members = collection
      ? await readCandidateSet(inputArgument, paths, registry.format)
      : [{ actor: null, data: parseCandidate(await readCandidate(inputArgument), registry.format) }];
    if (prepareCandidate) {
      const prepared = await prepareCandidate({
        root,
        project,
        manifest,
        stageId,
        artifactId,
        data: collection ? null : members[0].data,
        members,
        inputArgument,
        argumentValue,
      });
      if (!collection && prepared) members = [{ actor: null, data: prepared }];
    }
    for (const member of members) {
      if (!validate(member.data)) {
        const detail = (validate.errors || []).map((error) => (error.instancePath || '/') + ' ' + error.message).join('; ');
        fail('AIH_ARTIFACT_SCHEMA_FAILED', '候选结构化数据不符合 Schema' + (member.actor ? '（' + member.actor + '）' : '') + '：' + detail);
      }
    }
    const data = collection ? null : members[0].data;
    const preparedOutputs = await prepareOutputs({
      root,
      project,
      manifest,
      stageId,
      artifactId,
      data,
      members,
    });
    const staticOutputPaths = new Set(paths.outputPaths);
    const actualOutputPaths = new Set(preparedOutputs.map((item) => item.output));
    const requiredOutputPaths = new Set(staticOutputPaths);
    if (collection) for (const member of members) for (const binding of paths.memberOutputs || []) {
      requiredOutputPaths.add(binding.root + '/' + member.actor + '/' + binding.member);
    }
    const missingStaticOutputs = [...requiredOutputPaths].filter((path) => !actualOutputPaths.has(path));
    const invalidOutputs = preparedOutputs.filter((item) => {
      if (staticOutputPaths.has(item.output)) return false;
      return !(paths.memberOutputs || []).some((binding) => (
        members.some((member) => item.output === binding.root + '/' + member.actor + '/' + binding.member)
        && item.role === binding.role
        && item.projection === binding.projection
      ));
    });
    if (missingStaticOutputs.length > 0 || invalidOutputs.length > 0 || actualOutputPaths.size !== requiredOutputPaths.size) {
      fail('AIH_CONTRACT_INVALID', '领域适配器返回的输出与项目绑定不一致：' + artifactId);
    }
    const writes = [
      ...members.map((member) => ({
        target: collection ? artifactMemberPath(paths, member.actor) : paths.authorityPath,
        content: stringifyStructured(member.data, registry.format),
      })),
      ...preparedOutputs.map((item) => ({ target: item.output, content: item.content })),
    ];
    if (new Set(writes.map((item) => item.target)).size !== writes.length) {
      fail('AIH_PROJECT_BINDING_INVALID', '产物写入目标路径重复：' + artifactId);
    }
    const staleCollectionFiles = [];
    const ownedCollections = collection
      ? [{ root: paths.authorityRoot, member: paths.member }, ...(paths.memberOutputs || [])]
      : [];
    for (const binding of ownedCollections) {
      const dynamicRoot = repositoryFile(root, binding.root);
      const expected = new Set(preparedOutputs
        .filter((item) => item.output.startsWith(binding.root + '/') && item.output.endsWith('/' + binding.member))
        .map((item) => repositoryFile(root, item.output)));
      if (binding.root === paths.authorityRoot) {
        for (const member of members) expected.add(repositoryFile(root, artifactMemberPath(paths, member.actor)));
      }
      for (const path of staticOutputPaths) if (path.startsWith(binding.root + '/')) expected.add(repositoryFile(root, path));
      for (const existing of await filesBelow(dynamicRoot)) {
        if (!existing.endsWith('\\' + binding.member) && !existing.endsWith('/' + binding.member) && !expected.has(existing)) {
          fail('AIH_USER_CHANGE_COLLISION', '集合目录包含非受管文件，拒绝自动处理：' + binding.root);
        }
        if (!expected.has(existing)) staleCollectionFiles.push(existing);
      }
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
      await Promise.all(staleCollectionFiles.map(async (path) => {
        await rm(path, { force: true });
        try { await rmdir(dirname(path)); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
      }));
      result = {
        status: 'PASS',
        mode: 'commit',
        operation: operationId,
        artifact: artifactId,
        transactionId,
        authority: collection ? paths.authorityRoot : paths.authorityPath,
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
  else if (result.status === 'PASS') console.log('[PASS] YAML 权威模型与 Markdown 投影' + (dryRun ? '预检' : '写入') + '完成。');
  else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
  if (result.status !== 'PASS') process.exitCode = 1;
  return result;
}
