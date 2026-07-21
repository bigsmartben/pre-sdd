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
  const path = stage.root + '/' + stage.areas['canonical-ui-prototypes'].root + '/ACTOR-001/src/spec/canonical-ui.ts';
  const result = resolveHarness(manifest, active, [path], 'change', repositoryRoot);
  assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
  assert.deepEqual(result.scopes, ['canonical-ui-prototype']);
  assert.deepEqual(result.upstreamScopes, ['use-cases', 'visual-spec']);
  assert.deepEqual(result.downstreamConsumers, []);
});

test('Harness registers one dedicated Figma Asset Ingest operation and rejects executor drift', async () => {
  const operation = manifest.operations.find((item) => item.id === 'ingest-figma-assets');
  assert.equal(operation.kind, 'ingest');
  assert.equal(operation.artifact, 'canonical-ui-prototype');
  assert.equal(operation.executor.path, '.agents/skills/capture-figma-design-source/scripts/ingest-assets.mjs');
  assert.deepEqual(Object.keys(operation.packetSchemas).sort(), ['acquisition', 'capturePlan', 'receipt', 'registration']);

  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.operations.find((item) => item.id === 'ingest-figma-assets').executor.path = '.psp/harness/scripts/init-workspace.mjs';
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_COMMAND_INVALID'), JSON.stringify(invalid.output, null, 2));
});

test('resolver makes published stages readable but requires Reopen before change', () => {
  const published = structuredClone(project);
  published.stages['product-design'].status = 'published';
  const stage = published.stages['product-design'];
  const path = stage.root + '/' + stage.areas['canonical-ui-prototypes'].root + '/ACTOR-001/src/spec/canonical-ui.ts';
  const change = resolveHarness(manifest, published, [path], 'change', repositoryRoot);
  assert.equal(change.status, 'BLOCKED');
  assert.ok(change.blockers.some((item) => item.code === 'AIH_STAGE_LOCKED'));
  const readiness = resolveHarness(manifest, published, [path], 'readiness', repositoryRoot);
  assert.equal(readiness.status, 'READY', JSON.stringify(readiness.blockers));
});

test('Use Cases hands off to Visual Spec and Visual Spec hands off to Canonical UI Prototype', () => {
  const active = structuredClone(project);
  active.stages['product-design'].status = 'active';
  const stage = active.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  const authority = resolveHarness(manifest, active, [stage.root + '/' + binding.internalModel], 'change', repositoryRoot);
  assert.equal(authority.status, 'READY', JSON.stringify(authority.blockers));
  assert.deepEqual(authority.scopes, ['use-cases']);
  assert.deepEqual(authority.upstreamScopes, []);
  assert.deepEqual(authority.downstreamConsumers, ['visual-spec']);
  for (const output of binding.outputs) {
    const projection = resolveHarness(manifest, active, [stage.root + '/' + output.path], 'change', repositoryRoot);
    assert.equal(projection.status, 'BLOCKED');
    assert.deepEqual(projection.scopes, ['use-cases']);
    assert.ok(projection.blockers.some((blocker) => blocker.code === 'AIH_GENERATED_DRIFT'));
  }

  const visualBinding = stage.artifacts['visual-spec'];
  const visualAuthority = resolveHarness(manifest, active, [stage.root + '/' + visualBinding.internalModel], 'change', repositoryRoot);
  assert.equal(visualAuthority.status, 'READY', JSON.stringify(visualAuthority.blockers));
  assert.deepEqual(visualAuthority.scopes, ['visual-spec']);
  assert.deepEqual(visualAuthority.upstreamScopes, ['use-cases']);
  assert.deepEqual(visualAuthority.downstreamConsumers, ['canonical-ui-prototype']);
  for (const output of visualBinding.outputs) {
    const projection = resolveHarness(manifest, active, [stage.root + '/' + output.path], 'change', repositoryRoot);
    assert.equal(projection.status, 'BLOCKED');
    assert.deepEqual(projection.scopes, ['visual-spec']);
    assert.ok(projection.blockers.some((blocker) => blocker.code === 'AIH_GENERATED_DRIFT'));
  }
});

