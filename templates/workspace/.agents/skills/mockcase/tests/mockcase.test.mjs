import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import playwright from '@playwright/test';
import { createServer } from 'vite';
import { parse as parseYaml } from 'yaml';
import { commitManagedWrites } from '../../../../.psp/harness/scripts/lib/artifact-transaction.mjs';
import {
  cleanupTemporaryRepositories,
  runScript,
  temporaryRepository,
} from '../../product-design/tests/helpers/fixture.mjs';
import { completeProductFixture } from '../../product-design/tests/helpers/product-fixture.mjs';
import { jsonText, sha256, stableJson } from '../scripts/lib.mjs';
import { runRuntime } from '../scripts/runtime-runner.mjs';

const workspaceRoot = resolve(import.meta.dirname, '../../../..');

test.after(cleanupTemporaryRepositories);

async function filesBelow(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesBelow(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

test('MockCase is one optional stage/domain/artifact with side-path DAG edges', async () => {
  const manifest = JSON.parse(await readFile(resolve(workspaceRoot, '.psp/harness/harness.manifest.json'), 'utf8'));
  const project = parseYaml(await readFile(resolve(workspaceRoot, 'psp.project.yaml'), 'utf8'));
  assert.equal(project.stages.mockcase.status, 'uninitialized');
  assert.equal(project.stages.mockcase.root, 'MockCase');
  assert.ok(manifest.domainRegistry.some((item) => item.id === 'mockcase'));
  assert.ok(manifest.artifactRegistry.some((item) => item.id === 'mockcase-suite' && item.domain === 'mockcase'));
  assert.ok(manifest.projectDag.nodes.some((item) => item.id === 'mockcase' && item.kind === 'stage'));
  assert.ok(manifest.projectDag.edges.some((item) => item.from === 'use-cases' && item.to === 'mockcase' && item.type === 'dependency'));
  assert.ok(manifest.projectDag.edges.some((item) => item.from === 'canonical-ui-prototype' && item.to === 'mockcase' && item.type === 'dependency'));
  assert.ok(manifest.projectDag.edges.some((item) => item.from === 'canonical-ui-prototype' && item.to === 'mockcase' && item.type === 'handoff'));
  assert.ok(!JSON.stringify(manifest).includes('mockcase-coverage'));
});

test('all MockCase operations and blockers are owned by the MockCase domain', async () => {
  const manifest = JSON.parse(await readFile(resolve(workspaceRoot, '.psp/harness/harness.manifest.json'), 'utf8'));
  const expected = new Map([
    ['apply-mockcase-candidate', 'artifact'],
    ['project-mockcase-runtime', 'projection-refresh'],
    ['review-mockcase', 'review'],
    ['verify-mockcase', 'verification'],
  ]);
  for (const [id, kind] of expected) {
    const operation = manifest.operations.find((item) => item.id === id);
    assert.equal(operation?.kind, kind);
    assert.equal(operation?.domain, 'mockcase');
    assert.equal(operation?.stage, 'mockcase');
  }
  for (const blocker of manifest.blockers.filter((item) => item.code.startsWith('AIH_MOCKCASE_'))) {
    assert.equal(blocker.owner, 'mockcase', blocker.code);
    assert.equal(blocker.domain, 'mockcase', blocker.code);
  }
});

test('Product Design contains only the neutral Review Extension host boundary', async () => {
  const productRoot = resolve(workspaceRoot, '.agents/skills/product-design');
  for (const path of await filesBelow(productRoot)) {
    const text = await readFile(path, 'utf8');
    assert.doesNotMatch(text, /mockcase/i, path);
  }
  const host = await readFile(resolve(productRoot, 'canonical-ui-prototype/template/src/review-shell.ts'), 'utf8');
  assert.match(host, /__PSP_REVIEW_EXTENSIONS__/);
  assert.match(host, /if \(!descriptors \|\| descriptors\.length === 0\) return/);
  assert.match(host, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(host, /URL\.createObjectURL/);
  assert.match(host, /disposers\.splice\(0\)\.reverse\(\)/);
  const extension = await readFile(resolve(workspaceRoot, '.agents/skills/mockcase/runtime/extension.ts'), 'utf8');
  assert.match(extension, /catch \(error\) \{\s*dispose\(\);\s*throw error;/);
});

test('MockData owns payloads while MockCases owns orchestration references', async () => {
  const mockdata = JSON.parse(await readFile(resolve(workspaceRoot, '.agents/skills/mockcase/mockdata.schema.json'), 'utf8'));
  const mockcases = JSON.parse(await readFile(resolve(workspaceRoot, '.agents/skills/mockcase/mockcases.schema.json'), 'utf8'));
  const mockdataText = JSON.stringify(mockdata);
  const mockcasesText = JSON.stringify(mockcases);
  assert.match(mockdataText, /fixture/);
  assert.match(mockdataText, /payload/);
  assert.doesNotMatch(mockdataText, /routeId|scenarioId|expectedStateMatrixEntryId/);
  assert.match(mockcasesText, /routeId/);
  assert.match(mockcasesText, /scenarioId/);
  assert.match(mockcasesText, /behaviorIds/);
  assert.doesNotMatch(mockcasesText, /payload|delayMs|status/);
});

test('candidate hashes are deterministic and atomic post-validation failure rolls back all files', async () => {
  const left = { b: 2, a: [{ z: 3, y: 1 }] };
  const right = { a: [{ y: 1, z: 3 }], b: 2 };
  assert.equal(stableJson(left), stableJson(right));
  assert.equal(sha256(stableJson(left)), sha256(stableJson(right)));

  const root = await mkdtemp(resolve(tmpdir(), 'psp-mockcase-transaction-'));
  try {
    await writeFile(resolve(root, 'suite.json'), 'old-suite\n');
    await writeFile(resolve(root, 'mockdata.json'), 'old-data\n');
    await assert.rejects(commitManagedWrites({
      root,
      ownerId: 'mockcase-suite-ACTOR-001',
      writes: [
        { target: 'suite.json', content: 'new-suite\n' },
        { target: 'mockdata.json', content: 'new-data\n' },
        { target: 'mockcases.json', content: 'new-cases\n' },
      ],
      afterReplace: async () => {
        throw Object.assign(new Error('post validation failed'), { code: 'AIH_MOCKCASE_APPLY_FAILED' });
      },
    }), /post validation failed/);
    assert.equal(await readFile(resolve(root, 'suite.json'), 'utf8'), 'old-suite\n');
    assert.equal(await readFile(resolve(root, 'mockdata.json'), 'utf8'), 'old-data\n');
    await assert.rejects(readFile(resolve(root, 'mockcases.json')), (error) => error.code === 'ENOENT');

    const committed = await commitManagedWrites({
      root,
      ownerId: 'mockcase-cleanup-failure',
      writes: [
        { target: 'suite.json', content: 'committed-suite\n' },
        { target: 'mockdata.json', content: 'committed-data\n' },
      ],
      cleanupBackup: async () => {
        throw new Error('simulated backup cleanup failure');
      },
    });
    assert.ok(committed);
    assert.equal(await readFile(resolve(root, 'suite.json'), 'utf8'), 'committed-suite\n');
    assert.equal(await readFile(resolve(root, 'mockdata.json'), 'utf8'), 'committed-data\n');
    assert.equal((await readdir(root)).filter((item) => item.endsWith('.bak')).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale input locks do not block latest-upstream incremental generation', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const canonicalAuthority = resolve(
    root,
    '01-product-design',
    'Canonical-UI-Prototypes',
    'ACTOR-001',
    'src/spec/canonical-ui.ts',
  );
  const canonicalSource = await readFile(canonicalAuthority, 'utf8');
  const canonicalMatch = canonicalSource.match(/^export const canonicalUi = ([\s\S]+) as const;\s*$/);
  assert.ok(canonicalMatch);
  const canonical = JSON.parse(canonicalMatch[1]);
  const seededScenario = canonical.scenarios.find((item) => item.expectedStateIds.includes('COMPONENT-STATE-ERROR'));
  assert.ok(seededScenario);
  const seedPath = resolve(root, 'mockdata-seed.json');
  await writeFile(seedPath, JSON.stringify({
    fixtures: [{ id: 'FIXTURE-VALIDATION-RESULT', payload: { message: 'invalid reference' } }],
    behaviors: [{
      id: 'BEHAVIOR-VALIDATION-ERROR',
      request: { method: 'GET', path: '/api/validation-result' },
      response: { fixtureId: 'FIXTURE-VALIDATION-RESULT', status: 422, delayMs: 5 },
    }],
    bindings: [{
      scenarioId: seededScenario.id,
      behaviorIds: ['BEHAVIOR-VALIDATION-ERROR'],
    }],
  }, null, 2) + '\n');
  const generateArgs = ['--actor', 'ACTOR-001', '--mockdata', seedPath];
  const first = runScript('.agents/skills/mockcase/scripts/generate.mjs', root, generateArgs);
  assert.equal(first.exitCode, 0, JSON.stringify(first.output, null, 2));
  const initialized = runScript('.agents/skills/mockcase/scripts/initialize.mjs', root, ['--actor', 'ACTOR-001']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const firstCandidate = resolve(root, 'first-candidate.json');
  await writeFile(firstCandidate, JSON.stringify(first.output, null, 2) + '\n');
  const firstApply = runScript('.agents/skills/mockcase/scripts/apply.mjs', root, [
    '--actor', 'ACTOR-001',
    '--input', firstCandidate,
  ]);
  assert.equal(firstApply.exitCode, 0, JSON.stringify(firstApply.output, null, 2));

  await appendFile(canonicalAuthority, '\n');
  const second = runScript('.agents/skills/mockcase/scripts/generate.mjs', root, generateArgs);
  assert.equal(second.exitCode, 0, JSON.stringify(second.output, null, 2));
  assert.notEqual(second.output.inputLock.canonicalUiDigest, first.output.inputLock.canonicalUiDigest);
  assert.deepEqual(second.output.mockDataChanges, {
    upsertFixtures: [],
    removeFixtureIds: [],
    upsertBehaviors: [],
    removeBehaviorIds: [],
  });
  assert.deepEqual(second.output.mockCaseChanges, {
    upsertCases: [],
    removeCaseIds: [],
  });
  const secondCandidate = resolve(root, 'second-candidate.json');
  await writeFile(secondCandidate, JSON.stringify(second.output, null, 2) + '\n');
  const secondApply = runScript('.agents/skills/mockcase/scripts/apply.mjs', root, [
    '--actor', 'ACTOR-001',
    '--input', secondCandidate,
  ]);
  assert.equal(secondApply.exitCode, 0, JSON.stringify(secondApply.output, null, 2));
  const suite = JSON.parse(await readFile(resolve(root, 'MockCase', 'actors', 'ACTOR-001', 'suite.json'), 'utf8'));
  assert.equal(suite.inputLock.canonicalUiDigest, second.output.inputLock.canonicalUiDigest);
});

test('pre-initialization candidate survives normalized initialization and projects an isolated runtime', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const productAuthority = resolve(root, '01-product-design', '.psp/models/use-cases.yaml');
  const canonicalAuthority = resolve(
    root,
    '01-product-design',
    'Canonical-UI-Prototypes',
    'ACTOR-001',
    'src/spec/canonical-ui.ts',
  );
  const productBefore = await readFile(productAuthority);
  const canonicalBefore = await readFile(canonicalAuthority);
  const canonicalMatch = canonicalBefore.toString('utf8').match(/^export const canonicalUi = ([\s\S]+) as const;\s*$/);
  assert.ok(canonicalMatch);
  const canonical = JSON.parse(canonicalMatch[1]);
  canonical.routes.push({
    ...canonical.routes[0],
    id: 'ROUTE-SECONDARY',
    path: '/secondary',
  });
  const canonicalExpected = Buffer.from(`export const canonicalUi = ${JSON.stringify(canonical, null, 2)} as const;\n`);
  await writeFile(canonicalAuthority, canonicalExpected);
  const seededScenario = canonical.scenarios.find((item) => item.expectedStateIds.includes('COMPONENT-STATE-ERROR'));
  assert.ok(seededScenario);
  const seedPath = resolve(root, 'mockdata-seed.json');
  await writeFile(seedPath, JSON.stringify({
    fixtures: [
      { id: 'FIXTURE-VALIDATION-RESULT', payload: { message: 'slow response', source: 'slow' } },
      { id: 'FIXTURE-VALIDATION-FAST', payload: { message: 'fast response', source: 'fast' } },
      { id: 'FIXTURE-HEADER-ORIGINAL', payload: { message: 'original request', source: 'header-original' } },
      { id: 'FIXTURE-HEADER-OVERRIDE', payload: { message: 'override request', source: 'header-override' } },
    ],
    behaviors: [
      {
        id: 'BEHAVIOR-VALIDATION-ERROR',
        request: { method: 'GET', path: '/api/validation-result', query: { variant: 'slow' } },
        response: { fixtureId: 'FIXTURE-VALIDATION-RESULT', status: 422, delayMs: 250 },
      },
      {
        id: 'BEHAVIOR-VALIDATION-FAST',
        request: { method: 'GET', path: '/api/validation-result', query: { variant: 'fast' } },
        response: { fixtureId: 'FIXTURE-VALIDATION-FAST', status: 422, delayMs: 5 },
      },
      {
        id: 'BEHAVIOR-HEADER-ORIGINAL',
        request: { method: 'GET', path: '/api/request-init', headers: { 'x-mode': 'original' } },
        response: { fixtureId: 'FIXTURE-HEADER-ORIGINAL', status: 200 },
      },
      {
        id: 'BEHAVIOR-HEADER-OVERRIDE',
        request: { method: 'GET', path: '/api/request-init', headers: { 'x-mode': 'override' } },
        response: { fixtureId: 'FIXTURE-HEADER-OVERRIDE', status: 200 },
      },
    ],
    bindings: [{
      scenarioId: seededScenario.id,
      behaviorIds: [
        'BEHAVIOR-VALIDATION-ERROR',
        'BEHAVIOR-VALIDATION-FAST',
        'BEHAVIOR-HEADER-ORIGINAL',
        'BEHAVIOR-HEADER-OVERRIDE',
      ],
    }],
  }, null, 2) + '\n');

  const generateArgs = ['--actor', 'ACTOR-001', '--mockdata', seedPath];
  const first = runScript('.agents/skills/mockcase/scripts/generate.mjs', root, generateArgs);
  assert.equal(first.exitCode, 0, JSON.stringify(first.output, null, 2));
  assert.equal(first.output.status, 'PASS');
  assert.ok(first.output.mockDataChanges.upsertFixtures.some((item) =>
    item.id === 'FIXTURE-VALIDATION-RESULT'));
  assert.ok(first.output.mockCaseChanges.upsertCases.some((item) =>
    item.effects.some((effect) => effect.behaviorIds.includes('BEHAVIOR-VALIDATION-ERROR'))));
  assert.deepEqual(first.output.inputLock.schemaVersions, {
    suite: '1.0.0',
    mockdata: '1.0.0',
    mockcases: '1.0.0',
  });
  await appendFile(resolve(root, 'README.md'), '\nUnrelated fixture change.\n');
  const unrelated = runScript('.agents/skills/mockcase/scripts/generate.mjs', root, generateArgs);
  assert.equal(unrelated.exitCode, 0, JSON.stringify(unrelated.output, null, 2));
  assert.equal(unrelated.output.candidateHash, first.output.candidateHash);

  const candidatePath = resolve(root, 'mockcase-candidate.json');
  await writeFile(candidatePath, JSON.stringify(first.output, null, 2) + '\n');
  const initialized = runScript('.agents/skills/mockcase/scripts/initialize.mjs', root, ['--actor', 'ACTOR-001']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  assert.equal(initialized.output.downstreamAction, 'NOT_RUN');
  const emptySuiteValidation = runScript('.agents/skills/mockcase/scripts/validate.mjs', root, ['--actor', 'ACTOR-001']);
  assert.equal(emptySuiteValidation.exitCode, 1, JSON.stringify(emptySuiteValidation.output, null, 2));
  assert.equal(emptySuiteValidation.output.blockers[0].code, 'AIH_MOCKCASE_COVERAGE_FAILED');
  const tamperedCandidatePath = resolve(root, 'tampered-mockcase-candidate.json');
  await writeFile(tamperedCandidatePath, JSON.stringify({
    ...first.output,
    candidateHash: `sha256:${'0'.repeat(64)}`,
  }, null, 2) + '\n');
  const tamperedApply = runScript('.agents/skills/mockcase/scripts/apply.mjs', root, [
    '--actor', 'ACTOR-001',
    '--input', tamperedCandidatePath,
  ]);
  assert.equal(tamperedApply.exitCode, 1, JSON.stringify(tamperedApply.output, null, 2));
  assert.equal(tamperedApply.output.blockers[0].code, 'AIH_MOCKCASE_CANDIDATE_STALE');
  const applied = runScript('.agents/skills/mockcase/scripts/apply.mjs', root, [
    '--actor', 'ACTOR-001',
    '--input', candidatePath,
  ]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));
  assert.equal(applied.output.lifecycle, 'MAPPED');
  const mockcasesPath = resolve(root, 'MockCase', 'actors', 'ACTOR-001', 'mockcases.json');
  const suitePath = resolve(root, 'MockCase', 'actors', 'ACTOR-001', 'suite.json');
  const persistedMockcases = JSON.parse(await readFile(mockcasesPath, 'utf8'));
  const sourceCase = persistedMockcases.cases.find((item) => item.scenarioId === seededScenario.id);
  assert.ok(sourceCase);
  persistedMockcases.cases.push({
    id: 'MOCK-CASE-SECONDARY-TECHNICAL',
    kind: 'technical',
    label: 'Secondary route technical case',
    routeId: 'ROUTE-SECONDARY',
    effects: structuredClone(sourceCase.effects),
    isDefault: true,
  });
  persistedMockcases.cases.sort((left, right) => left.id.localeCompare(right.id));
  await writeFile(mockcasesPath, jsonText(persistedMockcases));
  const persistedSuite = JSON.parse(await readFile(suitePath, 'utf8'));
  persistedSuite.files['mockcases.json'] = sha256(jsonText(persistedMockcases));
  await writeFile(suitePath, jsonText(persistedSuite));
  const projected = runScript('.agents/skills/mockcase/scripts/project.mjs', root, ['--actor', 'ACTOR-001']);
  assert.equal(projected.exitCode, 0, JSON.stringify(projected.output, null, 2));
  const validated = runScript('.agents/skills/mockcase/scripts/validate.mjs', root, ['--actor', 'ACTOR-001']);
  assert.equal(validated.exitCode, 0, JSON.stringify(validated.output, null, 2));
  assert.equal(validated.output.lifecycle, 'MAPPED');

  const runtime = JSON.parse(await readFile(resolve(root, projected.output.output), 'utf8'));
  assert.equal(runtime.hostApiVersion, 'psp.review-extension/v1');
  assert.ok(runtime.cases.every((item) => item.effects.every((effect) => Array.isArray(effect.expectedStateIds))));
  const dependencyRequire = createRequire(process.env.PRE_SDD_DEPENDENCY_ENTRY || import.meta.url);
  const server = await createServer({
    root: resolve(root, '01-product-design', 'Canonical-UI-Prototypes', 'ACTOR-001'),
    configFile: false,
    logLevel: 'silent',
    resolve: {
      alias: [
        { find: 'lit', replacement: dependencyRequire.resolve('lit') },
        { find: 'msw/browser', replacement: dependencyRequire.resolve('msw/browser') },
        { find: 'msw', replacement: dependencyRequire.resolve('msw') },
      ],
    },
    server: { host: '127.0.0.1', port: 0 },
  });
  const previousRepositoryRoot = process.env.PSP_REPOSITORY_ROOT;
  const previousHarnessRoot = process.env.AI_HARNESS_ROOT;
  const previousArgv = process.argv;
  try {
    await server.listen();
    const address = server.httpServer.address();
    assert.ok(address && typeof address === 'object');
    const reviewUrl = `http://127.0.0.1:${address.port}/`;
    const browser = await playwright.chromium.launch({ headless: true });
    try {
      const browserContext = await browser.newContext();
      await browserContext.addInitScript(() => {
        const original = globalThis.addEventListener.bind(globalThis);
        Object.defineProperty(globalThis, '__pspPagehideListenerCount', {
          value: { count: 0 },
          configurable: false,
          writable: false,
        });
        globalThis.addEventListener = ((type, listener, options) => {
          if (type === 'pagehide') globalThis.__pspPagehideListenerCount.count += 1;
          return original(type, listener, options);
        });
      });
      const page = await browserContext.newPage();
      const extensionRequests = [];
      page.on('request', (request) => {
        if (request.url().includes('mockcase-extension')) extensionRequests.push(request.url());
      });
      await page.goto(reviewUrl, { waitUntil: 'networkidle' });
      assert.deepEqual(extensionRequests, []);
      assert.equal(await page.locator('[data-review-tool="mockcase"]').count(), 0);
      assert.deepEqual(await page.evaluate(() => ({
        runtimeApi: typeof globalThis.__pspMockcaseRuntimeApi,
        pagehideListeners: globalThis.__pspPagehideListenerCount.count,
      })), { runtimeApi: 'undefined', pagehideListeners: 0 });
      await browserContext.close();
    } finally {
      await browser.close();
    }
    process.env.PSP_REPOSITORY_ROOT = root;
    process.env.AI_HARNESS_ROOT = root;
    process.argv = [
      process.execPath,
      'verify.mjs',
      '--actor',
      'ACTOR-001',
      '--review-url',
      reviewUrl,
    ];
    let fastMatch;
    let requestOverrideMatch;
    await assert.rejects(
      runRuntime('review'),
      (error) => error.code === 'AIH_COMMAND_INVALID',
    );
    const reviewed = await runRuntime('review', {
      interactiveReview: true,
      launchHeadless: true,
      onPageReady: async (page) => {
        await page.evaluate(
          (caseId) => globalThis.__pspMockcaseRuntimeApi.apply([caseId]),
          `MOCK-CASE-${seededScenario.id}`,
        );
        fastMatch = await page.evaluate(async () => {
          const started = performance.now();
          const response = await fetch('/api/validation-result?variant=fast');
          return {
            elapsedMs: performance.now() - started,
            payload: await response.json(),
          };
        });
        requestOverrideMatch = await page.evaluate(async () => {
          const request = new Request(`${location.origin}/api/request-init`, {
            method: 'GET',
            headers: { 'x-mode': 'original' },
          });
          const response = await fetch(request, {
            headers: { 'x-mode': 'override' },
          });
          return response.json();
        });
      },
      onInteractiveReady: async (page) => {
        await page.locator('[data-review-action="complete"]').click();
      },
    });
    assert.equal(reviewed.status, 'PASS', JSON.stringify(reviewed, null, 2));
    assert.equal(reviewed.lifecycle, 'READY');
    assert.equal(fastMatch.payload.source, 'fast');
    assert.ok(fastMatch.elapsedMs < 150, `fast matcher used wrong delay: ${fastMatch.elapsedMs}ms`);
    assert.equal(requestOverrideMatch.source, 'header-override');
    let interactiveControls;
    const interactive = await runRuntime('review', {
      interactiveReview: true,
      launchHeadless: true,
      onInteractiveReady: async (page) => {
        interactiveControls = await page.locator('[data-review-action]').allTextContents();
        const complete = page.locator('[data-review-action="complete"]');
        await page.locator(`[data-case-id="MOCK-CASE-${seededScenario.id}"]`).click();
        assert.equal(await complete.isDisabled(), true);
        await page.waitForFunction(() => {
          const button = document.querySelector('[data-review-action="complete"]');
          return button instanceof HTMLButtonElement && !button.disabled;
        });
        await complete.click();
      },
    });
    assert.equal(interactive.lifecycle, 'READY');
    assert.deepEqual(interactiveControls, ['完成评审', '取消']);
    const interactiveEvidence = JSON.parse(await readFile(resolve(root, interactive.evidence), 'utf8'));
    assert.ok(interactiveEvidence.facts.some((item) =>
      item.kind === 'review-decision' && item.decision === 'complete'));
    const completedEvidenceText = await readFile(resolve(root, interactive.evidence), 'utf8');
    await assert.rejects(
      runRuntime('review', {
        interactiveReview: true,
        launchHeadless: true,
        onInteractiveReady: async (page) => {
          await page.locator('[data-review-action="cancel"]').click();
        },
      }),
      (error) => error.code === 'AIH_MOCKCASE_REVIEW_CANCELLED',
    );
    assert.equal(await readFile(resolve(root, interactive.evidence), 'utf8'), completedEvidenceText);
    const ready = runScript('.agents/skills/mockcase/scripts/validate.mjs', root, ['--actor', 'ACTOR-001']);
    assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));
    assert.equal(ready.output.lifecycle, 'READY');
    const verified = await runRuntime('verify');
    assert.equal(verified.status, 'PASS', JSON.stringify(verified, null, 2));
    assert.equal(verified.lifecycle, 'VERIFIED');
    assert.equal(runtime.cases.length, JSON.parse(await readFile(resolve(root, verified.evidence), 'utf8')).facts.filter((item) => item.kind === 'case').length);
    const validVerifyEvidence = await readFile(resolve(root, verified.evidence), 'utf8');
    const forgedEvidence = { ...JSON.parse(validVerifyEvidence), facts: [] };
    await writeFile(resolve(root, verified.evidence), JSON.stringify(forgedEvidence, null, 2) + '\n');
    const forgedStatus = runScript('.agents/skills/mockcase/scripts/validate.mjs', root, ['--actor', 'ACTOR-001']);
    assert.equal(forgedStatus.exitCode, 0, JSON.stringify(forgedStatus.output, null, 2));
    assert.notEqual(forgedStatus.output.lifecycle, 'VERIFIED');
    await writeFile(resolve(root, verified.evidence), validVerifyEvidence);
    const verifiedStatus = runScript('.agents/skills/mockcase/scripts/validate.mjs', root, ['--actor', 'ACTOR-001']);
    assert.equal(verifiedStatus.exitCode, 0, JSON.stringify(verifiedStatus.output, null, 2));
    assert.equal(verifiedStatus.output.lifecycle, 'VERIFIED');
    await appendFile(resolve(root, projected.output.output), '\n');
    const stale = runScript('.agents/skills/mockcase/scripts/validate.mjs', root, ['--actor', 'ACTOR-001']);
    assert.equal(stale.exitCode, 0, JSON.stringify(stale.output, null, 2));
    assert.equal(stale.output.lifecycle, 'STALE');
  } finally {
    process.argv = previousArgv;
    if (previousRepositoryRoot === undefined) delete process.env.PSP_REPOSITORY_ROOT;
    else process.env.PSP_REPOSITORY_ROOT = previousRepositoryRoot;
    if (previousHarnessRoot === undefined) delete process.env.AI_HARNESS_ROOT;
    else process.env.AI_HARNESS_ROOT = previousHarnessRoot;
    await server.close();
  }
  assert.deepEqual(await readFile(productAuthority), productBefore);
  assert.deepEqual(await readFile(canonicalAuthority), canonicalExpected);
});
