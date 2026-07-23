import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../../.psp/harness/scripts/lib/artifact-transaction.mjs';
import {
  actorArgument,
  argument,
  compileSchemas,
  compositeDigest,
  failure,
  jsonText,
  sha256,
  stableJson,
  suiteManifest,
  validateSuiteData,
  workspaceContext,
} from './lib.mjs';

function merged(current, upserts, removals) {
  const remove = new Set(removals);
  const next = new Map(current.filter((item) => !remove.has(item.id)).map((item) => [item.id, item]));
  for (const item of upserts) next.set(item.id, item);
  return [...next.values()].sort((a, b) => a.id.localeCompare(b.id));
}

const dryRun = process.argv.includes('--dry-run');
let result;
try {
  const actor = actorArgument();
  const input = argument('--input');
  if (!input) throw Object.assign(new Error('Apply 必须提供 --input <candidate.json>。'), { code: 'AIH_COMMAND_INVALID' });
  const context = await workspaceContext(actor);
  if (context.stage.status !== 'active') throw Object.assign(new Error('mockcase Stage 必须为 active。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  const candidate = JSON.parse(await readFile(resolve(process.cwd(), input), 'utf8'));
  const schemas = await compileSchemas(context.root);
  if (!schemas.candidate(candidate)) {
    throw Object.assign(new Error('Candidate Schema 校验失败：' + JSON.stringify(schemas.candidate.errors)), { code: 'AIH_ARTIFACT_SCHEMA_FAILED' });
  }
  if (candidate.actor !== actor || candidate.status !== 'PASS' || candidate.gaps.length > 0) {
    throw Object.assign(new Error('Candidate Actor、状态或 Gap 不允许 Apply。'), { code: 'AIH_MOCKCASE_UPSTREAM_GAP' });
  }
  const { candidateHash, ...body } = candidate;
  if (candidateHash !== sha256(stableJson(body))) {
    throw Object.assign(new Error('Candidate Hash 与内容不匹配。'), { code: 'AIH_MOCKCASE_CANDIDATE_STALE' });
  }
  if (
    candidate.inputLock.capabilitiesDigest !== context.upstream.capabilitiesDigest
    || candidate.inputLock.canonicalUiDigest !== context.upstream.canonicalUiDigest
    || candidate.inputLock.suiteDigest !== context.suiteDigest
  ) throw Object.assign(new Error('Candidate 输入或目标 Suite 已漂移。'), { code: 'AIH_MOCKCASE_CANDIDATE_STALE' });

  const mockdata = {
    ...context.mockdata,
    fixtures: merged(context.mockdata.fixtures, candidate.mockDataChanges.upsertFixtures, candidate.mockDataChanges.removeFixtureIds),
    behaviors: merged(context.mockdata.behaviors, candidate.mockDataChanges.upsertBehaviors, candidate.mockDataChanges.removeBehaviorIds),
  };
  const mockcases = {
    ...context.mockcases,
    cases: merged(context.mockcases.cases, candidate.mockCaseChanges.upsertCases, candidate.mockCaseChanges.removeCaseIds),
  };
  const suite = suiteManifest(actor, context.upstream, mockdata, mockcases);
  const nextContext = { ...context, suite, mockdata, mockcases, suiteDigest: compositeDigest(suite, mockdata, mockcases) };
  await validateSuiteData(nextContext);
  const writes = [
    { target: context.files.suite, content: jsonText(suite) },
    { target: context.files.mockdata, content: jsonText(mockdata) },
    { target: context.files.mockcases, content: jsonText(mockcases) },
  ];
  const transactionId = dryRun ? null : await commitManagedWrites({
    root: context.root,
    ownerId: `mockcase-suite-${actor}`,
    writes,
    afterReplace: async () => validateSuiteData(await workspaceContext(actor, { allowMissingSuite: false })),
  });
  result = {
    status: 'PASS',
    operation: 'apply-mockcase-candidate',
    mode: dryRun ? 'dry-run' : 'commit',
    actor,
    transactionId,
    targets: writes.map((item) => item.target),
    suiteDigest: nextContext.suiteDigest,
    lifecycle: 'MAPPED',
    reviewEvidence: 'STALE',
    blockers: [],
  };
} catch (error) {
  result = failure(error, 'apply-mockcase-candidate');
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
