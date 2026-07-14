import { resolveHarness } from './lib/routing.mjs';
import { loadProjectAndManifest, repositoryRootFrom } from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const args = process.argv.slice(2);
const paths = [];
let intent = 'change';
let json = false;

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (argument === '--path' && args[index + 1]) paths.push(args[++index]);
  else if (argument === '--intent' && args[index + 1]) intent = args[++index];
  else if (argument === '--json') json = true;
}

let result;
try {
  const loaded = await loadProjectAndManifest(root);
  result = resolveHarness(loaded.manifest, loaded.project, paths, intent, root);
} catch (error) {
  const code = error.code || (String(error.message).includes('psp.project') ? 'AIH_PROJECT_BINDING_INVALID' : 'AIH_MANIFEST_UNREADABLE');
  result = {
    status: 'BLOCKED',
    scopes: [],
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
