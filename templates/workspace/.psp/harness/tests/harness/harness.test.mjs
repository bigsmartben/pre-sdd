import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { completeProductFixture } from '../../../../.agents/skills/product-design/tests/helpers/product-fixture.mjs';
import { commitManagedWrites } from '../../scripts/lib/artifact-transaction.mjs';
import { normalizeRepositoryPath } from '../../scripts/lib/repository.mjs';
import { resolveHarness, selectorPatterns } from '../../scripts/lib/routing.mjs';
import { cleanupTemporaryRepositories, codes, manifest, project, repositoryRoot, runScript, temporaryRepository } from '../helpers/fixture.mjs';

test.after(cleanupTemporaryRepositories);

async function mutateJson(path, mutation) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  mutation(value);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

function fixtureCommand(id, executor) {
  return {
    id,
    npmScript: 'fixture:' + id.replace('fixture-', ''),
    run: 'npm run fixture:' + id.replace('fixture-', ''),
    purpose: 'fixture',
    blocking: true,
    executor: { kind: 'module', path: executor },
    allowedContexts: ['handoff'],
    costClass: 'standard',
    timeoutMs: 120000,
    cache: { mode: 'disabled' },
  };
}

async function activateProductWithSource(root) {
  const projectPath = resolve(root, 'psp.project.yaml');
  const bound = parseYaml(await readFile(projectPath, 'utf8'));
  bound.stages['product-design'].status = 'active';
  await writeFile(projectPath, stringifyYaml(bound));
  const source = resolve(root, bound.stages['product-design'].root, '.psp/models/use-cases.yaml');
  await mkdir(dirname(source), { recursive: true });
  await writeFile(source, 'version: 1\n');
  return { projectPath, source };
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
  const result = resolveHarness(manifest, project, ['.agents/skills/product-design/SKILL.md'], 'local-edit', repositoryRoot);
  assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
  assert.deepEqual(result.scopes, ['product-framework']);
});

test('resolver maps Canonical UI authority and projections to one artifact scope', () => {
  const active = structuredClone(project);
  active.stages['product-design'].status = 'active';
  const stage = active.stages['product-design'];
  const path = stage.root + '/' + stage.areas['canonical-ui-prototypes'].root + '/ACTOR-001/src/spec/canonical-ui.ts';
  const result = resolveHarness(manifest, active, [path], 'local-edit', repositoryRoot);
  assert.equal(result.status, 'READY', JSON.stringify(result.blockers));
  assert.deepEqual(result.scopes, ['canonical-ui-prototype']);
  assert.deepEqual(result.upstreamScopes, []);
  assert.ok(result.plan.every((item) => item.costClass === 'quick'));
  assert.deepEqual(result.downstreamConsumers, ['mockcase']);
});

test('cache keys bind standard, profile, executor, source, dependency, and runtime facts', () => {
  const digests = Object.fromEntries(manifest.commands.map((command) => [command.id, 'c'.repeat(64)]));
  const options = {
    inputDigest: 'a'.repeat(64),
    dependencyDigest: 'b'.repeat(64),
    runtimeDigest: 'd'.repeat(64),
    executorDigests: digests,
  };
  const resolve = (nextManifest = manifest, nextOptions = options) =>
    resolveHarness(nextManifest, project, ['AGENTS.md'], 'local-edit', repositoryRoot, nextOptions)
      .plan.find((item) => item.commandId === 'harness');
  const baseline = resolve();
  assert.deepEqual(Object.keys(baseline.cache.bindings).sort(), [
    'dependencyDigest', 'executorDigest', 'profileDigest', 'runtimeDigest', 'sourceDigest', 'standardDigest',
  ]);
  const changedStandard = structuredClone(manifest);
  changedStandard.standard.version = '3.0.1';
  assert.notEqual(resolve(changedStandard).cache.key, baseline.cache.key);
  const changedProfile = structuredClone(manifest);
  changedProfile.validationProfiles.find((profile) => profile.id === 'repository-harness').version = '3.0.1';
  assert.notEqual(resolve(changedProfile).cache.key, baseline.cache.key);
  assert.notEqual(resolve(manifest, { ...options, inputDigest: 'e'.repeat(64) }).cache.key, baseline.cache.key);
  assert.notEqual(resolve(manifest, { ...options, dependencyDigest: 'f'.repeat(64) }).cache.key, baseline.cache.key);
  assert.notEqual(resolve(manifest, { ...options, runtimeDigest: '1'.repeat(64) }).cache.key, baseline.cache.key);
  assert.notEqual(resolve(manifest, { ...options, executorDigests: { ...digests, harness: '2'.repeat(64) } }).cache.key, baseline.cache.key);
});

