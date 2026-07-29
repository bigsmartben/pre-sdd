import { readFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { repositoryFile } from '../../../runtime/project.mjs';
import {
  actorArgument,
  emptyMockCases,
  emptyMockData,
  failure,
  jsonText,
  suiteManifest,
  validateSuiteData,
  workspaceContext,
} from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
let result;
try {
  const actor = actorArgument();
  const context = await workspaceContext(actor);
  if (context.stage.status !== 'uninitialized') {
    throw Object.assign(new Error('mockcase Stage 已初始化。'), { code: 'AIH_STAGE_ALREADY_INITIALIZED' });
  }
  if (process.argv.includes('--receipt')) {
    throw Object.assign(new Error('MockCase 不再支持跨领域移交收据。'), {
      code: 'AIH_COMMAND_INVALID',
    });
  }
  const mockdata = emptyMockData(actor);
  const mockcases = emptyMockCases(actor);
  const suite = suiteManifest(actor, context.upstream, mockdata, mockcases);
  const projectPath = repositoryFile(context.root, 'psp.project.yaml');
  const project = parseYaml(await readFile(projectPath, 'utf8'));
  project.stages.mockcase.status = 'active';
  const writes = [
    { target: 'psp.project.yaml', content: stringifyYaml(project) },
    { target: context.files.suite, content: jsonText(suite) },
    { target: context.files.mockdata, content: jsonText(mockdata) },
    { target: context.files.mockcases, content: jsonText(mockcases) },
  ];
  const transactionId = dryRun ? null : await commitManagedWrites({
    root: context.root,
    ownerId: `mockcase-init-${actor}`,
    writes,
    afterReplace: async () => validateSuiteData(
      await workspaceContext(actor, { allowMissingSuite: false }),
      { requireCoverage: false },
    ),
  });
  result = {
    status: 'PASS',
    operation: 'initialize-mockcase',
    mode: dryRun ? 'dry-run' : 'commit',
    actor,
    transactionId,
    targets: writes.map((item) => item.target),
    downstreamAction: 'NOT_RUN',
    blockers: [],
  };
} catch (error) {
  result = failure(error, 'initialize-mockcase');
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
