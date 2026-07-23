import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  cleanupTemporaryRepositories,
  runScript,
  temporaryRepository,
} from '../../product-design/tests/helpers/fixture.mjs';
import {
  completeProductFixture,
  fixtureProject,
  readArtifact,
  writeArtifact,
} from '../../product-design/tests/helpers/product-fixture.mjs';

test.after(cleanupTemporaryRepositories);

async function snapshotTree(root, relative = '') {
  const entries = await readdir(resolve(root, relative), { withFileTypes: true });
  const output = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) output.push(...await snapshotTree(root, path));
    else if (entry.isFile()) output.push([path, (await readFile(resolve(root, path))).toString('base64')]);
  }
  return output;
}

function evidenceCodes(result) {
  return new Set((result.output.residuals || []).map((item) => item.code));
}

test('project-consistency is discoverable, absent from hooks, and excluded from local-edit Profiles', async () => {
  const root = await temporaryRepository();
  const manifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  const hook = await readFile(resolve(root, '.codex/hooks.json'), 'utf8');
  assert.ok(manifest.codex.repositorySkills.includes('.agents/skills/project-consistency/SKILL.md'));
  assert.equal(manifest.commands.find((item) => item.id === 'project-consistency')?.executor.path, '.agents/skills/project-consistency/scripts/check.mjs');
  assert.ok(manifest.projectDag.nodes.every((node) => node.validators.length > 0));
  const profiles = manifest.validationProfiles.filter((profile) => profile.commands.includes('project-consistency'));
  assert.ok(profiles.length > 0);
  assert.ok(profiles.every((profile) => !profile.allowedContexts.includes('local-edit')));
  assert.doesNotMatch(hook, /project-consistency/);
});

test('full-project inspection reports every DAG node and edge without initializing or handing off', async () => {
  const root = await temporaryRepository();
  const before = await snapshotTree(root);
  const result = runScript('.agents/skills/project-consistency/scripts/check.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  assert.equal(result.output.mode, 'full-project');
  assert.equal(result.output.nodes.length, result.output.scope.topologicalOrder.length);
  assert.ok(result.output.nodes.every((node) => node.status === 'NOT_RUN'));
  assert.equal(result.output.edges.length, 9);
  assert.equal(result.output.dependencies.length, 9);
  assert.deepEqual(result.output.acceptedRisks, []);
  assert.equal(result.output.sideEffects.status, 'PASS');
  assert.deepEqual(result.output.changes, []);
  assert.equal(result.output.initialization, 'NOT_RUN');
  assert.equal(result.output.handoff, 'NOT_RUN');
  assert.deepEqual(await snapshotTree(root), before);
});

test('scoped Use Cases inspection follows downstream impact and exposes edge evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const visual = await readArtifact(root, stage, stage.artifacts['visual-spec']);
  visual.data.pages[0].useCaseRefs = ['UC-999'];
  await writeArtifact(visual);
  const before = await snapshotTree(root);

  const result = runScript('.agents/skills/project-consistency/scripts/check.mjs', root, ['--scope', 'use-cases', '--json']);
  assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  assert.deepEqual(result.output.scope.requested, ['use-cases']);
  assert.deepEqual(result.output.scope.selected, ['use-cases', 'visual-spec', 'canonical-ui-prototype', 'mockcase']);
  const edge = result.output.edges.find((item) => item.from === 'use-cases' && item.to === 'visual-spec');
  assert.equal(edge.status, 'BLOCKED');
  assert.ok(edge.evidence.some((item) => item.code === 'AIH_REFERENCE_UNRESOLVED'));
  assert.ok(edge.impact.includes('canonical-ui-prototype'));
  assert.equal(result.output.sideEffects.status, 'PASS');
  assert.deepEqual(await snapshotTree(root), before);
});

test('handoff-source inspection follows only incoming dependencies and excludes unfinished consumers', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const visual = await readArtifact(root, stage, stage.artifacts['visual-spec']);
  visual.data.pages[0].useCaseRefs = ['UC-999'];
  await writeArtifact(visual);

  const useCases = runScript('.agents/skills/project-consistency/scripts/check.mjs', root, [
    '--scope', 'use-cases',
    '--mode', 'handoff-source',
    '--json',
  ]);
  assert.equal(useCases.exitCode, 0, JSON.stringify(useCases.output, null, 2));
  assert.deepEqual(useCases.output.scope.selected, ['use-cases']);
  assert.deepEqual(useCases.output.edges, []);

  visual.data.pages[0].useCaseRefs = ['UC-001'];
  await writeArtifact(visual);
  const visualSpec = runScript('.agents/skills/project-consistency/scripts/check.mjs', root, [
    '--scope', 'visual-spec',
    '--mode=handoff-source',
    '--json',
  ]);
  assert.equal(visualSpec.exitCode, 0, JSON.stringify(visualSpec.output, null, 2));
  assert.deepEqual(visualSpec.output.scope.selected, ['use-cases', 'visual-spec']);
  assert.equal(visualSpec.output.scope.selected.includes('canonical-ui-prototype'), false);
});

test('Canonical UI scope reports stale upstream hashes without selecting an authority', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);
  capabilities.data.intent.problem = '上游 Use Cases 已在 UI 实现之后发生变化';
  await writeArtifact(capabilities);

  const result = runScript('.agents/skills/project-consistency/scripts/check.mjs', root, [
    '--scope=canonical-ui-prototype',
    '--json',
  ]);
  assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  const node = result.output.nodes.find((item) => item.id === 'canonical-ui-prototype');
  assert.ok(node.evidence.some((item) => item.code === 'AIH_CANONICAL_UI_INPUT_DRIFT'));
  assert.ok(node.optionalActions.some((item) => /上游事实还是当前节点/.test(item)));
  const edge = result.output.edges.find((item) => item.from === 'use-cases' && item.to === 'canonical-ui-prototype');
  assert.equal(edge.status, 'BLOCKED');
  assert.equal(result.output.changes.length, 0);
  assert.equal(result.output.handoff, 'NOT_RUN');
});

test('illegal DAG and unknown requested Scope return stable blockers', async () => {
  const root = await temporaryRepository();
  const manifestPath = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.projectDag.edges.push(
    {
      from: 'visual-spec',
      to: 'use-cases',
      type: 'dependency',
      analysisCommand: 'project-consistency',
    },
    {
      from: 'unknown-node',
      to: 'visual-spec',
      type: 'dependency',
      analysisCommand: 'project-consistency',
    },
  );
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  const result = runScript('.agents/skills/project-consistency/scripts/check.mjs', root, [
    '--scope',
    'missing-scope',
    '--json',
  ]);
  assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  const codes = evidenceCodes(result);
  assert.ok(codes.has('AIH_DAG_CYCLE'));
  assert.ok(codes.has('AIH_DAG_NODE_UNKNOWN'));
  assert.equal(result.output.initialization, 'NOT_RUN');
  assert.equal(result.output.handoff, 'NOT_RUN');
});