test('Harness registers the Figma intake closure without changing its Operation or validation profiles', async () => {
  assert.equal(manifest.version, '18.1.0');
  const operation = manifest.operations.find((item) => item.id === 'ingest-figma-assets');
  assert.equal(operation.kind, 'ingest');
  assert.equal(operation.artifact, 'canonical-ui-prototype');
  assert.equal(operation.executor.path, '.agents/skills/figma-workflow/scripts/ingest-assets.mjs');
  assert.deepEqual(Object.keys(operation.packetSchemas).sort(), ['acquisition', 'capturePlan', 'receipt', 'registration']);
  assert.equal(Object.hasOwn(operation, 'profile'), false);
  assert.deepEqual(
    manifest.validationProfiles.find((item) => item.id === 'canonical-ui-quick').commands,
    ['harness', 'product-structure', 'canonical-ui-input'],
  );
  assert.deepEqual(
    manifest.validationProfiles.find((item) => item.id === 'canonical-ui-prototype').commands,
    [
      'harness',
      'product-structure',
      'canonical-ui-input',
      'canonical-ui-typecheck',
      'canonical-ui-build',
      'canonical-ui-contract-tests',
      'canonical-ui-runtime',
      'product-strict',
    ],
  );

  const blockerMeanings = new Map(manifest.blockers.map((item) => [item.code, item.meaning]));
  for (const [code, expected] of [
    ['AIH_SOURCE_CAPTURE_BLOCKED', /范围确认、高影响确认、写回边界与冻结来源版本/],
    ['AIH_COMPONENT_VARIANT_COVERAGE_FAILED', /已定义 Variant.*使用中的 Instance/],
    ['AIH_COMPONENT_CONTRACT_INVALID', /Component Contract/],
    ['AIH_COMPONENT_CONTRACT_COVERAGE_FAILED', /Component Contract 覆盖/],
    ['AIH_COMPONENT_CONTRACT_TEST_INVALID', /测试断言/],
    ['AIH_COMPONENT_CONTRACT_TEST_FAILED', /契约测试/],
    ['AIH_STATE_MATRIX_INVALID', /State Matrix 笛卡尔组合/],
    ['AIH_STATE_GALLERY_FAILED', /State Gallery/],
  ]) {
    assert.match(blockerMeanings.get(code) || '', expected, code);
  }

  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.operations.find((item) => item.id === 'ingest-figma-assets').executor.path = '.psp/harness/scripts/init-workspace.mjs';
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_COMMAND_INVALID'), JSON.stringify(invalid.output, null, 2));
});

test('Harness registers Canonical UI dev as a long-running temporary Preview operation', async () => {
  const operation = manifest.operations.find((item) => item.id === 'canonical-ui-dev');
  assert.equal(operation.kind, 'preview');
  assert.equal(operation.npmScript, 'dev');
  assert.equal(operation.artifact, 'canonical-ui-prototype');
  assert.equal(operation.sessionMode, 'long-running');
  assert.equal(operation.outputRole, 'temporary-preview');
  assert.equal(manifest.commands.some((item) => item.id === 'canonical-ui-dev'), false);
  assert.equal(manifest.validationProfiles.some((profile) => profile.commands.includes('canonical-ui-dev')), false);

  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.operations.find((item) => item.id === 'canonical-ui-dev').executor.path = '.psp/harness/scripts/init-workspace.mjs';
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_COMMAND_INVALID'), JSON.stringify(invalid.output, null, 2));
});