test('project DAG is the only source of dependency and handoff relationships', () => {
  assert.ok(manifest.projectDag.nodes.some((node) => node.id === 'architecture-design' && node.kind === 'stage'));
  assert.ok(manifest.projectDag.nodes.some((node) => node.id === 'use-cases' && node.kind === 'artifact'));
  assert.ok(manifest.projectDag.edges.some((edge) => edge.from === 'use-cases' && edge.to === 'visual-spec' && edge.type === 'handoff'));
  for (const edge of manifest.projectDag.edges) assert.equal(edge.conditions.sourceReadiness, 'required');
  for (const scope of manifest.scopes) {
    assert.equal('dependencies' in scope, false, scope.id);
    assert.equal('handoffConsumers' in scope, false, scope.id);
    assert.equal('externalConsumers' in scope, false, scope.id);
  }
  for (const operation of manifest.operations) {
    assert.equal('upstreamScopes' in operation, false, operation.id);
    assert.equal('upstreamHandoff' in operation, false, operation.id);
  }
});

test('resolver uses artifact-level Architecture Design dependencies and readiness profiles', () => {
  const active = structuredClone(project);
  active.stages['architecture-design'].status = 'active';
  const stage = active.stages['architecture-design'];
  const pathFor = (artifactId) => stage.root + '/' + stage.artifacts[artifactId].internalModel;

  const systemBoundary = resolveHarness(manifest, active, [pathFor('system-boundary')], 'readiness', repositoryRoot);
  assert.deepEqual(systemBoundary.scopes, ['system-boundary']);
  assert.deepEqual(systemBoundary.upstreamScopes, []);
  assert.ok(systemBoundary.commandIds.includes('architecture-system-boundary'));

  const conceptualModel = resolveHarness(manifest, active, [pathFor('conceptual-model')], 'readiness', repositoryRoot);
  assert.deepEqual(conceptualModel.scopes, ['conceptual-model']);
  assert.deepEqual(conceptualModel.upstreamScopes, ['system-boundary']);
  assert.ok(conceptualModel.commandIds.includes('architecture-conceptual-model'));

  const technicalArea = stage.root + '/' + stage.areas['technical-validation'].root + '/cases/EXP-001.case.mjs';
  const technicalValidation = resolveHarness(manifest, active, [technicalArea], 'change', repositoryRoot);
  assert.deepEqual(technicalValidation.scopes, ['technical-validation']);
  assert.deepEqual(technicalValidation.upstreamScopes, ['system-boundary']);
  assert.ok(!technicalValidation.commandIds.includes('architecture-strict'));

  const architecturePackage = resolveHarness(manifest, active, [pathFor('architecture-package')], 'readiness', repositoryRoot);
  assert.deepEqual(architecturePackage.scopes, ['architecture-package']);
  assert.deepEqual(architecturePackage.upstreamScopes, ['system-boundary', 'conceptual-model', 'technical-validation']);
  assert.ok(architecturePackage.commandIds.includes('architecture-package-readiness'));
});

test('Harness rejects reintroduced Product Design lifecycle coupling from Architecture Design', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.projectDag.edges.push({
      from: 'use-cases',
      to: 'architecture-design',
      type: 'dependency',
      conditions: { sourceReadiness: 'required' },
    });
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_HARNESS_COUPLED'));
});

test('Harness reports stable DAG blockers for unknown nodes, conflicting edges, and cycles', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.projectDag.edges.push(
      { from: 'unknown-source', to: 'visual-spec', type: 'dependency', conditions: { sourceReadiness: 'required' } },
      { from: 'use-cases', to: 'visual-spec', type: 'dependency', conditions: { sourceReadiness: 'required' } },
      { from: 'visual-spec', to: 'use-cases', type: 'dependency', conditions: { sourceReadiness: 'required' } },
    );
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  const blockerCodes = codes(invalid);
  assert.ok(blockerCodes.has('AIH_DAG_NODE_UNKNOWN'));
  assert.ok(blockerCodes.has('AIH_DAG_EDGE_CONFLICT'));
  assert.ok(blockerCodes.has('AIH_DAG_CYCLE'));
});

