import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { normalizeRepositoryPath, readJson, readYaml } from './lib/repository.mjs';
import { EXECUTION_CONTEXTS, matchingScopes, resolvedPlan } from './lib/routing.mjs';

const args = process.argv.slice(2);
const paths = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--path' && args[index + 1]) paths.push(args[++index]);
}
const contextIndex = args.indexOf('--context');
const executionContext = contextIndex >= 0 ? args[contextIndex + 1] : 'local-edit';
const json = args.includes('--json');
const root = resolve(process.env.PSP_REPOSITORY_ROOT || process.cwd());
let result;

async function inputDigest(rootDirectory, normalizedPaths) {
  const entries = [];
  async function collect(relative) {
    const absolute = resolve(rootDirectory, ...relative.split('/'));
    try {
      const children = await readdir(absolute, { withFileTypes: true });
      for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
        await collect(relative + '/' + child.name);
      }
    } catch (error) {
      if (error.code === 'ENOTDIR') entries.push([relative, createHash('sha256').update(await readFile(absolute)).digest('hex')]);
      else if (error.code === 'ENOENT') entries.push([relative, 'MISSING']);
      else throw error;
    }
  }
  for (const path of normalizedPaths.slice().sort()) await collect(path);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

try {
  if (args.includes('--intent') || args.includes('--release')) {
    throw Object.assign(new Error('v3 不支持旧 resolver 参数；请使用 --context。'), { code: 'AIH_PROTOCOL_UNSUPPORTED' });
  }
  if (paths.length === 0 || !EXECUTION_CONTEXTS.includes(executionContext) || executionContext === 'handoff') {
    throw Object.assign(new Error('必须提供至少一个 --path；维护者上下文只允许 local-edit、explicit-consistency、pull-request、main 或 release。'), { code: 'AIH_EXECUTION_CONTEXT_INVALID' });
  }
  const project = await readYaml(root, 'psp.project.yaml');
  if (project.kind !== 'PSPScaffoldProject') {
    throw Object.assign(new Error('根项目不是脚手架项目。'), { code: 'AIH_SCAFFOLD_CONTEXT_INVALID' });
  }
  const manifest = await readJson(root, project.harness.manifest);
  if (
    project.harness.protocol !== 'pre-sdd-harness/v3'
    || manifest.standard?.protocol !== 'pre-sdd-harness/v3'
  ) {
    throw Object.assign(new Error('当前源码只支持 pre-sdd-harness/v3。'), { code: 'AIH_PROTOCOL_UNSUPPORTED' });
  }
  const selection = matchingScopes(manifest, paths, root);
  if (selection.blockers.length > 0) {
    result = { status: 'BLOCKED', protocol: manifest.standard.protocol, executionContext, scopes: selection.scopes.map((scope) => scope.id), profiles: [], plan: [], commandIds: [], commands: [], blockers: selection.blockers };
  } else {
    const normalizedPaths = paths.map((path) => normalizeRepositoryPath(path, root).path);
    const resolved = resolvedPlan(manifest, selection.scopes, executionContext, normalizedPaths, {
      inputDigest: await inputDigest(root, normalizedPaths),
      runtimeDigest: await inputDigest(root, ['package.json', 'package-lock.json', '.psp/harness/scripts', '.agents/skills']),
    });
    result = {
      status: resolved.blockers.length === 0 ? 'READY' : 'BLOCKED',
      protocol: manifest.standard.protocol,
      standardVersion: manifest.standard.version,
      executionContext,
      completionEligible: executionContext === 'release',
      scopes: selection.scopes.map((scope) => scope.id),
      profiles: resolved.profiles.map((profile) => profile.id),
      plan: resolved.plan,
      commandIds: resolved.plan.map((item) => item.commandId),
      commands: resolved.plan.map((item) => item.command),
      evidence: {
        plannedCommandCount: resolved.plan.length,
        executedCommandCount: 0,
        cacheHitCount: 0,
        notRunCount: 0,
        totalDurationMs: 0,
      },
      blockers: resolved.blockers,
    };
  }
} catch (error) {
  result = { status: 'BLOCKED', executionContext, scopes: [], profiles: [], plan: [], commandIds: [], commands: [], blockers: [{ code: error.code || 'AIH_MANIFEST_UNREADABLE', message: error.message }] };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'READY') for (const item of result.plan) console.log(item.command);
else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
if (result.status !== 'READY') process.exitCode = 1;