test('Canonical UI Review registers Feedback Packet input and Review Evidence 2.0.0', () => {
  const operation = manifest.operations.find((item) => item.id === 'canonical-ui-review');
  assert.equal(operation.kind, 'review');
  assert.equal(operation.evidenceVersion, '2.0.0');
  assert.equal(
    operation.feedbackPacketSchema,
    '.agents/skills/product-design/canonical-ui-prototype/review-feedback-packet.schema.json',
  );
  assert.ok(manifest.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_FEEDBACK_PACKET_INVALID'));
  assert.ok(manifest.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_FEEDBACK_STALE'));
});

test('Harness keeps UI Case Mock as Product Design child commands without an independent lifecycle', () => {
  assert.equal(manifest.artifactRegistry.some((item) => item.id.includes('ui-case')), false);
  assert.equal(manifest.domainRegistry.some((item) => item.id.includes('ui-case')), false);
  assert.equal(manifest.operations.some((item) => item.id.includes('ui-case')), false);
  assert.equal(manifest.projectDag.nodes.some((item) => item.id.includes('ui-case')), false);
  assert.deepEqual(
    manifest.commands.filter((item) => item.id.startsWith('ui-case-')).map((item) => item.id).sort(),
    ['ui-case-analyze', 'ui-case-review', 'ui-case-verify'],
  );
  assert.ok(
    manifest.validationProfiles.find((item) => item.id === 'product-delivery').commands.includes('ui-case-verify'),
  );
});

test('Harness requires one active Canonical UI generated-support refresh operation', async () => {
  const operation = manifest.operations.find((item) => item.id === 'refresh-canonical-ui-projections');
  assert.equal(operation.kind, 'projection-refresh');
  assert.equal(operation.artifact, 'canonical-ui-prototype');
  assert.equal(operation.outputRole, 'generated-support');
  assert.equal(operation.executor.path, '.agents/skills/product-design/canonical-ui-prototype/scripts/refresh-projections.mjs');

  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.operations = value.operations.filter((item) => item.id !== 'refresh-canonical-ui-projections');
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_CONTRACT_INVALID'), JSON.stringify(invalid.output, null, 2));

  for (const mutate of [
    (item) => { item.executor.path = '.agents/skills/product-design/canonical-ui-prototype/scripts/visual-acceptance.mjs'; },
    (item) => { item.executor.args = ['--operation', item.id]; },
    (item) => {
      item.npmScript = 'repair:canonical-ui';
      item.run = 'npm run repair:canonical-ui';
    },
    (item) => { item.outputRole = 'runtime-projection'; },
  ]) {
    const tamperedRoot = await temporaryRepository();
    await mutateJson(resolve(tamperedRoot, '.psp/harness/harness.manifest.json'), (value) => {
      mutate(value.operations.find((item) => item.id === 'refresh-canonical-ui-projections'));
    });
    const tampered = runScript('.psp/harness/scripts/validate-harness.mjs', tamperedRoot, ['--json']);
    assert.ok(codes(tampered).has('AIH_CONTRACT_INVALID'), JSON.stringify(tampered.output, null, 2));
  }
});

test('Canonical UI repair operation declares separate prerequisite and repair gates', async () => {
  const operation = manifest.operations.find((item) => item.id === 'canonical-ui-repair');
  assert.equal(operation.kind, 'repair');
  assert.deepEqual(operation.prerequisiteCommands, ['canonical-ui-input']);
  assert.deepEqual(operation.repairCommands, ['canonical-ui-runtime', 'canonical-ui-contract-tests']);

  for (const mutate of [
    (item) => { item.prerequisiteCommands = ['missing-command']; },
    (item) => { item.repairCommands = ['canonical-ui-input']; },
  ]) {
    const root = await temporaryRepository();
    await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
      mutate(value.operations.find((item) => item.id === 'canonical-ui-repair'));
    });
    const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
    assert.ok(codes(invalid).has('AIH_COMMAND_INVALID'), JSON.stringify(invalid.output, null, 2));
  }
});

