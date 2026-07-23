import { actorArgument, buildCandidate, failure } from './lib.mjs';

let result;
try {
  const { candidate, context } = await buildCandidate(actorArgument());
  result = {
    schemaVersion: candidate.schemaVersion,
    status: candidate.status,
    actor: candidate.actor,
    scope: candidate.scope,
    inputLock: candidate.inputLock,
    existingCaseIds: context.mockcases.cases.map((item) => item.id).sort(),
    generatableCaseIds: candidate.mockCaseChanges.upsertCases.map((item) => item.id),
    coverageBefore: candidate.coverageBefore,
    coverageAfter: candidate.coverageAfter,
    gaps: candidate.gaps,
  };
} catch (error) {
  result = failure(error, 'analyze-mockcase');
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
