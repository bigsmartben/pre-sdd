import { readFile } from 'node:fs/promises';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { commitManagedWrites } from '../../../../.psp/harness/scripts/lib/artifact-transaction.mjs';
import { inspectReceipt } from '../../../../.psp/harness/scripts/run-handoff.mjs';
import { repositoryFile } from '../../../../.psp/harness/scripts/lib/repository.mjs';
import {
  actorArgument,
  argument,
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
  const receiptPath = argument('--receipt');
  if (receiptPath) {
    const receipt = await inspectReceipt(context.root, receiptPath);
    if (receipt.from !== 'canonical-ui-prototype' || receipt.to !== 'mockcase' || receipt.receipt?.status !== 'VALID') {
      throw Object.assign(new Error('可选 Handoff Receipt 必须是 canonical-ui-prototype -> mockcase 的当前 VALID Receipt。'), {
        code: receipt.receipt?.status === 'STALE' ? 'AIH_RECEIPT_STATE_INVALID' : 'AIH_HANDOFF_CONFIRMATION_INVALID',
      });
    }
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
