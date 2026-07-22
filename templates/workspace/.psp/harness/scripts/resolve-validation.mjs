import { resolveHarness } from './lib/routing.mjs';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadProjectAndManifest, normalizeRepositoryPath, repositoryRootFrom } from './lib/repository.mjs';
import { selectorPatterns } from './lib/routing.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const args = process.argv.slice(2);
const paths = [];
let executionContext = 'local-edit';
let json = false;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--path' && args[index + 1]) paths.push(args[++index]);
  else if (argument === '--context' && args[index + 1]) executionContext = args[++index];
  else if (argument === '--json') json = true;
}

let result;
async function digestInputs(paths) {
  const entries = [];
  async function collect(relative) {
    const absolute = resolve(root, ...relative.split('/'));
    try {
      const children = await readdir(absolute, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) await collect(relative + '/' + child.name);
    } catch (error) {
      if (error.code === 'ENOTDIR') entries.push([relative, createHash('sha256').update(await readFile(absolute)).digest('hex')]);
      else if (error.code === 'ENOENT') entries.push([relative, 'MISSING']);
      else throw error;
    }
  }
  for (const path of paths.slice().sort()) await collect(path);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

async function executorDigests(manifest) {
  const output = {};
  for (const command of manifest.commands || []) {
    const paths = command.executor?.kind === 'module'
      ? [command.executor.path]
      : command.executor?.kind === 'node-test'
        ? [...new Set((command.executor.paths || []).map((path) => path.slice(0, path.lastIndexOf('/'))))]
        : [];
    const contentDigest = await digestInputs(paths);
    output[command.id] = createHash('sha256').update(JSON.stringify({ executor: command.executor, contentDigest })).digest('hex');
  }
  return output;
}

function concreteDependencyPaths(manifest, project, scopeIds) {
  const candidates = scopeIds.flatMap((id) => {
    const scope = manifest.scopes.find((item) => item.id === id);
    return scope ? selectorPatterns(scope.selector, project, manifest) : [];
  }).filter((path) => !/[*!?\[\]{}]/.test(path));
  return [...new Set(candidates)].filter((path, index, paths) =>
    !paths.some((candidate, candidateIndex) => candidateIndex !== index && path.startsWith(candidate + '/')),
  );
}
try {
  if (args.includes('--intent') || args.includes('--release')) {
    throw Object.assign(new Error('v3 不支持旧 resolver 参数；请使用 --context。'), { code: 'AIH_PROTOCOL_UNSUPPORTED' });
  }
  const loaded = await loadProjectAndManifest(root);
  const normalized = paths.map((path) => normalizeRepositoryPath(path, root)).filter((item) => !item.error).map((item) => item.path);
  const inputDigest = await digestInputs(normalized);
  const runtimeContentDigest = await digestInputs(['package.json', 'package-lock.json']);
  const runtimeDigest = createHash('sha256').update(JSON.stringify({ runtime: loaded.manifest.runtime, runtimeContentDigest })).digest('hex');
  const digests = await executorDigests(loaded.manifest);
  const initial = resolveHarness(loaded.manifest, loaded.project, paths, executionContext, root, {
    inputDigest,
    runtimeDigest,
    executorDigests: digests,
  });
  const dependencyPaths = concreteDependencyPaths(loaded.manifest, loaded.project, initial.upstreamScopes);
  result = resolveHarness(loaded.manifest, loaded.project, paths, executionContext, root, {
    inputDigest,
    runtimeDigest,
    executorDigests: digests,
    dependencyDigest: await digestInputs(dependencyPaths),
  });
} catch (error) {
  const code = error.code || (String(error.message).includes('psp.project') ? 'AIH_PROJECT_BINDING_INVALID' : 'AIH_MANIFEST_UNREADABLE');
  result = {
    status: 'BLOCKED',
    scopes: [],
    upstreamScopes: [],
    downstreamConsumers: [],
    upstreamProfiles: [],
    upstreamCommandIds: [],
    upstreamCommands: [],
    profiles: [],
    commandIds: [],
    commands: [],
    blockers: [{
      code,
      severity: 'blocker',
      owner: 'repository-harness',
      meaning: code === 'AIH_PROJECT_BINDING_INVALID' ? '项目绑定无效' : 'Harness manifest 无法读取',
      message: error.message,
    }],
  };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'READY') console.log('READY ' + result.scopes.join(', ') + ' -> ' + result.commands.join(' && '));
else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + (blocker.message || blocker.meaning));

if (result.status === 'BLOCKED') process.exitCode = 1;
