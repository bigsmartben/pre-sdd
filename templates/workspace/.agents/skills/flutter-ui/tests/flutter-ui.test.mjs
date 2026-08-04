import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { collectSourceClosure, hashPath, lockFor, readArtifact, rejectLegacy, sha256, stableJson, validateSchema } from '../scripts/lib/core.mjs';
import { validateWorkspace } from '../scripts/validate.mjs';
import { fixtureWorkspace, run, writeJson } from '../../visual-spec/tests/helpers/workspace.mjs';

const skillRoot = resolve(import.meta.dirname, '..');
const workspaceTemplate = resolve(skillRoot, '..', 'implement-flutter-ui', 'templates', 'flutter-workspace');

test('all formal schemas and templates compile with unknown fields rejected', async () => {
  const pairs = [
    ['flutter-visual-coverage', 'flutter-visual-coverage'],
    ['flutter-user-path-coverage', 'flutter-user-path-coverage'],
    ['preview-manifest', 'preview-manifest'],
    ['review-findings', 'review-findings'],
    ['ui-spec-manifest', 'ui-spec-manifest'],
  ];
  for (const [schemaName, templateName] of pairs) {
    const schema = JSON.parse(await readFile(resolve(skillRoot, 'schemas', `${schemaName}.schema.json`), 'utf8'));
    const candidate = JSON.parse(await readFile(resolve(skillRoot, 'templates', `${templateName}.json`), 'utf8'));
    const validate = new Ajv2020({ strict: true, allErrors: true, formats: { 'date-time': true } }).compile(schema);
    assert.equal(validate(candidate), true, `${schemaName}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...candidate, undeclared: true }), false, schemaName);
  }
});

test('source closure is content-addressed and excludes review/test implementations', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'flutter-ui-source-'));
  try {
    await cp(workspaceTemplate, root, { recursive: true });
    await writeFile(resolve(root, 'pubspec.lock'), 'packages: {}\n', 'utf8');
    const closure = await collectSourceClosure(root);
    assert.match(closure.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(closure.files.some((entry) => entry.path.startsWith('lib/ui/')), true);
    assert.equal(closure.files.some((entry) => /^lib\/(review|testing)\//.test(entry.path)), false);
    const before = closure.digest;
    await writeFile(resolve(root, 'lib/ui/models/ui_state.dart'), 'enum UiState { changed }\n', 'utf8');
    assert.notEqual((await collectSourceClosure(root)).digest, before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('tracked platform source participates in closure while Preview and build output use separate digests', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'flutter-ui-platform-source-'));
  try {
    await cp(workspaceTemplate, root, { recursive: true });
    await writeFile(resolve(root, 'pubspec.lock'), 'packages: {}\n', 'utf8');
    await mkdir(resolve(root, 'android/app/src/main/kotlin'), { recursive: true });
    await writeFile(resolve(root, 'android/app/src/main/kotlin/MainActivity.kt'), 'class MainActivity\n', 'utf8');
    for (const args of [['init'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-m', 'fixture']]) {
      const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const before = await collectSourceClosure(root);
    assert.equal(before.files.some((entry) => entry.path.endsWith('MainActivity.kt')), true);
    await writeFile(resolve(root, 'android/app/src/main/kotlin/MainActivity.kt'), 'class ChangedActivity\n', 'utf8');
    assert.notEqual((await collectSourceClosure(root)).digest, before.digest);
    await mkdir(resolve(root, 'build/web'), { recursive: true });
    await writeFile(resolve(root, 'build/web/main.dart.js'), 'compiled', 'utf8');
    assert.match(await hashPath(root, 'build/web'), /^sha256:[a-f0-9]{64}$/);
    assert.match(await hashPath(root, 'lib/review'), /^sha256:[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function figmaIntake(itemId) {
  return {
    schemaVersion: 'psp.dev/figma-intake/v1',
    source: { provider: 'figma', fileId: 'fixture-file', locator: 'figma://fixture-file', scope: { kind: 'file', refs: ['fixture-file'] }, revision: '42', capturedAt: '2026-07-30T00:00:00.000Z', payload: { document: { id: 'fixture-file', revision: '42', children: ['12:34'] } }, nodes: [{ nodeId: '12:34', pageId: '1:1', payload: { id: '12:34', type: 'FRAME', name: 'Checkout' } }] },
    items: [{ itemId, status: 'covered', anchors: [{ nodeId: '12:34', role: 'page', viewport: 'mobile', state: 'default', variant: null, contentCase: 'normal', properties: ['geometry', 'layout', 'appearance', 'typography', 'viewport', 'state'] }] }],
    assets: [], tokens: [], motions: [],
  };
}

async function readyPreviewFixture() {
  const fixture = await fixtureWorkspace();
  let result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/generate.mjs', ['--json']);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  const checklist = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/visual-spec/checklist.json'), 'utf8'));
  const intakePath = resolve(fixture.parent, 'intake.json');
  await writeJson(intakePath, figmaIntake(checklist.items[0].itemId));
  result = run(fixture.workspace, '.agents/skills/figma-evidence/scripts/finalize.mjs', ['--intake', intakePath]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  result = run(fixture.workspace, '.agents/skills/visual-spec/scripts/authorize.mjs', ['--figma-freshness', intakePath]);
  assert.equal(result.status, 0, result.stdout || result.stderr);
  for (const path of ['pubspec.yaml', 'analysis_options.yaml', 'lib', 'test']) await cp(resolve(workspaceTemplate, path), resolve(fixture.workspace, path), { recursive: true });
  await writeFile(resolve(fixture.workspace, 'pubspec.lock'), 'packages: {}\n', 'utf8');
  await mkdir(resolve(fixture.workspace, 'android/app/src/main/kotlin'), { recursive: true });
  await writeFile(resolve(fixture.workspace, 'android/app/src/main/kotlin/MainActivity.kt'), 'class MainActivity\n', 'utf8');
  for (const path of ['ios/Runner', 'web']) await mkdir(resolve(fixture.workspace, path), { recursive: true });
  await writeFile(resolve(fixture.workspace, 'ios/Runner/AppDelegate.swift'), 'class AppDelegate {}\n', 'utf8');
  await writeFile(resolve(fixture.workspace, 'web/index.html'), '<main></main>\n', 'utf8');
  for (const args of [['init'], ['config', 'user.email', 'fixture@example.com'], ['config', 'user.name', 'Fixture'], ['add', '.'], ['commit', '-m', 'fixture']]) {
    result = spawnSync('git', args, { cwd: fixture.workspace, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.workspace, encoding: 'utf8' }).stdout.trim();
  const closure = await collectSourceClosure(fixture.workspace);
  const artifact = async (path) => readArtifact(fixture.workspace, path);
  const authorization = await artifact('.psp/visual-spec/ready-authorization.json');
  const figmaCoverage = await artifact('.psp/visual-spec/figma-coverage.json');
  const figmaEvidence = await artifact('.psp/visual-spec/figma-evidence.json');
  const item = checklist.items[0];
  const l1 = {
    schemaVersion: 'psp.dev/flutter-ui/v1', metadata: { artifactId: 'FLUTTER-VISUAL-COVERAGE', revision: 1, status: 'ready' },
    source: { framework: 'flutter', language: 'dart', root: 'lib/ui', commit, digest: closure.digest },
    sourceLocks: [lockFor('VISUAL-SPEC-READY-AUTHORIZATION', authorization), lockFor('FIGMA-COVERAGE', figmaCoverage), lockFor('FIGMA-EVIDENCE', figmaEvidence)], dependencies: [],
    items: [{ itemId: item.itemId, status: 'accepted', route: '/', page: 'HomePage', widgetId: 'SpecPlaceholder', sourcePaths: ['lib/ui/pages/home_page.dart'], viewports: item.dimensions.viewports, states: item.dimensions.states, variants: item.dimensions.variants, contentCases: item.dimensions.contentCases, tokenRefs: item.dimensions.tokens, assetRefs: item.dimensions.assets, motionRefs: item.dimensions.motions, scenario: 'fixture' }], gaps: [],
  };
  await mkdir(resolve(fixture.workspace, '.psp/ui-spec'), { recursive: true });
  await writeFile(resolve(fixture.workspace, '.psp/ui-spec/flutter-visual-coverage.json'), stableJson(l1));
  const l1Artifact = await artifact('.psp/ui-spec/flutter-visual-coverage.json');
  await mkdir(resolve(fixture.workspace, 'build/web'), { recursive: true });
  await writeFile(resolve(fixture.workspace, 'build/web/main.dart.js'), 'compiled', 'utf8');
  const preview = {
    schemaVersion: 'psp.dev/flutter-ui/v1', metadata: { artifactId: 'FLUTTER-UI-PREVIEW', revision: 1, status: 'reviewing' }, source: l1.source,
    coverageLocks: [lockFor('FLUTTER-VISUAL-COVERAGE', l1Artifact)],
    preview: { target: 'web', runtimeProfile: 'web-chrome-fixed', buildPath: 'build/web', buildDigest: await hashPath(fixture.workspace, 'build/web'), reviewAdapterDigest: await hashPath(fixture.workspace, 'lib/review'), acceptanceStatus: 'pending', acceptedBy: null, acceptedAt: null },
    platformPolicy: { flutterNativeAdaptations: 'accepted', crossPlatformPixelParityRequired: false, previewAcceptanceMode: 'selected-target' },
  };
  await writeFile(resolve(fixture.workspace, '.psp/ui-spec/preview-manifest.json'), stableJson(preview));
  const previewArtifact = await artifact('.psp/ui-spec/preview-manifest.json');
  await writeFile(resolve(fixture.workspace, '.psp/ui-spec/review-findings.json'), stableJson({ schemaVersion: 'psp.dev/flutter-ui/v1', metadata: { artifactId: 'REVIEW-FINDINGS', revision: 1, status: 'clear' }, previewLock: lockFor('FLUTTER-UI-PREVIEW', previewArtifact), findings: [] }));
  return { ...fixture, intakePath, preview };
}

test('main preview gate rejects stale state and extra optional L2 lock', async () => {
  const fixture = await readyPreviewFixture();
  try {
    const previous = process.env.PSP_FIGMA_FRESHNESS_PATH;
    process.env.PSP_FIGMA_FRESHNESS_PATH = fixture.intakePath;
    try {
      assert.deepEqual(await validateWorkspace(fixture.workspace, 'preview'), []);
      await writeFile(resolve(fixture.workspace, 'lib/ui/untracked_widget.dart'), 'class UntrackedWidget {}\n', 'utf8');
      assert.equal((await validateWorkspace(fixture.workspace, 'preview')).some((item) => item.code === 'FLUTTER_SOURCE_COMMIT_MISMATCH'), true);
      await rm(resolve(fixture.workspace, 'lib/ui/untracked_widget.dart'));
      const previewPath = resolve(fixture.workspace, '.psp/ui-spec/preview-manifest.json');
      const findingsPath = resolve(fixture.workspace, '.psp/ui-spec/review-findings.json');
      const preview = JSON.parse(await readFile(previewPath, 'utf8'));
      preview.metadata.status = 'stale'; preview.preview.acceptanceStatus = 'stale'; preview.metadata.revision += 1;
      await writeFile(previewPath, stableJson(preview));
      const previewArtifact = await readArtifact(fixture.workspace, '.psp/ui-spec/preview-manifest.json');
      const findings = JSON.parse(await readFile(findingsPath, 'utf8'));
      findings.previewLock = lockFor('FLUTTER-UI-PREVIEW', previewArtifact); findings.metadata.revision += 1;
      await writeFile(findingsPath, stableJson(findings));
      assert.equal((await validateWorkspace(fixture.workspace, 'preview')).some((item) => item.code === 'FLUTTER_PREVIEW_STALE'), true);
      preview.metadata.status = 'reviewing'; preview.preview.acceptanceStatus = 'pending'; preview.metadata.revision += 1;
      preview.coverageLocks.push({ ...preview.coverageLocks[0], artifactId: 'FLUTTER-USER-PATH-COVERAGE' });
      await writeFile(previewPath, stableJson(preview));
      const rebound = await readArtifact(fixture.workspace, '.psp/ui-spec/preview-manifest.json');
      findings.previewLock = lockFor('FLUTTER-UI-PREVIEW', rebound); findings.metadata.revision += 1;
      await writeFile(findingsPath, stableJson(findings));
      assert.equal((await validateWorkspace(fixture.workspace, 'preview')).some((item) => item.code === 'FLUTTER_PREVIEW_STALE'), true);
    } finally {
      if (previous === undefined) delete process.env.PSP_FIGMA_FRESHNESS_PATH; else process.env.PSP_FIGMA_FRESHNESS_PATH = previous;
    }
  } finally { await rm(fixture.parent, { recursive: true, force: true }); }
});

test('L1-only orchestration accepts only RFC 3339 review and generates a self-validating Manifest', async () => {
  const fixture = await readyPreviewFixture();
  const previous = process.env.PSP_FIGMA_FRESHNESS_PATH;
  process.env.PSP_FIGMA_FRESHNESS_PATH = fixture.intakePath;
  try {
    let result = run(fixture.workspace, '.agents/skills/flutter-ui/scripts/accept-preview.mjs', ['--accepted-by', 'Reviewer', '--accepted-at', '08/04/2026']);
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(await readFile(resolve(fixture.workspace, '.psp/ui-spec/preview-manifest.json'), 'utf8')).metadata.status, 'reviewing');
    result = run(fixture.workspace, '.agents/skills/flutter-ui/scripts/accept-preview.mjs', ['--accepted-by', 'Reviewer', '--accepted-at', '2026-08-04T10:00:00+08:00']);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    result = run(fixture.workspace, '.agents/skills/flutter-ui/scripts/generate-manifest.mjs');
    assert.equal(result.status, 0, result.stdout || result.stderr);
    result = run(fixture.workspace, '.agents/skills/flutter-ui/scripts/validate.mjs', ['--phase', 'manifest']);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    const manifest = JSON.parse(await readFile(resolve(fixture.workspace, '.psp/ui-spec/manifest.json'), 'utf8'));
    assert.deepEqual(manifest.artifactLocks.map((entry) => entry.artifactId), ['FLUTTER-VISUAL-COVERAGE', 'FLUTTER-UI-PREVIEW', 'REVIEW-FINDINGS']);
  } finally {
    if (previous === undefined) delete process.env.PSP_FIGMA_FRESHNESS_PATH; else process.env.PSP_FIGMA_FRESHNESS_PATH = previous;
    await rm(fixture.parent, { recursive: true, force: true });
  }
});

test('legacy Lit/UIHTML input and missing explicit target are fail-closed', async () => {
  assert.throws(() => rejectLegacy({ artifactId: 'UIHTML-PRODUCTION' }, 'legacy.json'), (error) => error.code === 'FLUTTER_LEGACY_INPUT_FORBIDDEN');
  const schemaCandidate = JSON.parse(await readFile(resolve(skillRoot, 'templates', 'preview-manifest.json'), 'utf8'));
  delete schemaCandidate.preview.target;
  const blockers = await validateSchema(resolve(skillRoot, '..', '..', '..'), '.agents/skills/flutter-ui/schemas/preview-manifest.schema.json', schemaCandidate);
  assert.equal(blockers.length > 0, true);
  const open = spawnSync(process.execPath, [resolve(skillRoot, 'scripts', 'open-preview.mjs')], { cwd: resolve(skillRoot, '..', '..', '..'), encoding: 'utf8' });
  assert.equal(open.status, 1);
  assert.equal(JSON.parse(open.stdout).blockers[0].code, 'FLUTTER_TARGET_REQUIRED');
  const mobile = spawnSync(process.execPath, [resolve(skillRoot, 'scripts', 'open-preview.mjs'), '--target', 'android'], { cwd: resolve(skillRoot, '..', '..', '..'), encoding: 'utf8' });
  assert.equal(mobile.status, 1);
  assert.equal(JSON.parse(mobile.stdout).blockers[0].code, 'FLUTTER_DEVICE_REQUIRED');
  const invalidDate = JSON.parse(await readFile(resolve(skillRoot, 'templates', 'preview-manifest.json'), 'utf8'));
  invalidDate.preview.acceptedAt = 'not-an-iso-date';
  assert.equal((await validateSchema(resolve(skillRoot, '..', '..', '..'), '.agents/skills/flutter-ui/schemas/preview-manifest.schema.json', invalidDate)).length > 0, true);
});

test('contract includes required L1/L2, targets, stale, closure, SDK, and legacy cases', async () => {
  const contract = await readFile(resolve(skillRoot, 'contracts', 'flutter-ui.md'), 'utf8');
  for (const term of ['L1-only', 'L1 + required L2', 'Android/iOS/Web', 'Missing target', 'Missing target SDK', 'digest drift', 'Asset/Font/Token/Motion', 'Mock/Review/Test', 'Preview not accepted', 'Blocker/Major', 'Lit/UIHTML', 'regenerated']) assert.equal(contract.toLowerCase().includes(term.toLowerCase()), true, term);
});
