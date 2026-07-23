import { actorArgument, buildCandidate, failure } from './lib.mjs';

let result;
try {
  result = (await buildCandidate(actorArgument())).candidate;
} catch (error) {
  result = failure(error, 'generate-mockcase-candidate');
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;

