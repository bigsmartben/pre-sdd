import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { normalizeRepositoryPath } from '../../scripts/lib/repository.mjs';
import { resolveHarness, selectorPatterns } from '../../scripts/lib/routing.mjs';
import { cleanupTemporaryRepositories, codes, manifest, project, repositoryRoot, runScript, temporaryRepository } from '../helpers/fixture.mjs';

test.after(cleanupTemporaryRepositories);

async function mutateJson(path, mutation) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  mutation(value);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

test('repository-relative path normalization rejects traversal and absolute paths', () => {
  for (const path of ['../outside.md', '..\\outside.md', 'C:/outside.md', '/outside.md', '.psp/harness/*.mjs']) {
    assert.ok(normalizeRepositoryPath(path, repositoryRoot).error, path);
  }
});

test('domain Scope derives its paths from the registered repository domain Skill', () => {
  const scope = manifest.scopes.find((item) => item.id === 'product-framework');
  const domain = manifest.domainRegistry.find((item) => item.id === 'product-design');
  assert.equal(domain.root, '.agents/skills/' + domain.skill);
  assert.ok(manifest.codex.repositorySkills.includes(domain.root + '/SKILL.md'));
  const expected = [domain.root, ...(domain.mirrors || [])].flatMap((root) => [root, root + '/**']);
  assert.deepEqual(selectorPatterns(scope.selector, project, manifest), expected);
});

test('resolver routes a domain Skill change without treating it as Harness governance', () => {
  const result = resolveHarness(manifest, project, ['.agents/skills/product-design/SKILL.md'], 'change', repositoryRoot);
  assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
  assert.deepEqual(result.scopes, ['product-framework']);
});

test('resolver maps Canonical UI authority and projections to one artifact scope', () => {
  const active = structuredClone(project);
  active.stages['product-design'].status = 'active';
  const stage = active.stages['product-design'];
  const path = stage.root + '/' + stage.areas['canonical-ui-prototype'].root + '/src/spec/canonical-ui.ts';
  const result = resolveHarness(manifest, active, [path], 'change', repositoryRoot);
  assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
  assert.deepEqual(result.scopes, ['canonical-ui-prototype']);
  assert.deepEqual(result.upstreamScopes, ['product-overview', 'use-cases', 'wireflow']);
  assert.deepEqual(result.downstreamConsumers, []);
});

test('Use Cases is the only product handoff source for Architecture Design', () => {
  const active = structuredClone(project);
  active.stages['product-design'].status = 'active';
  const path = active.stages['product-design'].root + '/' + active.stages['product-design'].artifacts.capabilities.internalModel;
  const result = resolveHarness(manifest, active, [path], 'change', repositoryRoot);
  assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
  assert.deepEqual(result.scopes, ['use-cases']);
  assert.deepEqual(result.downstreamConsumers, ['wireflow', 'architecture-design']);
});

test('Harness validator accepts registered domains and rejects a vertical path outside its domain', async () => {
  const pass = runScript('.psp/harness/scripts/validate-harness.mjs', repositoryRoot, ['--json']);
  assert.equal(pass.exitCode, 0, JSON.stringify(pass.output, null, 2));
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.artifactRegistry.find((item) => item.id === 'product-package').schema = '.psp/harness/schemas/project.schema.json';
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_DOMAIN_BOUNDARY_INVALID'));
});

test('Harness does not require domain-semantic blocker codes', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.blockers = value.blockers.filter((item) => !['AIH_TECHNICAL_VALIDATION_FAILED', 'AIH_CANONICAL_UI_RUNTIME_FAILED'].includes(item.code));
  });
  const result = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
});

test('unknown Profile command is rejected by Harness governance', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.validationProfiles.find((item) => item.id === 'repository-harness').commands.push('unknown-command');
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_PROFILE_INVALID'));
});

test('handoff rejects unknown edges and reports uninitialized source without persistence', async () => {
  const root = await temporaryRepository();
  const invalid = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'wireflow', '--to', 'architecture-design', '--json']);
  assert.ok(codes(invalid).has('AIH_HANDOFF_EDGE_INVALID'));
  const uninitialized = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'architecture-design', '--json']);
  assert.ok(codes(uninitialized).has('AIH_STAGE_UNINITIALIZED'));
  const bound = parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
  assert.equal(bound.stages['architecture-design'].status, 'uninitialized');
});