test('managed projection writes roll back every target and clean lock files after failure', async () => {
  const root = await temporaryRepository();
  const first = '.psp/fixtures/projection-a.json';
  const second = '.psp/fixtures/projection-b.json';
  await mkdir(resolve(root, '.psp/fixtures'), { recursive: true });
  await writeFile(resolve(root, first), 'old-a\n');
  await writeFile(resolve(root, second), 'old-b\n');
  await assert.rejects(commitManagedWrites({
    root,
    ownerId: 'canonical-ui-prototype',
    writes: [
      { target: first, content: 'new-a\n' },
      { target: second, content: 'new-b\n' },
    ],
    beforeReplace({ index }) {
      if (index === 1) throw Object.assign(new Error('fixture replacement failure'), { code: 'AIH_ARTIFACT_TRANSACTION_FAILED' });
    },
  }), (error) => error.code === 'AIH_ARTIFACT_TRANSACTION_FAILED');
  assert.equal(await readFile(resolve(root, first), 'utf8'), 'old-a\n');
  assert.equal(await readFile(resolve(root, second), 'utf8'), 'old-b\n');
  assert.deepEqual((await readdir(resolve(root, '.psp/fixtures'))).sort(), ['projection-a.json', 'projection-b.json']);
  assert.deepEqual(await readdir(resolve(root, '.psp/transactions')), []);
});

test('resolver makes published stages readable but requires Reopen before change', () => {
  const published = structuredClone(project);
  published.stages['product-design'].status = 'published';
  const stage = published.stages['product-design'];
  const path = stage.root + '/' + stage.areas['canonical-ui-prototypes'].root + '/ACTOR-001/src/spec/canonical-ui.ts';
  const change = resolveHarness(manifest, published, [path], 'local-edit', repositoryRoot);
  assert.equal(change.status, 'BLOCKED');
  assert.ok(change.blockers.some((item) => item.code === 'AIH_STAGE_LOCKED'));
  const readiness = resolveHarness(manifest, published, [path], 'release', repositoryRoot);
  assert.equal(readiness.status, 'READY', JSON.stringify(readiness.blockers));
});

test('Use Cases hands off to Visual Spec and Visual Spec hands off to Canonical UI Prototype', () => {
  const active = structuredClone(project);
  active.stages['product-design'].status = 'active';
  const stage = active.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  const authority = resolveHarness(manifest, active, [stage.root + '/' + binding.internalModel], 'local-edit', repositoryRoot);
  assert.equal(authority.status, 'READY', JSON.stringify(authority.blockers));
  assert.deepEqual(authority.scopes, ['use-cases']);
  assert.deepEqual(authority.upstreamScopes, []);
  assert.deepEqual(authority.downstreamConsumers, ['visual-spec']);
  for (const output of binding.outputs) {
    const projection = resolveHarness(manifest, active, [stage.root + '/' + output.path], 'local-edit', repositoryRoot);
    assert.equal(projection.status, 'BLOCKED');
    assert.deepEqual(projection.scopes, ['use-cases']);
    assert.ok(projection.blockers.some((blocker) => blocker.code === 'AIH_GENERATED_DRIFT'));
  }

  const visualBinding = stage.artifacts['visual-spec'];
  const visualAuthority = resolveHarness(manifest, active, [stage.root + '/' + visualBinding.internalModel], 'local-edit', repositoryRoot);
  assert.equal(visualAuthority.status, 'READY', JSON.stringify(visualAuthority.blockers));
  assert.deepEqual(visualAuthority.scopes, ['visual-spec']);
  assert.deepEqual(visualAuthority.upstreamScopes, []);
  assert.deepEqual(visualAuthority.downstreamConsumers, ['canonical-ui-prototype']);
  for (const output of visualBinding.outputs) {
    const projection = resolveHarness(manifest, active, [stage.root + '/' + output.path], 'local-edit', repositoryRoot);
    assert.equal(projection.status, 'BLOCKED');
    assert.deepEqual(projection.scopes, ['visual-spec']);
    assert.ok(projection.blockers.some((blocker) => blocker.code === 'AIH_GENERATED_DRIFT'));
  }
});