test('Harness validator accepts registered domains and rejects a vertical path outside its domain', async () => {
  const pass = runScript('.psp/harness/scripts/validate-harness.mjs', repositoryRoot, ['--json']);
  assert.equal(pass.exitCode, 0, JSON.stringify(pass.output, null, 2));
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.artifactRegistry.find((item) => item.id === 'capabilities').schema = '.psp/harness/schemas/project.schema.json';
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_DOMAIN_BOUNDARY_INVALID'));
});

test('Harness accepts only the registered UC human projection binding', async () => {
  const root = await temporaryRepository();
  const projectPath = resolve(root, 'psp.project.yaml');
  const bound = parseYaml(await readFile(projectPath, 'utf8'));
  assert.deepEqual(bound.stages['product-design'].artifacts.capabilities.outputs, [{
    path: 'UC.md',
    role: 'user-artifact',
    projection: 'use-cases-document',
  }]);
  bound.stages['product-design'].artifacts.capabilities.outputs[0].projection = 'unknown-use-cases-view';
  await writeFile(projectPath, stringifyYaml(bound));
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_PROJECT_BINDING_INVALID'));
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

test('handoff rejects unknown nodes and unreachable edges, then reports uninitialized source without persistence', async () => {
  const root = await temporaryRepository();
  const unknown = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'unknown-source', '--to', 'visual-spec', '--json']);
  assert.ok(codes(unknown).has('AIH_DAG_NODE_UNKNOWN'));
  const invalid = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'canonical-ui-prototype', '--to', 'architecture-design', '--json']);
  assert.ok(codes(invalid).has('AIH_HANDOFF_UNREACHABLE'));
  const uninitialized = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'visual-spec', '--json']);
  assert.ok(codes(uninitialized).has('AIH_STAGE_UNINITIALIZED'));
  const bound = parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
  assert.equal(bound.stages['architecture-design'].status, 'uninitialized');
});

test('handoff returns a transient PASS receipt without initializing downstream', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.commands.push({ id: 'fixture-pass', npmScript: 'fixture:pass', run: 'npm run fixture:pass', purpose: 'fixture', blocking: true, executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-pass.mjs' } });
    value.validationProfiles.find((item) => item.id === 'product-delivery').commands = ['fixture-pass'];
    for (const scopeId of ['use-cases', 'visual-spec']) {
      value.scopes.find((item) => item.id === scopeId).readinessProfile = 'product-delivery';
    }
  });
  const projectPath = resolve(root, 'psp.project.yaml');
  const bound = parseYaml(await readFile(projectPath, 'utf8'));
  bound.stages['product-design'].status = 'active';
  await writeFile(projectPath, stringifyYaml(bound));
  const before = await readFile(projectPath, 'utf8');

  const result = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'visual-spec', '--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output));
  assert.equal(result.output.status, 'PASS');
  assert.equal(result.output.from, 'use-cases');
  assert.equal(result.output.to, 'visual-spec');
  assert.equal(result.output.profile, 'product-delivery');
  assert.deepEqual(result.output.validation.map((item) => item.status), ['PASS']);
  assert.equal(result.output.downstreamAction, 'NOT_RUN');

  const after = await readFile(projectPath, 'utf8');
  assert.equal(after, before);
  const unchanged = parseYaml(after);
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
    for (const scopeId of ['use-cases', 'visual-spec']) {
      value.scopes.find((item) => item.id === scopeId).readinessProfile = 'product-delivery';
    }
  });
  const projectPath = resolve(root, 'psp.project.yaml');
  const bound = parseYaml(await readFile(projectPath, 'utf8'));
  bound.stages['product-design'].status = 'active';
  await writeFile(projectPath, stringifyYaml(bound));
  const result = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'visual-spec', '--json']);
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