test('handoff returns a transient PASS receipt without initializing downstream', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.commands.push({ id: 'fixture-pass', npmScript: 'fixture:pass', run: 'npm run fixture:pass', purpose: 'fixture', blocking: true, executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-pass.mjs' } });
    value.validationProfiles.find((item) => item.id === 'product-delivery').commands = ['fixture-pass'];
    for (const scopeId of ['product-overview', 'use-cases', 'wireflow']) {
      value.scopes.find((item) => item.id === scopeId).readinessProfile = 'product-delivery';
    }
  });
  const projectPath = resolve(root, 'psp.project.yaml');
  const bound = parseYaml(await readFile(projectPath, 'utf8'));
  bound.stages['product-design'].status = 'active';
  await writeFile(projectPath, stringifyYaml(bound));

  const result = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'architecture-design', '--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, 'PASS');
  assert.equal(result.output.from, 'use-cases');
  assert.equal(result.output.to, 'architecture-design');
  assert.equal(result.output.profile, 'product-delivery');
  assert.deepEqual(result.output.validation.map((item) => item.status), ['PASS']);
  assert.equal(result.output.downstreamAction, 'NOT_RUN');

  const unchanged = parseYaml(await readFile(projectPath, 'utf8'));
  assert.equal(unchanged.stages['architecture-design'].status, 'uninitialized');
});

test('handoff executes commands in manifest order and marks commands after failure NOT_RUN', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, 'package.json'), (value) => {
    value.scripts['fixture:pass'] = 'node -e "process.exit(0)"';
    value.scripts['fixture:fail'] = 'node -e "process.exit(7)"';
    value.scripts['fixture:notrun'] = 'node -e "process.exit(0)"';
  });
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.commands.push(
      { id: 'fixture-pass', npmScript: 'fixture:pass', run: 'npm run fixture:pass', purpose: 'fixture', blocking: true, executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-pass.mjs' } },
      { id: 'fixture-fail', npmScript: 'fixture:fail', run: 'npm run fixture:fail', purpose: 'fixture', blocking: true, executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-fail.mjs' } },
      { id: 'fixture-notrun', npmScript: 'fixture:notrun', run: 'npm run fixture:notrun', purpose: 'fixture', blocking: true, executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-pass.mjs' } },
    );
    value.validationProfiles.find((item) => item.id === 'product-delivery').commands = ['fixture-pass', 'fixture-fail', 'fixture-notrun'];
    for (const scopeId of ['product-overview', 'use-cases', 'wireflow']) {
      value.scopes.find((item) => item.id === scopeId).readinessProfile = 'product-delivery';
    }
  });
  const projectPath = resolve(root, 'psp.project.yaml');
  const bound = parseYaml(await readFile(projectPath, 'utf8'));
  bound.stages['product-design'].status = 'active';
  await writeFile(projectPath, stringifyYaml(bound));
  const result = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'architecture-design', '--json']);
  assert.equal(result.output.status, 'FAIL');
  assert.deepEqual(result.output.validation.map((item) => item.status), ['PASS', 'FAIL', 'NOT_RUN']);
  assert.equal(result.output.downstreamAction, 'NOT_RUN');
});

test('generic stage initialization rolls back copied templates when a registered domain command fails', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, 'package.json'), (value) => {
    value.scripts['fixture:pass'] = 'node -e "process.exit(0)"';
    value.scripts['fixture:fail'] = 'node -e "process.exit(9)"';
  });
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.commands.push(
      { id: 'fixture-pass', npmScript: 'fixture:pass', run: 'npm run fixture:pass', purpose: 'fixture', blocking: true, executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-pass.mjs' } },
      { id: 'fixture-fail', npmScript: 'fixture:fail', run: 'npm run fixture:fail', purpose: 'fixture', blocking: true, executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-fail.mjs' } },
    );
    value.operations.find((item) => item.id === 'initialize-product').commands = ['fixture-pass', 'fixture-fail'];
  });
  const result = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.notEqual(result.exitCode, 0);
  const bound = parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
  assert.equal(bound.stages['product-design'].status, 'uninitialized');
  const files = await readdir(resolve(root, bound.stages['product-design'].root));
  assert.deepEqual(files, ['.gitkeep']);
});