test('project DAG is the only source of dependency and handoff relationships', () => {
  assert.ok(manifest.projectDag.nodes.some((node) => node.id === 'architecture-design' && node.kind === 'stage'));
  assert.ok(manifest.projectDag.nodes.some((node) => node.id === 'use-cases' && node.kind === 'artifact'));
  assert.ok(manifest.projectDag.edges.some((edge) => edge.from === 'use-cases' && edge.to === 'visual-spec' && edge.type === 'handoff'));
  assert.ok(manifest.projectDag.edges.some((edge) => edge.from === 'use-cases' && edge.to === 'visual-spec' && edge.type === 'dependency'));
  for (const edge of manifest.projectDag.edges) {
    if (edge.type === 'dependency') assert.equal(edge.analysisCommand, 'project-consistency');
    else assert.ok(edge.profile);
  }
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

test('Handoff edges bind source-specific readiness profiles instead of whole-domain delivery profiles', async () => {
  const expected = new Map([
    ['use-cases', ['harness', 'project-consistency', 'use-cases-strict']],
    ['visual-spec', ['harness', 'project-consistency', 'visual-spec-strict']],
    ['canonical-ui-prototype', [
      'harness',
      'project-consistency',
      'product-structure',
      'canonical-ui-input',
      'canonical-ui-typecheck',
      'canonical-ui-build',
      'canonical-ui-contract-tests',
      'canonical-ui-runtime',
      'product-strict',
    ]],
    ['system-boundary', ['harness', 'project-consistency', 'architecture-system-boundary']],
  ]);
  for (const edge of manifest.projectDag.edges.filter((item) => item.type === 'handoff')) {
    const profile = manifest.validationProfiles.find((item) => item.id === edge.profile);
    assert.equal(profile.handoffSource, edge.from);
    assert.deepEqual(profile.commands, expected.get(edge.from));
    const consumerCommands = edge.from === 'canonical-ui-prototype'
      ? ['mockcase-static', 'test-mockcase']
      : ['canonical-ui-build', 'canonical-ui-runtime', 'product-strict', 'architecture-strict'];
    assert.equal(profile.commands.some((id) => consumerCommands.includes(id)), false);
  }
  assert.equal(manifest.validationProfiles.find((item) => item.id === 'product-handoff').allowedContexts.includes('handoff'), false);
  assert.equal(manifest.validationProfiles.find((item) => item.id === 'architecture-handoff').allowedContexts.includes('handoff'), false);

  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.validationProfiles.find((item) => item.id === 'use-cases-handoff').commands.push('canonical-ui-build');
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_PROFILE_INVALID'), JSON.stringify(invalid.output, null, 2));

  const coupledRoot = await temporaryRepository();
  await mutateJson(resolve(coupledRoot, '.psp/harness/harness.manifest.json'), (value) => {
    value.validationProfiles.find((item) => item.id === 'use-cases-readiness').commands.push('canonical-ui-build');
    value.validationProfiles.find((item) => item.id === 'use-cases-handoff').commands.push('canonical-ui-build');
  });
  const coupled = runScript('.psp/harness/scripts/validate-harness.mjs', coupledRoot, ['--json']);
  assert.ok(codes(coupled).has('AIH_PROFILE_INVALID'), JSON.stringify(coupled.output, null, 2));
});

test('resolver uses artifact-level Architecture Design dependencies and readiness profiles', () => {
  const active = structuredClone(project);
  active.stages['architecture-design'].status = 'active';
  const stage = active.stages['architecture-design'];
  const pathFor = (artifactId) => stage.root + '/' + stage.artifacts[artifactId].internalModel;

  const systemBoundary = resolveHarness(manifest, active, [pathFor('system-boundary')], 'release', repositoryRoot);
  assert.deepEqual(systemBoundary.scopes, ['system-boundary']);
  assert.deepEqual(systemBoundary.upstreamScopes, []);
  assert.ok(systemBoundary.commandIds.includes('architecture-system-boundary'));

  const conceptualModel = resolveHarness(manifest, active, [pathFor('conceptual-model')], 'release', repositoryRoot);
  assert.deepEqual(conceptualModel.scopes, ['conceptual-model']);
  assert.deepEqual(conceptualModel.upstreamScopes, ['system-boundary']);
  assert.ok(conceptualModel.commandIds.includes('architecture-conceptual-model'));

  const technicalArea = stage.root + '/' + stage.areas['technical-validation'].root + '/cases/EXP-001.case.mjs';
  const technicalValidation = resolveHarness(manifest, active, [technicalArea], 'local-edit', repositoryRoot);
  assert.deepEqual(technicalValidation.scopes, ['technical-validation']);
  assert.deepEqual(technicalValidation.upstreamScopes, []);
  assert.ok(!technicalValidation.commandIds.includes('architecture-strict'));

  const architecturePackage = resolveHarness(manifest, active, [pathFor('architecture-package')], 'release', repositoryRoot);
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
      analysisCommand: 'project-consistency',
    });
  });
  const invalid = runScript('.psp/harness/scripts/validate-harness.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_HARNESS_COUPLED'));
});

