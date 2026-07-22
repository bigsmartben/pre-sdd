import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { cleanupTemporaryRepositories, codes, runScript, temporaryRepository } from '../../product-design/tests/helpers/fixture.mjs';
import { completeProductFixture, fixtureProject } from '../../product-design/tests/helpers/product-fixture.mjs';
import { stableJson } from '../scripts/lib.mjs';

test.after(cleanupTemporaryRepositories);

async function canonicalPath(root) {
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  return resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root, 'ACTOR-001', 'src/spec/canonical-ui.ts');
}

function outsideMockCases(source) {
  return source.replace(/(?:"mockCases"|mockCases)\s*:\s*\[[\s\S]*?\](?=,\s*(?:"viewports"|viewports)\s*:)/, 'mockCases: <candidate-owned>');
}

test('mockcase-coverage analysis is read-only and generation is deterministic', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const canonical = await canonicalPath(root);
  const project = await fixtureProject(root);
  const capabilities = resolve(root, project.stages['product-design'].root, project.stages['product-design'].artifacts.capabilities.internalModel);
  const beforeCanonical = await readFile(canonical, 'utf8');
  const beforeCapabilities = await readFile(capabilities, 'utf8');

  const analyze = runScript('.agents/skills/mockcase-coverage/scripts/analyze.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  assert.equal(analyze.exitCode, 0, JSON.stringify(analyze.output, null, 2));
  assert.deepEqual(analyze.output.coverageBefore, { requiredScenarios: 3, coveredScenarios: 2 });
  assert.deepEqual(analyze.output.coverageAfter, { requiredScenarios: 3, coveredScenarios: 3 });
  assert.deepEqual(analyze.output.generatableScenarioIds, ['SCENARIO-003']);
  assert.match(analyze.output.inputHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(analyze.output.targetModelHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(await readFile(canonical, 'utf8'), beforeCanonical);
  assert.equal(await readFile(capabilities, 'utf8'), beforeCapabilities);

  const routeScope = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--route', 'ROUTE-001', '--json']);
  const useCaseScope = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--use-case', 'UC-001', '--json']);
  assert.equal(routeScope.exitCode, 0, JSON.stringify(routeScope.output, null, 2));
  assert.equal(useCaseScope.exitCode, 0, JSON.stringify(useCaseScope.output, null, 2));
  assert.deepEqual(routeScope.output.scope.routeIds, ['ROUTE-001']);
  assert.deepEqual(useCaseScope.output.scope.useCaseIds, ['UC-001']);

  const first = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  const second = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  assert.equal(first.exitCode, 0, JSON.stringify(first.output, null, 2));
  assert.deepEqual(second.output, first.output);
  assert.equal(first.output.generatedCases[0].kind, 'business');
  assert.equal(first.output.generatedCases[0].scenarioId, 'SCENARIO-003');
  assert.ok(first.output.existingCaseIds.includes('MOCK-CASE-SUCCESS'));
  assert.equal(first.output.existingCaseIds.includes('MOCK-CASE-DEFAULT'), false, 'technical Case must not count as business coverage');
});

test('Product Design apply operation atomically maps a fresh candidate and preserves non-MockCase source bytes', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const canonical = await canonicalPath(root);
  const before = await readFile(canonical, 'utf8');
  const generated = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--scenario', 'SCENARIO-003', '--json']);
  assert.equal(generated.exitCode, 0, JSON.stringify(generated.output, null, 2));
  const candidatePath = resolve(root, '.psp/mockcase-candidate.json');
  await writeFile(candidatePath, JSON.stringify(generated.output, null, 2) + '\n');

  const dryRun = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/apply-mockcase-candidate.mjs', root, ['--actor', 'ACTOR-001', '--input', candidatePath, '--dry-run', '--json']);
  assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun.output, null, 2));
  assert.equal(await readFile(canonical, 'utf8'), before);

  const applied = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/apply-mockcase-candidate.mjs', root, ['--actor', 'ACTOR-001', '--input', candidatePath, '--json']);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));
  assert.equal(applied.output.lifecycle, 'MAPPED');
  assert.equal(applied.output.reviewEvidence, 'STALE');
  assert.deepEqual(applied.output.validation, [{ id: 'canonical-ui-input', status: 'PASS', blockers: [] }]);
  const after = await readFile(canonical, 'utf8');
  assert.equal(outsideMockCases(after), outsideMockCases(before));
  assert.match(after, /MOCK-CASE-SCENARIO-003/);
  assert.match(after, /MOCK-CASE-SUCCESS/);
  assert.match(after, /MOCK-CASE-ERROR/);

  const repeated = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  assert.equal(repeated.exitCode, 0, JSON.stringify(repeated.output, null, 2));
  assert.deepEqual(repeated.output.coverageBefore, { requiredScenarios: 3, coveredScenarios: 3 });
  assert.deepEqual(repeated.output.generatedCases, []);
});

