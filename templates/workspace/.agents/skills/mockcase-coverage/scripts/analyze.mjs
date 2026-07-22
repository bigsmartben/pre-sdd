import { coverageCandidate, coverageReport, failure } from './lib.mjs';

let result;
try {
  result = coverageReport(await coverageCandidate());
} catch (error) {
  result = failure(error);
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