test('Harness reports stable DAG blockers for unknown nodes, conflicting edges, and cycles', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.projectDag.edges.push(
      { from: 'unknown-source', to: 'visual-spec', type: 'dependency', analysisCommand: 'project-consistency' },
      { from: 'use-cases', to: 'visual-spec', type: 'dependency', analysisCommand: 'project-consistency' },
      { from: 'visual-spec', to: 'use-cases', type: 'dependency', analysisCommand: 'project-consistency' },
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

test('real Handoff profiles ignore unfinished consumers and keep target-only changes outside the token', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const bound = parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
  const stage = bound.stages['product-design'];
  const visualPath = resolve(root, stage.root, stage.artifacts['visual-spec'].internalModel);
  const visualSource = await readFile(visualPath, 'utf8');
  const canonicalPath = resolve(
    root,
    stage.root,
    stage.areas['canonical-ui-prototypes'].root,
    'ACTOR-001',
    stage.artifacts['canonical-ui-prototype'].authority.semanticEntry,
  );
  await writeFile(visualPath, 'invalid: true\n');
  await writeFile(canonicalPath, 'export const canonicalUi = invalidTarget;\n');

  const useCases = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'use-cases', '--to', 'visual-spec', '--json',
  ]);
  assert.equal(useCases.exitCode, 0, JSON.stringify(useCases.output, null, 2));
  assert.equal(useCases.output.confirmable, true);
  assert.deepEqual(useCases.output.validation.commands.map((item) => item.id), [
    'harness', 'project-consistency', 'use-cases-strict',
  ]);
  const consistency = JSON.parse(useCases.output.validation.commands.find((item) => item.id === 'project-consistency').stdout);
  assert.deepEqual(consistency.scope.selected, ['use-cases']);

  await writeFile(visualPath, visualSource);
  const confirmed = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'use-cases', '--to', 'visual-spec',
    '--confirm', '--actor', 'user:test',
    '--preflight-token', useCases.output.preflightToken,
    '--json',
  ]);
  assert.equal(confirmed.exitCode, 0, JSON.stringify(confirmed.output, null, 2));
  assert.equal(confirmed.output.receipt.status, 'VALID');

  const sourcePath = resolve(root, stage.root, stage.artifacts.capabilities.internalModel);
  const sourceText = await readFile(sourcePath, 'utf8');
  const current = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'use-cases', '--to', 'visual-spec', '--json',
  ]);
  assert.equal(current.exitCode, 0, JSON.stringify(current.output, null, 2));
  await writeFile(sourcePath, sourceText + '\n');
  const staleToken = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'use-cases', '--to', 'visual-spec',
    '--confirm', '--actor', 'user:test',
    '--preflight-token', current.output.preflightToken,
    '--json',
  ]);
  assert.ok(codes(staleToken).has('AIH_HANDOFF_CONFIRMATION_INVALID'), JSON.stringify(staleToken.output, null, 2));
  await writeFile(sourcePath, sourceText);

  const visualSpec = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'visual-spec', '--to', 'canonical-ui-prototype', '--json',
  ]);
  assert.equal(visualSpec.exitCode, 0, JSON.stringify(visualSpec.output, null, 2));
  assert.equal(visualSpec.output.confirmable, true);
  assert.deepEqual(visualSpec.output.dependencyClosure, ['use-cases', 'visual-spec']);
  assert.deepEqual(visualSpec.output.validation.commands.map((item) => item.id), [
    'harness', 'project-consistency', 'visual-spec-strict',
  ]);
});

