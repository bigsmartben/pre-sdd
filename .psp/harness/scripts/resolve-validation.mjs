import { resolve } from 'node:path';
import { readJson, readYaml } from './lib/repository.mjs';
import { matchingScopes, resolvedProfiles } from './lib/routing.mjs';

const args = process.argv.slice(2);
const paths = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--path' && args[index + 1]) paths.push(args[++index]);
}
const intentIndex = args.indexOf('--intent');
const intent = intentIndex >= 0 ? args[intentIndex + 1] : 'change';
const json = args.includes('--json');
const root = resolve(process.env.PSP_REPOSITORY_ROOT || process.cwd());
let result;

try {
  if (paths.length === 0 || !['change', 'checkpoint', 'readiness'].includes(intent)) {
    throw Object.assign(new Error('必须提供至少一个 --path，且 --intent 只能是 change、checkpoint 或 readiness。'), { code: 'AIH_PATH_INVALID' });
  }
  const project = await readYaml(root, 'psp.project.yaml');
  if (project.kind !== 'PSPScaffoldProject') {
    throw Object.assign(new Error('根项目不是脚手架项目。'), { code: 'AIH_SCAFFOLD_CONTEXT_INVALID' });
  }
  const manifest = await readJson(root, project.harness.manifest);
  const selection = matchingScopes(manifest, paths, root);
  if (selection.blockers.length > 0) {
    result = { status: 'BLOCKED', scopes: selection.scopes.map((scope) => scope.id), profiles: [], commandIds: [], commands: [], blockers: selection.blockers };
  } else {
    const resolved = resolvedProfiles(manifest, selection.scopes, intent);
    result = {
      status: 'READY',
      intent,
      completionEligible: intent === 'readiness',
      scopes: selection.scopes.map((scope) => scope.id),
      upstreamScopes: [],
      downstreamConsumers: [],
      upstreamProfiles: [],
      upstreamCommandIds: [],
      upstreamCommands: [],
      profiles: resolved.profiles.map((profile) => profile.id),
      commandIds: resolved.commands.map((command) => command.id),
      commands: resolved.commands.map((command) => command.run),
      blockers: [],
    };
  }
} catch (error) {
  result = { status: 'BLOCKED', scopes: [], profiles: [], commandIds: [], commands: [], blockers: [{ code: error.code || 'AIH_MANIFEST_UNREADABLE', message: error.message }] };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'READY') for (const command of result.commands) console.log(command);
else for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
if (result.status !== 'READY') process.exitCode = 1;