test('stale candidates, published stages and upstream gaps block without partial writes', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const canonical = await canonicalPath(root);
  const generated = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  assert.equal(generated.exitCode, 0, JSON.stringify(generated.output, null, 2));
  const candidatePath = resolve(root, '.psp/mockcase-candidate.json');
  await writeFile(candidatePath, JSON.stringify(generated.output, null, 2) + '\n');
  const unchanged = await readFile(canonical, 'utf8');
  const malformed = structuredClone(generated.output);
  delete malformed.actor;
  await writeFile(candidatePath, JSON.stringify(malformed, null, 2) + '\n');
  const schemaBlocked = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/apply-mockcase-candidate.mjs', root, ['--actor', 'ACTOR-001', '--input', candidatePath, '--json']);
  assert.ok(codes(schemaBlocked).has('AIH_ARTIFACT_SCHEMA_FAILED'), JSON.stringify(schemaBlocked.output, null, 2));
  assert.equal(await readFile(canonical, 'utf8'), unchanged);

  const tampered = structuredClone(generated.output);
  tampered.generatedCases[0].effects[0].targetInstanceId = 'COMPONENT-INSTANCE-TAMPERED';
  const { candidateHash: _discardedHash, ...tamperedBody } = tampered;
  tampered.candidateHash = 'sha256:' + createHash('sha256').update(stableJson(tamperedBody)).digest('hex');
  await writeFile(candidatePath, JSON.stringify(tampered, null, 2) + '\n');
  const tamperBlocked = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/apply-mockcase-candidate.mjs', root, ['--actor', 'ACTOR-001', '--input', candidatePath, '--json']);
  assert.ok(codes(tamperBlocked).has('AIH_MOCKCASE_CANDIDATE_STALE'), JSON.stringify(tamperBlocked.output, null, 2));
  assert.equal(await readFile(canonical, 'utf8'), unchanged);

  await writeFile(candidatePath, JSON.stringify(generated.output, null, 2) + '\n');
  const lockPath = resolve(root, '.psp/transactions/mockcase-coverage.lock');
  await mkdir(resolve(root, '.psp/transactions'), { recursive: true });
  await writeFile(lockPath, '{"owner":"other-process"}\n');
  const collision = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/apply-mockcase-candidate.mjs', root, ['--actor', 'ACTOR-001', '--input', candidatePath, '--json']);
  assert.ok(codes(collision).has('AIH_USER_CHANGE_COLLISION'), JSON.stringify(collision.output, null, 2));
  assert.equal(await readFile(lockPath, 'utf8'), '{"owner":"other-process"}\n');
  await rm(lockPath);
  const changed = (await readFile(canonical, 'utf8')).replace('"label": "Default"', '"label": "Default updated"');
  await writeFile(canonical, changed);
  const stale = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/apply-mockcase-candidate.mjs', root, ['--actor', 'ACTOR-001', '--input', candidatePath, '--json']);
  assert.ok(codes(stale).has('AIH_MOCKCASE_CANDIDATE_STALE'), JSON.stringify(stale.output, null, 2));
  assert.equal(await readFile(canonical, 'utf8'), changed);

  const fresh = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  assert.equal(fresh.exitCode, 0, JSON.stringify(fresh.output, null, 2));
  await writeFile(candidatePath, JSON.stringify(fresh.output, null, 2) + '\n');
  const projectPath = resolve(root, 'psp.project.yaml');
  const project = parseYaml(await readFile(projectPath, 'utf8'));
  project.stages['product-design'].status = 'published';
  await writeFile(projectPath, stringifyYaml(project));
  const publishedAnalysis = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  assert.equal(publishedAnalysis.exitCode, 0, JSON.stringify(publishedAnalysis.output, null, 2));
  const locked = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/apply-mockcase-candidate.mjs', root, ['--actor', 'ACTOR-001', '--input', candidatePath, '--json']);
  assert.ok(codes(locked).has('AIH_STAGE_LOCKED'));

  project.stages['product-design'].status = 'active';
  await writeFile(projectPath, stringifyYaml(project));
  const capabilitiesPath = resolve(root, project.stages['product-design'].root, project.stages['product-design'].artifacts.capabilities.internalModel);
  const capabilities = parseYaml(await readFile(capabilitiesPath, 'utf8'));
  capabilities.metadata.status = 'draft';
  await writeFile(capabilitiesPath, stringifyYaml(capabilities));
  const unready = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--json']);
  assert.equal(unready.output.status, 'BLOCKED');
  assert.ok(unready.output.gaps.some((item) => item.code === 'AIH_MOCKCASE_UPSTREAM_GAP' && item.targetArtifact === 'capabilities'));
  capabilities.metadata.status = 'ready';
  await writeFile(capabilitiesPath, stringifyYaml(capabilities));
  const missingState = (await readFile(canonical, 'utf8')).replace('"expectedStateIds": [\n        "COMPONENT-STATE-DEFAULT",\n        "INT-STATE-001"\n      ]', '"expectedStateIds": [\n        "COMPONENT-STATE-NOT-MAPPED"\n      ]');
  await writeFile(canonical, missingState);
  const blocked = runScript('.agents/skills/mockcase-coverage/scripts/generate.mjs', root, ['--actor', 'ACTOR-001', '--scenario', 'SCENARIO-003', '--json']);
  assert.equal(blocked.output.status, 'BLOCKED');
  assert.ok(blocked.output.gaps.some((item) => item.code === 'AIH_MOCKCASE_UPSTREAM_GAP' && item.targetArtifact === 'capabilities' && item.targetOperation === 'apply-product-artifact'));
});