test('handoff waits for explicit confirmation, persists a v3 receipt, becomes stale, and never initializes downstream', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.commands.push(fixtureCommand('fixture-pass', '.psp/harness/tests/fixtures/command-pass.mjs'));
    value.validationProfiles.find((item) => item.id === 'use-cases-handoff').commands = ['fixture-pass'];
  });
  const { projectPath, source } = await activateProductWithSource(root);
  const before = await readFile(projectPath, 'utf8');

  const preflight = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'visual-spec', '--json']);
  assert.equal(preflight.exitCode, 0, JSON.stringify(preflight.output));
  assert.equal(preflight.output.operation, 'HANDOFF_PREFLIGHT');
  assert.equal(preflight.output.validation.status, 'PASS');
  assert.equal(preflight.output.decision.status, 'PENDING');
  assert.equal(preflight.output.receipt.status, 'NOT_CREATED');
  assert.equal(preflight.output.confirmable, true);

  const confirmed = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'use-cases', '--to', 'visual-spec', '--confirm', '--actor', 'user:test',
    '--preflight-token', preflight.output.preflightToken, '--json',
  ]);
  assert.equal(confirmed.exitCode, 0, JSON.stringify(confirmed.output));
  assert.equal(confirmed.output.decision.status, 'CONFIRMED');
  assert.equal(confirmed.output.receipt.status, 'VALID');
  assert.equal(confirmed.output.downstreamAction, 'NOT_RUN');
  assert.equal(JSON.parse(await readFile(resolve(root, confirmed.output.path), 'utf8')).id, confirmed.output.id);

  const manifestPath = resolve(root, '.psp/harness/harness.manifest.json');
  await mutateJson(manifestPath, (value) => {
    value.validationProfiles.find((item) => item.id === 'use-cases-handoff').version = '3.0.1';
  });
  const staleProfile = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--status', '--receipt', confirmed.output.path, '--json']);
  assert.equal(staleProfile.output.receipt.status, 'STALE');
  await mutateJson(manifestPath, (value) => {
    value.validationProfiles.find((item) => item.id === 'use-cases-handoff').version = '3.0.0';
  });

  await writeFile(source, 'version: 2\n');
  const stale = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--status', '--receipt', confirmed.output.path, '--json']);
  assert.equal(stale.output.receipt.status, 'STALE');

  const revoked = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--revoke', '--receipt', confirmed.output.path, '--actor', 'user:test', '--reason', 'source superseded', '--json',
  ]);
  assert.equal(revoked.output.receipt.status, 'REVOKED');
  assert.equal(revoked.output.receipt.revokedBy, 'user:test');
  assert.equal(revoked.output.receipt.revokeReason, 'source superseded');
  const repeatedRevoke = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--revoke', '--receipt', confirmed.output.path, '--actor', 'user:test', '--reason', 'repeat', '--json',
  ]);
  assert.ok(codes(repeatedRevoke).has('AIH_RECEIPT_STATE_INVALID'));

  await mutateJson(resolve(root, confirmed.output.path), (value) => {
    value.decision.actor = 'tampered';
  });
  const tampered = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--status', '--receipt', confirmed.output.path, '--json']);
  assert.equal(tampered.output.receipt.status, 'INVALID');
  assert.ok(codes(tampered).has('AIH_RECEIPT_TAMPERED'));

  await mutateJson(resolve(root, confirmed.output.path), (value) => {
    value.unregistered = true;
  });
  const malformed = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--status', '--receipt', confirmed.output.path, '--json']);
  assert.equal(malformed.output.receipt.status, 'INVALID');
  assert.ok(codes(malformed).has('AIH_SCHEMA_INVALID'));

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
      fixtureCommand('fixture-pass', '.psp/harness/tests/fixtures/command-pass.mjs'),
      fixtureCommand('fixture-fail', '.psp/harness/tests/fixtures/command-fail.mjs'),
      fixtureCommand('fixture-notrun', '.psp/harness/tests/fixtures/command-pass.mjs'),
    );
    value.validationProfiles.find((item) => item.id === 'use-cases-handoff').commands = ['fixture-pass', 'fixture-fail', 'fixture-notrun'];
  });
  await activateProductWithSource(root);
  const result = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'visual-spec', '--json']);
  assert.equal(result.output.validation.status, 'FAIL');
  assert.deepEqual(result.output.validation.commands.map((item) => item.status), ['PASS', 'FAIL', 'NOT_RUN']);
  assert.equal(result.output.confirmable, false);
  assert.equal(result.output.receipt.status, 'NOT_CREATED');
  assert.equal(result.output.downstreamAction, 'NOT_RUN');
  const refused = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'use-cases', '--to', 'visual-spec', '--confirm', '--actor', 'user:test',
    '--preflight-token', result.output.preflightToken, '--accept-risk', 'AIH_VALIDATION_FAILED', '--json',
  ]);
  assert.equal(refused.output.receipt.status, 'NOT_CREATED');
  assert.equal(refused.output.confirmable, false);
});

