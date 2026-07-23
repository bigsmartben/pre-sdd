import { commitManagedWrites } from '../../../../.psp/harness/scripts/lib/artifact-transaction.mjs';
import {
  HOST_API_VERSION,
  actorArgument,
  compileSchemas,
  failure,
  jsonText,
  sha256,
  validateSuiteData,
  workspaceContext,
} from './lib.mjs';

function statesFor(model, matrix) {
  return model.stateAxes.filter((axis) => axis.componentContractId === matrix.componentContractId).flatMap((axis) => {
    const selected = axis.values.find((item) => item.id === matrix.values[axis.id]);
    return selected?.stateId ? [selected.stateId] : [];
  });
}

const dryRun = process.argv.includes('--dry-run');
let result;
try {
  const actor = actorArgument();
  const context = await workspaceContext(actor, { allowMissingSuite: false });
  if (context.stage.status === 'published') throw Object.assign(new Error('mockcase Stage 已锁定。'), { code: 'AIH_STAGE_LOCKED' });
  if (context.stage.status !== 'active') throw Object.assign(new Error('mockcase Stage 尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  await validateSuiteData(context);
  const runtime = {
    schemaVersion: '1.0.0',
    hostApiVersion: HOST_API_VERSION,
    actor,
    sourceDigests: {
      suite: sha256(jsonText(context.suite)),
      mockdata: context.suite.files['mockdata.json'],
      mockcases: context.suite.files['mockcases.json'],
      capabilities: context.upstream.capabilitiesDigest,
      canonicalUi: context.upstream.canonicalUiDigest,
    },
    routes: context.canonicalUi.routes.map(({ id, path }) => ({ id, path })),
    fixtures: context.mockdata.fixtures,
    behaviors: context.mockdata.behaviors,
    cases: context.mockcases.cases.map((item) => ({
      ...item,
      effects: item.effects.map((effect) => {
        const matrix = context.canonicalUi.stateMatrix.find((entry) => entry.id === effect.expectedStateMatrixEntryId);
        return { ...effect, expectedStateIds: statesFor(context.canonicalUi, matrix) };
      }),
    })),
  };
  const schemas = await compileSchemas(context.root);
  if (!schemas.runtime(runtime)) throw Object.assign(new Error('Runtime Bundle Schema 校验失败。'), { code: 'AIH_ARTIFACT_SCHEMA_FAILED' });
  const writes = [{ target: context.files.runtime, content: jsonText(runtime) }];
  const transactionId = dryRun ? null : await commitManagedWrites({
    root: context.root,
    ownerId: `mockcase-runtime-${actor}`,
    writes,
  });
  result = {
    status: 'PASS',
    operation: 'project-mockcase-runtime',
    mode: dryRun ? 'dry-run' : 'commit',
    actor,
    transactionId,
    output: context.files.runtime,
    runtimeDigest: sha256(jsonText(runtime)),
    lifecycle: 'MAPPED',
    blockers: [],
  };
} catch (error) {
  result = failure(error, 'project-mockcase-runtime');
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