test('handoff can record an explicitly accepted domain diagnostic without changing strict validation status', async () => {
  const root = await temporaryRepository();
  await mutateJson(resolve(root, 'package.json'), (value) => {
    value.scripts['fixture:fail'] = 'node -e "process.exit(7)"';
  });
  await mutateJson(resolve(root, '.psp/harness/harness.manifest.json'), (value) => {
    value.commands.push(fixtureCommand('fixture-fail', '.psp/harness/tests/fixtures/command-fail.mjs'));
    value.validationProfiles.find((item) => item.id === 'use-cases-handoff').commands = ['fixture-fail'];
    value.blockers.find((item) => item.code === 'AIH_VALIDATION_FAILED').gateClass = 'domain-diagnostic';
  });
  await activateProductWithSource(root);
  const preflight = runScript('.psp/harness/scripts/run-handoff.mjs', root, ['--from', 'use-cases', '--to', 'visual-spec', '--json']);
  assert.equal(preflight.output.validation.status, 'FAIL');
  assert.equal(preflight.output.confirmable, true);
  assert.deepEqual(preflight.output.risks.map((item) => item.code), ['AIH_VALIDATION_FAILED']);
  const confirmed = runScript('.psp/harness/scripts/run-handoff.mjs', root, [
    '--from', 'use-cases', '--to', 'visual-spec', '--confirm', '--actor', 'user:test',
    '--preflight-token', preflight.output.preflightToken,
    '--accept-risk', 'AIH_VALIDATION_FAILED', '--json',
  ]);
  assert.equal(confirmed.output.validation.status, 'FAIL');
  assert.equal(confirmed.output.decision.status, 'CONFIRMED');
  assert.deepEqual(confirmed.output.decision.acceptedRisks, ['AIH_VALIDATION_FAILED']);
  assert.equal(confirmed.output.receipt.status, 'VALID');
  assert.equal(confirmed.output.downstreamAction, 'NOT_RUN');
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
