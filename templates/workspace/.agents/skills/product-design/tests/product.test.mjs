import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { stringify as stringifyYaml } from 'yaml';
import { cleanupTemporaryRepositories, codes, runScript, temporaryRepository } from './helpers/fixture.mjs';
import { completeProductFixture, fixtureProject, readArtifact, writeArtifact } from './helpers/product-fixture.mjs';
import { migrateLegacyWireflowDirectory } from '../scripts/lib/migrate-legacy-wireflow.mjs';
import { canonicalLocks, reviewEvidenceDirectory } from '../canonical-ui-prototype/scripts/integrity.mjs';
import { verifyVisualAcceptance, visualAcceptanceRecordPath } from '../canonical-ui-prototype/scripts/visual-acceptance.mjs';

test.after(cleanupTemporaryRepositories);

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

async function canonicalFixture(root) {
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const areaPath = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root, 'ACTOR-001');
  const path = resolve(areaPath, 'src/spec/canonical-ui.ts');
  const text = await readFile(path, 'utf8');
  const match = text.match(/^export const canonicalUi = ([\s\S]+) as const;\s*$/);
  assert.ok(match, 'canonical-ui.ts must remain a static object literal');
  return { areaPath, path, model: JSON.parse(match[1]) };
}

async function writeCanonical(path, model) {
  await writeFile(path, 'export const canonicalUi = ' + JSON.stringify(model, null, 2) + ' as const;\n');
}

async function writeReviewEvidence(root, actors) {
  const evidence = {
    version: '1.0.0',
    status: 'PASS',
    reviewId: 'review-' + 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    stage: 'product-design',
    actors: actors.map((item) => ({
      actor: item.actor,
      draftVersion: item.draftVersion,
      implementationHash: item.implementationHash,
      buildInputHash: item.buildInputs.contentHash,
      reviewAddress: 'http://127.0.0.1:4173/?review=' + item.implementationHash.slice('sha256:'.length),
      screenshots: ['fixture-review.png'],
    })),
    validation: [{ id: 'fixture-pass', status: 'PASS', blockers: [] }],
    markers: [],
  };
  const directory = reviewEvidenceDirectory(root);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, 'review-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
}

async function prepareExactFixture(root) {
  const { areaPath, path, model } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  const guidedRuntime = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(guidedRuntime.exitCode, 0, JSON.stringify(guidedRuntime.output, null, 2));
  const routeBaseline = guidedRuntime.output.evidence.find((item) => item.kind === 'route' && item.viewportId === 'VIEWPORT-DESKTOP').screenshot;
  const baselineContent = await readFile(routeBaseline);
  const baselineRelativePath = 'design-sources/DESIGN-SOURCE-001/exact-desktop.png';
  const baselinePath = resolve(areaPath, baselineRelativePath);
  await writeFile(baselinePath, baselineContent);
  const evidencePath = resolve(areaPath, model.designSources[0].evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.items.push({ id: 'EVIDENCE-EXACT-DESKTOP', role: 'screenshot', path: baselineRelativePath, sha256: sha256(baselineContent) });
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);

  const exact = structuredClone(model);
  exact.visualPolicy = {
    mode: 'exact',
    selectedBy: 'user-explicit',
    aspects: ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'],
    coverage: [{ sourceId: 'DESIGN-SOURCE-001', screenId: 'SCREEN-001', stateIds: exact.states.map((item) => item.id), viewportIds: ['VIEWPORT-DESKTOP'], evidenceItemIds: ['EVIDENCE-EXACT-DESKTOP'] }],
  };
  exact.repairPolicy.enabled = true;
  exact.designSources[0].evidence.sha256 = sha256(evidenceText);
  exact.designSources[0].coverage[0].viewportIds = ['VIEWPORT-DESKTOP'];
  exact.designSources[0].coverage[0].evidenceItemIds.push('EVIDENCE-EXACT-DESKTOP');
  exact.viewports = exact.viewports.filter((item) => item.id === 'VIEWPORT-DESKTOP');
  exact.scenarios = [];
  exact.mockCases.forEach((item) => { item.kind = 'technical'; delete item.scenarioId; });
  exact.renderAssertions = exact.renderAssertions.filter((item) => !item.scenarioId).map((item) => ({ ...item, viewportIds: ['VIEWPORT-DESKTOP'] }));
  exact.sourceParityAssertions = [{
    id: 'PARITY-EXACT-DESKTOP',
    sourceId: 'DESIGN-SOURCE-001',
    routeId: 'ROUTE-001',
    viewportId: 'VIEWPORT-DESKTOP',
    baselineEvidenceItemId: 'EVIDENCE-EXACT-DESKTOP',
    aspects: exact.visualPolicy.aspects,
    checks: [
      { kind: 'screenshot-match' },
      { kind: 'computed-style', targetId: 'CONTROL-001', property: 'background-color', expected: 'rgb(200, 243, 106)' },
    ],
  }];
  await writeCanonical(path, exact);
  const exactInput = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(exactInput.exitCode, 0, JSON.stringify(exactInput.output, null, 2));
  const exactRuntime = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(exactRuntime.exitCode, 0, JSON.stringify(exactRuntime.output, null, 2));
  return { areaPath, path, model: exact, appPath, app, baselinePath };
}

test('uninitialized product stage is a valid empty scaffold but cannot pass readiness', async () => {
  const root = await temporaryRepository();
  const structure = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--json']);
  assert.equal(structure.exitCode, 0, JSON.stringify(structure.output, null, 2));
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(strict).has('AIH_STAGE_UNINITIALIZED'));
});

test('generic initialization creates atomic UC and provider-neutral Visual Spec models without an independent interaction collection', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  assert.equal(stage.status, 'active');
  assert.deepEqual(Object.keys(stage.artifacts), ['capabilities', 'visual-spec', 'canonical-ui-prototype']);
  assert.equal(stage.areas['canonical-ui-prototypes'].root, 'Canonical-UI-Prototypes');
  assert.equal(stage.artifacts['html-mock'], undefined);
  const initialUseCases = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  assert.match(initialUseCases, /Product Behavior/);
  assert.match(initialUseCases, /Interaction Flow/);
  assert.match(initialUseCases, /Low-Fi UI Blueprint/);
  assert.match(initialUseCases, /尚未判断 UI 适用性/);
  assert.equal(await stat(resolve(root, stage.root, stage.artifacts.capabilities.internalModel)).then(() => true), true);
  const initialVisualSpec = await readFile(resolve(root, stage.root, stage.artifacts['visual-spec'].outputs[0].path), 'utf8');
  assert.match(initialVisualSpec, /Provider-neutral Visual Spec Intake/);
  assert.match(initialVisualSpec, /Runtime（运行环境）/);
  assert.equal(await stat(resolve(root, stage.root, stage.artifacts['visual-spec'].internalModel)).then(() => true), true);
  const prototypeRoot = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root);
  assert.deepEqual(await readdir(prototypeRoot), []);
  const templateRoot = resolve(root, '.agents/skills/product-design/canonical-ui-prototype/template');
  const source = resolve(templateRoot, 'src/spec/canonical-ui.ts');
  const canonicalSource = await readFile(source, 'utf8');
  assert.match(canonicalSource, /export const canonicalUi/);
  assert.match(canonicalSource, /viewports: \[\]/);
  assert.doesNotMatch(canonicalSource, /accessibility\s*:/);
  assert.match(await readFile(resolve(templateRoot, 'src/main.ts'), 'utf8'), /import '\.\/inconsistency-annotator';/);
  const annotator = await readFile(resolve(templateRoot, 'src/inconsistency-annotator.ts'), 'utf8');
  assert.match(annotator, /URLSearchParams\(window\.location\.search\)\.get\('annotate'\) !== '0'/);
  assert.match(annotator, /position: fixed; z-index: 2147483600; top: 20px; right: 20px;/);
  assert.match(annotator, /const image = this\.captureViewport\(markers\);/);
  assert.equal((annotator.match(/navigator\.clipboard\.write/g) || []).length, 1);
  assert.match(annotator, /data-action="download"/);
  assert.match(annotator, /pageKey: string/);
  assert.match(annotator, /new MutationObserver\(this\.schedulePageRefresh\)/);
  assert.match(annotator, /querySelectorAll<HTMLElement>\('\[data-screen-id\]'\)/);
  assert.match(annotator, /marker\.pageKey === this\.currentPageKey/);
  const runtime = await readFile(resolve(root, '.agents/skills/product-design/canonical-ui-prototype/scripts/runtime.mjs'), 'utf8');
  assert.match(runtime, /server\.resolvedUrls\?\.local\?\.\[0\]/);
  assert.doesNotMatch(runtime, /searchParams\.set\('annotate', '1'\)/);
  assert.doesNotMatch(runtime, /runRepairGate|runReviewReadiness|executeRegisteredCommand/);
  assert.match(runtime, /独立应用评审地址/);
  const manifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  assert.equal(manifest.validationProfiles.some((item) => item.id === 'canonical-ui-review-readiness'), true);
  const skill = await readFile(resolve(root, '.agents/skills/product-design/SKILL.md'), 'utf8');
  assert.match(skill, /AIH_CANONICAL_UI_SERVER_FAILED/);
  assert.match(skill, /不得根据默认端口猜测或伪造地址/);
  assert.ok((await stat(resolve(templateRoot, 'public/vendor/html2canvas-1.4.1.min.js'))).isFile());
});

test('Use Cases validator blocks invalid actors, startsAt references, and duplicate identifiers', async () => {
  const cases = [
    {
      mutate(data) { data.useCases[0].actor = 'ACTOR-999'; },
      message: /Actor 引用不存在：ACTOR-999/,
    },
    {
      mutate(data) { data.useCases[0].alternateScenarios[0].startsAt = 'UC-001-STEP-99'; },
      message: /startsAt 未引用当前 Use Case 主步骤：UC-001-STEP-99/,
    },
    {
      mutate(data) { data.actors.push({ ...data.actors[0], name: '重复参与者' }); },
      message: /标识重复：ACTOR-001/,
    },
  ];

  for (const invalidCase of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    invalidCase.mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
    assert.match(result.output.blockers.map((item) => item.message).join('\n'), invalidCase.message);
  }
});

test('Use Cases readiness detects drift in UC.md', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const uc = stage.artifacts.capabilities.outputs[0];
  await appendFile(resolve(root, stage.root, uc.path), '\nmanual use case edit\n');
  const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.ok(codes(result).has('AIH_GENERATED_DRIFT'));
});

test('Visual Spec has independent apply, readiness, UC references, Variant coverage, asset integrity, and deterministic projection', async () => {
  const blockedRoot = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', blockedRoot, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const blockedProject = await fixtureProject(blockedRoot);
  const blockedStage = blockedProject.stages['product-design'];
  const blockedVisual = await readArtifact(blockedRoot, blockedStage, blockedStage.artifacts['visual-spec']);
  const blockedApply = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', blockedRoot, [
    '--operation', 'apply-visual-spec', '--artifact', 'visual-spec', '--input', blockedVisual.path, '--json',
  ]);
  assert.ok(codes(blockedApply).has('AIH_UPSTREAM_NOT_READY'));

  const root = await temporaryRepository();
  await completeProductFixture(root);
  const ready = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts['visual-spec'];
  const visual = await readArtifact(root, stage, binding);
  const applied = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-visual-spec', '--artifact', 'visual-spec', '--input', visual.path, '--dry-run', '--json',
  ]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));
  assert.deepEqual(applied.output.targets.sort(), [
    stage.root + '/' + binding.internalModel,
    stage.root + '/' + binding.outputs[0].path,
  ].sort());
  const markdownPath = resolve(root, stage.root, binding.outputs[0].path);
  const markdown = await readFile(markdownPath, 'utf8');
  assert.match(markdown, /Pages 与 Renderings/);
  assert.match(markdown, /emphasis=primary\/secondary/);
  assert.match(markdown, /assets\/status\.svg/);

  visual.data.pages[0].useCaseRefs = ['UC-999'];
  await writeArtifact(visual);
  const unresolved = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(unresolved).has('AIH_REFERENCE_UNRESOLVED'));

  visual.data.pages[0].useCaseRefs = ['UC-001'];
  visual.data.components[0].visualCases.pop();
  await writeArtifact(visual);
  const incomplete = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(incomplete).has('AIH_ARTIFACT_INCOMPLETE'));

  visual.data.components[0].visualCases.push({
    id: 'VISUAL-CASE-006', name: 'INT-STATE-003 secondary', interactionStateRef: 'INT-STATE-003',
    variants: [{ name: 'emphasis', value: 'secondary' }], visual: structuredClone(visual.data.components[0].visualCases[0].visual),
  });
  await writeArtifact(visual);
  await appendFile(resolve(root, stage.root, 'assets/status.svg'), '<!-- drift -->\n');
  const integrity = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(integrity).has('AIH_SOURCE_INTEGRITY_FAILED'));

  await appendFile(markdownPath, 'manual drift\n');
  const drift = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'visual-spec', '--json']);
  assert.ok(codes(drift).has('AIH_GENERATED_DRIFT'));
});

test('atomic UC readiness covers behavior, flow, Low-Fi, failure recovery, and deterministic projection', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const markdown = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  assert.match(markdown, /Product Behavior（产品行为）/);
  assert.match(markdown, /Interaction Flow（正式交互流程）/);
  assert.match(markdown, /Low-Fi UI Blueprints/);
  assert.match(markdown, /失败、重试、恢复与返回/);
  assert.match(markdown, /UC-001-EXC-01-STEP-01/);
  assert.match(markdown, /LF-SCREEN-001/);
  assert.match(markdown, /IF-001-TRANS-01、IF-001-TRANS-02/);
  assert.match(markdown, /规格引用无效；Package 中存在无法解析的引用/);
  assert.match(markdown, /<summary>查看 Transition 与 UC 步骤追溯<\/summary>/);
  assert.match(markdown, /Interaction State Catalog（交互状态目录）/);
  assert.match(markdown, /<summary>查看完整状态定义<\/summary>/);
  assert.doesNotMatch(markdown, /派生行为摘要/);
  assert.doesNotMatch(markdown, /#### Business Rules（业务规则）/);
  assert.doesNotMatch(markdown, /\| 用户动作 \| 系统响应 \|/);
  assert.equal(markdown.match(/只有结构与引用全部有效的 Package 才能通过验证/g)?.length, 1);
  assert.equal(markdown.match(/规格作者可以提交验证请求/g)?.length, 1);
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
  const check = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--check', '--json']);
  assert.equal(check.exitCode, 0, JSON.stringify(check.output, null, 2));
});

test('atomic UC readiness blocks incomplete flow, traceability, blueprint, and exception recovery', async () => {
  const cases = [
    {
      mutate(data) { data.interactionFlows = []; },
      message: /UI Use Case 必须且只能有一个正式 Interaction Flow/,
    },
    {
      mutate(data) { data.interactionFlows[0].transitions[0].useCaseStepRefs = ['UC-001-EXC-01-STEP-01']; },
      message: /Use Case step 引用不存在|Use Case 步骤未追溯到 Transition/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints = []; },
      message: /UI Use Case 必须映射到至少一个 Low-Fi Screen/,
    },
    {
      mutate(data) { data.interactionFlows[0].transitions[1].failureResponse = null; },
      message: /异常场景必须正式声明失败、重试、恢复与返回决定/,
    },
  ];
  for (const invalidCase of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    invalidCase.mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
    assert.match(result.output.blockers.map((item) => item.message).join('\n'), invalidCase.message);
  }
});

test('atomic UC schema rejects duplicated derived facts', async () => {
  const cases = [
    (data) => { data.businessRules[0].appliesTo = ['UC-001']; },
    (data) => { data.interactionFlows[0].coveredScenarios = ['main', 'UC-001-EXC-01']; },
    (data) => { data.interactionFlows[0].transitions[0].userAction = '提交验证'; },
    (data) => { data.interactionFlows[0].transitions[0].systemResponse = '显示结果'; },
    (data) => { data.interactionFlows[0].transitions[1].failureResponse.failure = '引用无效'; },
    (data) => { data.lowFiUiBlueprints[0].useCases = ['UC-001']; },
  ];
  for (const mutate of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.ok(codes(result).has('AIH_ARTIFACT_SCHEMA_FAILED'), JSON.stringify(result.output, null, 2));
  }
});

test('atomic UC closure validates rules, states, actors, Screens, and Control traceability', async () => {
  const cases = [
    {
      mutate(data) { data.businessRules.push({ id: 'BR-002', statement: '未引用规则' }); },
      message: /Business Rule 未被任何 Use Case 引用：BR-002/,
    },
    {
      mutate(data) { data.interactionStates.push({ id: 'INT-STATE-004', name: '孤立状态', type: 'waiting', description: '未进入任何流程', terminal: false }); },
      message: /Interaction State 未被任何 Interaction Flow 使用：INT-STATE-004/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints[0].screens[0].regions[1].controls[0].transitionRefs = []; },
      message: /可交互 Low-Fi Control 必须追溯至少一个 Transition/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints[0].screens[0].regions[1].controls[0].transitionRefs = ['IF-999-TRANS-01']; },
      message: /Transition 引用不存在：IF-999-TRANS-01/,
    },
    {
      mutate(data) {
        data.actors.push({ id: 'ACTOR-002', name: '其他角色', goal: '执行其他验证' });
        data.useCases[0].actor = 'ACTOR-002';
      },
      message: /Low-Fi Control 引用了其他 Actor 的 Transition/,
    },
    {
      mutate(data) { data.lowFiUiBlueprints[0].screens[0].useCases = []; },
      message: /Low-Fi Control 引用的 Transition 不属于当前 Screen 的 Use Case/,
    },
    {
      mutate(data) {
        data.actors.push({ id: 'ACTOR-002', name: '其他角色', goal: '执行其他验证' });
        data.useCases.push({
          id: 'UC-002', name: '执行其他验证', actor: 'ACTOR-002', goal: '完成其他验证', value: '获得结果', trigger: '角色请求验证',
          preconditions: [], successOutcome: '显示成功', minimumGuarantee: '保留输入', uiApplicability: { mode: 'required', reason: null },
          mainScenario: [{ id: 'UC-002-STEP-01', initiator: 'actor', action: '提交其他验证', outcome: '系统显示结果' }],
          alternateScenarios: [], businessRules: ['BR-001'], relationships: [],
        });
        data.interactionFlows.push({
          id: 'IF-002', useCase: 'UC-002', name: '其他验证', entryState: 'INT-STATE-001', completionStates: ['INT-STATE-002'],
          transitions: [{ id: 'IF-002-TRANS-01', scenarioRef: 'main', useCaseStepRefs: ['UC-002-STEP-01'], from: 'INT-STATE-001', to: 'INT-STATE-002', guard: null, branchLabel: null, failureResponse: null }],
        });
      },
      message: /共享 Interaction State 只能用于同一 Actor 的 Use Case/,
    },
  ];
  for (const invalidCase of cases) {
    const root = await temporaryRepository();
    await completeProductFixture(root);
    const project = await fixtureProject(root);
    const stage = project.stages['product-design'];
    const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
    invalidCase.mutate(artifact.data);
    await writeArtifact(artifact);
    const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
    assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
    assert.match(result.output.blockers.map((item) => item.message).join('\n'), invalidCase.message);
  }
});

test('system-initiated Transition does not require a Low-Fi Control reference', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
  artifact.data.lowFiUiBlueprints[0].screens[0].regions[1].controls[0].transitionRefs = ['IF-001-TRANS-01'];
  await writeArtifact(artifact);
  const rendered = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.output, null, 2));
  const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
});

test('atomic UC transitions require runnable UI HTML branch and recovery coverage', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const missingBranch = structuredClone(model);
  for (const scenario of missingBranch.scenarios) scenario.transitionIds = ['IF-001-TRANS-01'];
  await writeCanonical(path, missingBranch);
  const branch = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(branch).has('AIH_CANONICAL_UI_FLOW_COVERAGE_FAILED'));

  const missingRecovery = structuredClone(model);
  missingRecovery.scenarios.find((item) => item.id === 'SCENARIO-003').recoveryStateIds = [];
  await writeCanonical(path, missingRecovery);
  const recovery = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(recovery).has('AIH_CANONICAL_UI_FLOW_COVERAGE_FAILED'));
});

test('non-UI Use Case is explicit and requires neither flow nor Low-Fi blueprint', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
  artifact.data.useCases[0].uiApplicability = { mode: 'not-applicable', reason: '该用例由离线批处理完成，不提供用户界面。' };
  artifact.data.interactionStates = [];
  artifact.data.interactionFlows = [];
  artifact.data.lowFiUiBlueprints = [];
  await writeArtifact(artifact);
  const render = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
  const markdown = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  assert.match(markdown, /不适用（该用例由离线批处理完成，不提供用户界面。/);
});

test('legacy Wireflow is accepted only as a one-time input and converts into the atomic UC model', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const artifact = await readArtifact(root, stage, stage.artifacts.capabilities);
  const candidate = structuredClone(artifact.data);
  for (const useCase of candidate.useCases) delete useCase.uiApplicability;
  delete candidate.interactionStates;
  delete candidate.interactionFlows;
  delete candidate.lowFiUiBlueprints;
  const legacyRoot = resolve(root, 'legacy-wireflow-input');
  await mkdir(resolve(legacyRoot, 'ACTOR-001'), { recursive: true });
  const stateDelta = { show: ['REGION-001'], hide: [], enable: ['CONTROL-001'], disable: [], content: [] };
  const legacy = {
    apiVersion: 'psp.dev/v1',
    kind: 'WireflowMidSpecification',
    metadata: { status: 'ready', version: '1.0.0', upstreamArtifact: 'capabilities', actor: 'ACTOR-001' },
    siteMap: { entryScreen: 'SCREEN-001', nodes: [{ screen: 'SCREEN-001', parent: null }] },
    screens: [{
      id: 'SCREEN-001', name: '规格检查页', purpose: '提交并查看结果', useCases: ['UC-001'],
      layoutTree: { type: 'vertical', children: [{ type: 'region', region: 'REGION-001' }] },
      regions: [{ id: 'REGION-001', name: '验证区', purpose: '操作与反馈', content: ['验证结果'], controls: [{ id: 'CONTROL-001', type: 'action', label: '验证', purpose: '提交验证', dataBinding: null, action: 'validate' }] }],
    }],
    interactionStates: [
      { id: 'WF-STATE-001', screen: 'SCREEN-001', type: 'default', condition: '等待验证', stateDelta, terminal: false },
      { id: 'WF-STATE-002', screen: 'SCREEN-001', type: 'success', condition: '验证通过', stateDelta, terminal: true },
      { id: 'WF-STATE-003', screen: 'SCREEN-001', type: 'error', condition: '验证失败', stateDelta, terminal: true },
    ],
    wireflows: [{
      id: 'WF-001', useCase: 'UC-001', name: '验证规格', coveredScenarios: ['main', 'UC-001-EXC-01'],
      entry: { screen: 'SCREEN-001', state: 'WF-STATE-001' }, completionStates: ['WF-STATE-002', 'WF-STATE-003'],
      steps: [
        { id: 'WF-001-STEP-01', scenarioRef: 'main', useCaseStepRefs: ['UC-001-STEP-01'], from: { screen: 'SCREEN-001', state: 'WF-STATE-001' }, trigger: { event: 'validate', control: 'CONTROL-001' }, guard: '有效', branchLabel: '成功', to: { screen: 'SCREEN-001', state: 'WF-STATE-002' } },
        { id: 'WF-001-STEP-02', scenarioRef: 'UC-001-EXC-01', useCaseStepRefs: ['UC-001-EXC-01-STEP-01'], from: { screen: 'SCREEN-001', state: 'WF-STATE-001' }, trigger: { event: 'validate', control: 'CONTROL-001' }, guard: '引用无效', branchLabel: '失败', to: { screen: 'SCREEN-001', state: 'WF-STATE-003' } },
      ],
    }],
    gates: [],
    gaps: [],
  };
  await writeFile(resolve(legacyRoot, 'ACTOR-001', 'wireflow-mid.yaml'), stringifyYaml(legacy));
  const migrated = await migrateLegacyWireflowDirectory(candidate, legacyRoot);
  const schema = JSON.parse(await readFile(resolve(root, '.agents/skills/product-design/capabilities/schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  assert.equal(validate(migrated), true, JSON.stringify(validate.errors));
  assert.equal(migrated.interactionFlows[0].id, 'IF-001');
  assert.equal(migrated.interactionFlows[0].transitions[1].failureResponse.returnToState, 'INT-STATE-001');
  assert.equal(migrated.lowFiUiBlueprints[0].screens[0].id, 'LF-SCREEN-001');
  assert.deepEqual(migrated.lowFiUiBlueprints[0].screens[0].regions[0].controls[0].transitionRefs, ['IF-001-TRANS-01', 'IF-001-TRANS-02']);
  assert.equal('coveredScenarios' in migrated.interactionFlows[0], false);
  assert.equal('userAction' in migrated.interactionFlows[0].transitions[0], false);
  assert.equal('failure' in migrated.interactionFlows[0].transitions[1].failureResponse, false);
  assert.equal('wireflows' in migrated, false);

  legacy.screens[0].regions[0].controls.push({ ...legacy.screens[0].regions[0].controls[0] });
  await writeFile(resolve(legacyRoot, 'ACTOR-001', 'wireflow-mid.yaml'), stringifyYaml(legacy));
  await assert.rejects(
    migrateLegacyWireflowDirectory(candidate, legacyRoot),
    (error) => error.code === 'AIH_REFERENCE_UNRESOLVED' && /Control ID 重复/.test(error.message),
  );
});

test('canonical-ui.ts remains an internal machine index with only a deterministic hidden JSON projection', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts['canonical-ui-prototype'];
  const hidden = await readFile(resolve(root, stage.root, binding.memberProjections[0].root, 'ACTOR-001', binding.memberProjections[0].member), 'utf8');
  assert.equal(binding.memberProjections.length, 1);
  assert.equal(binding.memberProjections[0].role, 'generated-support');
  assert.match(hidden, /"screens":/);
  assert.match(hidden, /"draft":/);
  assert.equal(runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--check', '--json']).exitCode, 0);
});

test('Canonical UI actor directories remain independent packages and build separately', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const appsRoot = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root);
  await cp(resolve(appsRoot, 'ACTOR-001'), resolve(appsRoot, 'ACTOR-002'), { recursive: true });
  const actorTwoSource = resolve(appsRoot, 'ACTOR-002', 'src/spec/canonical-ui.ts');
  await writeFile(actorTwoSource, (await readFile(actorTwoSource, 'utf8')).replace('"actor": "ACTOR-001"', '"actor": "ACTOR-002"'));
  for (const actor of ['ACTOR-001', 'ACTOR-002']) {
    assert.ok((await stat(resolve(appsRoot, actor, 'package.json'))).isFile());
    assert.ok((await stat(resolve(appsRoot, actor, 'index.html'))).isFile());
  }
  const built = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/runtime.mjs', root, ['--capability', 'build']);
  assert.equal(built.exitCode, 0, JSON.stringify(built.output, null, 2));
  assert.match(built.output.stdout, /ACTOR-001 独立应用构建通过/);
  assert.match(built.output.stdout, /ACTOR-002 独立应用构建通过/);
  assert.ok((await stat(resolve(appsRoot, 'ACTOR-001', 'dist', 'index.html'))).isFile());
  assert.ok((await stat(resolve(appsRoot, 'ACTOR-002', 'dist', 'index.html'))).isFile());
});

test('strict validation separates workflow state from component state and checks traceability', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));

  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const source = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root, 'ACTOR-001', 'src/spec/canonical-ui.ts');
  const content = await readFile(source, 'utf8');
  await writeFile(source, content.replace('"scope": "workflow"', '"scope": "component"'));
  const invalid = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(invalid).has('AIH_REFERENCE_UNRESOLVED') || codes(invalid).has('AIH_GENERATED_DRIFT'));
});

test('strict validation accepts only the user-confirmed viewport instead of requiring mobile and desktop', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  const selectedViewportId = 'VIEWPORT-DESKTOP';
  model.viewports = model.viewports.filter((viewport) => viewport.id === selectedViewportId);
  for (const source of model.designSources) {
    for (const coverage of source.coverage) coverage.viewportIds = [selectedViewportId];
  }
  for (const coverage of model.visualPolicy.coverage) coverage.viewportIds = [selectedViewportId];
  for (const scenario of model.scenarios) scenario.viewportIds = [selectedViewportId];
  for (const assertion of model.renderAssertions) assertion.viewportIds = [selectedViewportId];
  model.sourceParityAssertions = model.sourceParityAssertions.filter((assertion) => assertion.viewportId === selectedViewportId);
  await writeCanonical(path, model);
  const rendered = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(rendered.exitCode, 0, JSON.stringify(rendered.output, null, 2));
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
});

test('strict validation requires every scenario event to resolve to exactly one action', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  model.actions = model.actions.filter((action) => action.eventId !== 'EVENT-002');
  await writeCanonical(path, model);
  const invalid = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(invalid).has('AIH_REFERENCE_UNRESOLVED'), JSON.stringify(invalid.output, null, 2));
  assert.ok(invalid.output.blockers.some((item) => item.message.includes('SCENARIO-002 / EVENT-002')));
});

test('Canonical UI input gate requires reproducible design source evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));
  const { areaPath } = await canonicalFixture(root);
  await appendFile(resolve(areaPath, 'design-sources/DESIGN-SOURCE-001/design-context.json'), '\nchanged');
  const invalid = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_SOURCE_INTEGRITY_FAILED'));
});

test('Canonical UI input gate Review evidence binds a real address to the frozen Draft', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const reviewed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/review.mjs', root, ['--json']);
  assert.equal(reviewed.exitCode, 0, JSON.stringify(reviewed.output, null, 2));
  assert.match(reviewed.output.actors[0].reviewAddress, /^http:\/\/127\.0\.0\.1:[0-9]+\/\?review=[a-f0-9]{64}$/);
  const evidence = JSON.parse(await readFile(reviewed.output.reviewEvidence, 'utf8'));
  assert.equal(evidence.status, 'PASS');
  assert.equal(evidence.actors[0].draftVersion, '1.0.0');
  assert.ok(evidence.actors[0].screenshots.length > 0);
});

test('Canonical UI input gate, Publish lock, drift invalidation, and Reopen form one lifecycle', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const packagePath = resolve(root, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  packageJson.scripts['fixture:pass'] = 'node -e "process.exit(0)"';
  await writeFile(packagePath, JSON.stringify(packageJson, null, 2) + '\n');
  const manifestPath = resolve(root, '.psp/harness/harness.manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.commands.push({
    id: 'fixture-pass', npmScript: 'fixture:pass', run: 'npm run fixture:pass', purpose: 'fixture', blocking: true,
    executor: { kind: 'module', path: '.psp/harness/tests/fixtures/command-pass.mjs' },
  });
  manifest.validationProfiles.find((item) => item.id === 'canonical-ui-review-readiness').commands = ['fixture-pass'];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  let project = await fixtureProject(root);
  await writeReviewEvidence(root, await canonicalLocks(root, project));
  const published = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/publication.mjs', root, [
    '--operation', 'publish-product-design', '--json',
  ]);
  assert.equal(published.exitCode, 0, JSON.stringify(published.output, null, 2));
  assert.equal(published.output.downstreamAction, 'NOT_RUN');
  project = await fixtureProject(root);
  assert.equal(project.stages['product-design'].status, 'published');
  assert.equal(project.stages['architecture-design'].status, 'uninitialized');
  const ledger = JSON.parse(await readFile(resolve(root, project.stages['product-design'].publication.receipt), 'utf8'));
  assert.ok(ledger.current.credential.startsWith('sha256:'));
  assert.equal(ledger.current.inputLocks.visualAssets.length, 1);

  const stage = project.stages['product-design'];
  const appPath = resolve(root, stage.root, stage.areas['canonical-ui-prototypes'].root, 'ACTOR-001', 'src/psp-app.ts');
  await appendFile(appPath, '\n// manual published drift\n');
  const stale = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(stale).has('AIH_PUBLISH_CREDENTIAL_STALE'));
  const locked = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact', '--artifact', 'capabilities', '--input', resolve(root, stage.root, stage.artifacts.capabilities.internalModel), '--dry-run', '--json',
  ]);
  assert.ok(codes(locked).has('AIH_STAGE_LOCKED'));

  const reopened = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/publication.mjs', root, [
    '--operation', 'reopen-product-design', '--json',
  ]);
  assert.equal(reopened.exitCode, 0, JSON.stringify(reopened.output, null, 2));
  project = await fixtureProject(root);
  assert.equal(project.stages['product-design'].status, 'active');
  const history = JSON.parse(await readFile(resolve(root, project.stages['product-design'].publication.receipt), 'utf8'));
  assert.equal(history.current, null);
  assert.equal(history.history.length, 1);

  await writeReviewEvidence(root, await canonicalLocks(root, project));
  const sameVersion = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/publication.mjs', root, [
    '--operation', 'publish-product-design', '--json',
  ]);
  assert.ok(codes(sameVersion).has('AIH_PUBLISH_VERSION_NOT_ADVANCED'));
});

test('exact Human Visual Acceptance requires explicit user confirmation and becomes stale after scope drift', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const exact = await prepareExactFixture(root);
  let project = await fixtureProject(root);
  await writeReviewEvidence(root, await canonicalLocks(root, project));

  const implicit = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/visual-acceptance.mjs', root, ['--json']);
  assert.ok(codes(implicit).has('AIH_HUMAN_VISUAL_ACCEPTANCE_REQUIRED'));

  const accepted = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/visual-acceptance.mjs', root, [
    '--accepted-by', 'user:fixture-reviewer', '--confirm', 'HUMAN_VISUAL_ACCEPTED', '--json',
  ]);
  assert.equal(accepted.exitCode, 0, JSON.stringify(accepted.output, null, 2));
  assert.equal(accepted.output.acceptance, 'accepted');

  const manifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  assert.deepEqual(await verifyVisualAcceptance(root, project, manifest), []);

  exact.model.componentContracts[0].properties[0].defaultValue = 'scope-drift';
  await writeCanonical(exact.path, exact.model);
  project = await fixtureProject(root);
  const stale = await verifyVisualAcceptance(root, project, manifest, { markStale: true });
  assert.equal(stale[0].code, 'AIH_HUMAN_VISUAL_ACCEPTANCE_STALE');
  const record = JSON.parse(await readFile(visualAcceptanceRecordPath(root), 'utf8'));
  assert.equal(record.status, 'stale');
});

test('Figma source registration packet validates adapter output without owning Canonical UI identifiers', async () => {
  const root = await temporaryRepository();
  const schema = JSON.parse(await readFile(
    resolve(root, '.agents/skills/capture-figma-design-source/source-registration.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const packet = {
    version: '2.0.0',
    sourceId: 'DESIGN-SOURCE-001',
    sourceVersion: { kind: 'figma-file-version', value: 'fixture-version-20260715' },
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: 'sha256:' + 'a'.repeat(64),
    capturePlan: { path: 'design-sources/DESIGN-SOURCE-001/capture-plan.json', sha256: 'sha256:' + 'b'.repeat(64) },
    ingestReceipt: { path: 'design-sources/DESIGN-SOURCE-001/ingest-receipt.json', sha256: 'sha256:' + 'c'.repeat(64) },
    assets: [{
      path: 'public/assets/DESIGN-SOURCE-001/source.svg',
      sourceNodeId: '1:3',
      assetKind: 'icon',
      strategy: 'asset',
      format: 'svg',
      scale: 1,
      cropBounds: { x: 0, y: 0, width: 40, height: 40 },
      transparentPadding: { top: 0, right: 0, bottom: 0, left: 0 },
      expectedDimensions: { width: 40, height: 40 },
      sha256: 'sha256:' + 'd'.repeat(64),
      downloadOperation: 'figma:export-node',
      consumerTargets: ['COMPONENT-001'],
      status: 'verified',
    }],
    gaps: [],
  };
  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(Object.hasOwn(packet.assets[0], 'id'), false);
  delete packet.assets[0].consumerTargets;
  assert.equal(validate(packet), false);
});

test('controlled Figma Asset Ingest validates temporary acquisition before formal writes', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const session = await mkdtemp(resolve(tmpdir(), 'pre-sdd-ingest-test-'));
  const downloadDirectory = resolve(session, 'downloads');
  await mkdir(downloadDirectory);
  const formalPlanPath = resolve(areaPath, 'design-sources/DESIGN-SOURCE-001/capture-plan.json');
  const formalAssetPath = resolve(areaPath, 'public/assets/DESIGN-SOURCE-001/source.svg');
  const planContent = await readFile(formalPlanPath);
  const plan = JSON.parse(planContent.toString('utf8'));
  const assetContent = await readFile(formalAssetPath);
  const planPath = resolve(session, 'capture-plan.json');
  const downloadPath = resolve(downloadDirectory, 'source.svg');
  await Promise.all([writeFile(planPath, planContent), writeFile(downloadPath, assetContent)]);
  const assetPlan = plan.candidateVisualNodes.find((item) => item.strategy === 'asset');
  const acquisition = {
    version: '1.0.0',
    sourceId: plan.sourceId,
    sourceVersion: plan.sourceVersion,
    capturePlanSha256: sha256(planContent),
    downloadedAt: plan.frozenAt,
    downloadOperation: assetPlan.assetExport.downloadOperation,
    files: [{
      sourceNodeId: assetPlan.nodeId,
      path: 'downloads/source.svg',
      targetPath: assetPlan.assetExport.targetPath,
      format: assetPlan.assetExport.format,
      scale: assetPlan.assetExport.scale,
      cropBounds: assetPlan.assetExport.cropBounds,
      transparentPadding: assetPlan.assetExport.transparentPadding,
      dimensions: assetPlan.assetExport.expectedDimensions,
      sha256: sha256(assetContent),
    }],
  };
  const acquisitionPath = resolve(session, 'acquisition.json');
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');

  const ingested = runScript('.agents/skills/capture-figma-design-source/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.equal(ingested.exitCode, 0, JSON.stringify(ingested.output, null, 2));
  assert.equal(ingested.output.assets[0].status, 'verified');

  acquisition.files[0].sha256 = 'sha256:' + 'f'.repeat(64);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const mismatched = runScript('.agents/skills/capture-figma-design-source/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(mismatched).has('AIH_ASSET_HASH_MISMATCH'), JSON.stringify(mismatched.output, null, 2));

  const ambiguousPlan = structuredClone(plan);
  ambiguousPlan.candidateVisualNodes.push({
    nodeId: assetPlan.nodeId,
    name: 'Conflicting classification',
    strategy: 'ignored',
    reason: 'fixture conflict',
  });
  const ambiguousPlanContent = Buffer.from(JSON.stringify(ambiguousPlan, null, 2) + '\n');
  await writeFile(planPath, ambiguousPlanContent);
  acquisition.capturePlanSha256 = sha256(ambiguousPlanContent);
  acquisition.files[0].sha256 = sha256(assetContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const ambiguous = runScript('.agents/skills/capture-figma-design-source/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(ambiguous).has('AIH_ASSET_CLASSIFICATION_INCOMPLETE'), JSON.stringify(ambiguous.output, null, 2));

  const expandedPlan = structuredClone(plan);
  expandedPlan.candidateVisualNodes.push({
    nodeId: '1:99',
    name: 'Agent-expanded visual node',
    strategy: 'dom-css',
  });
  const expandedPlanContent = Buffer.from(JSON.stringify(expandedPlan, null, 2) + '\n');
  await writeFile(planPath, expandedPlanContent);
  acquisition.capturePlanSha256 = sha256(expandedPlanContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const expanded = runScript('.agents/skills/capture-figma-design-source/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(expanded).has('AIH_SOURCE_CAPTURE_BLOCKED'), JSON.stringify(expanded.output, null, 2));

  const unapprovedDetachPlan = structuredClone(plan);
  unapprovedDetachPlan.highImpactConfirmation.writebackOperations = [{
    id: 'WRITEBACK-001',
    kind: 'detach-instance',
    targetNodeIds: ['1:2'],
    reason: 'Fixture detach request.',
  }];
  unapprovedDetachPlan.writebackBoundary.operationIds = ['WRITEBACK-001'];
  const unapprovedDetachContent = Buffer.from(JSON.stringify(unapprovedDetachPlan, null, 2) + '\n');
  await writeFile(planPath, unapprovedDetachContent);
  acquisition.capturePlanSha256 = sha256(unapprovedDetachContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const unapprovedDetach = runScript('.agents/skills/capture-figma-design-source/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(unapprovedDetach).has('AIH_SOURCE_CAPTURE_BLOCKED'), JSON.stringify(unapprovedDetach.output, null, 2));

  const missingSecondConfirmation = structuredClone(plan);
  delete missingSecondConfirmation.highImpactConfirmation;
  const missingSecondConfirmationContent = Buffer.from(JSON.stringify(missingSecondConfirmation, null, 2) + '\n');
  await writeFile(planPath, missingSecondConfirmationContent);
  acquisition.capturePlanSha256 = sha256(missingSecondConfirmationContent);
  await writeFile(acquisitionPath, JSON.stringify(acquisition, null, 2) + '\n');
  const missingConfirmation = runScript('.agents/skills/capture-figma-design-source/scripts/ingest-assets.mjs', root, [
    '--actor', 'ACTOR-001', '--capture-plan', planPath, '--acquisition', acquisitionPath, '--json',
  ]);
  assert.ok(codes(missingConfirmation).has('AIH_ASSET_CLASSIFICATION_INCOMPLETE'), JSON.stringify(missingConfirmation.output, null, 2));
});

test('Canonical UI 9.0 rejects every removed legacy structure', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const legacyEvidence = structuredClone(model);
  legacyEvidence.designSources[0].evidence = 'public/source.svg';
  await writeCanonical(path, legacyEvidence);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const freeTextAssertion = structuredClone(model);
  freeTextAssertion.renderAssertions[0].description = '旧自由文本视觉说明';
  await writeCanonical(path, freeTextAssertion);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const missingViewport = structuredClone(model);
  delete missingViewport.scenarios[0].viewportIds;
  await writeCanonical(path, missingViewport);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));

  const pageLevelFigmaLink = structuredClone(model);
  pageLevelFigmaLink.designSources[0].location = 'https://www.figma.com/design/example/psp-harness';
  await writeCanonical(path, pageLevelFigmaLink);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_SCHEMA_FAILED'));
});

test('component abstraction gates require unique inventory, resolvable mappings, and complete Variant coverage', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const missingInventory = structuredClone(model);
  missingInventory.componentInventory = [];
  await writeCanonical(path, missingInventory);
  const unresolved = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(unresolved).has('AIH_COMPONENT_ABSTRACTION_UNRESOLVED'), JSON.stringify(unresolved.output, null, 2));

  const invalidMapping = structuredClone(model);
  invalidMapping.componentMappings[0].figmaComponentNodeId = '1:2';
  await writeCanonical(path, invalidMapping);
  const invalid = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_COMPONENT_MAPPING_INVALID'), JSON.stringify(invalid.output, null, 2));

  const unsupportedStructure = structuredClone(model);
  unsupportedStructure.componentInventory[0].structureSignatures = ['sha256:' + '3'.repeat(64)];
  await writeCanonical(path, unsupportedStructure);
  const unsupported = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(unsupported).has('AIH_COMPONENT_ABSTRACTION_UNRESOLVED'), JSON.stringify(unsupported.output, null, 2));

  const missingVariant = structuredClone(model);
  missingVariant.componentVariantCoverage[0].figmaVariantProperties.Mode = 'Busy';
  missingVariant.componentVariantCoverage[0].litVariantAttributes.mode = 'busy';
  await writeCanonical(path, missingVariant);
  const incomplete = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(incomplete).has('AIH_COMPONENT_VARIANT_COVERAGE_FAILED'), JSON.stringify(incomplete.output, null, 2));
});

test('Component Contract and State Matrix classify every finite combination exactly once', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const missingContract = structuredClone(model);
  missingContract.componentContracts = [];
  await writeCanonical(path, missingContract);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_COMPONENT_CONTRACT_INVALID'));

  const bypassedInterface = structuredClone(model);
  bypassedInterface.componentContracts[0].litTagName = 'copied-state-card';
  await writeCanonical(path, bypassedInterface);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_COMPONENT_CONTRACT_INVALID'));

  const missingCombination = structuredClone(model);
  missingCombination.stateMatrix.pop();
  await writeCanonical(path, missingCombination);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_STATE_MATRIX_INVALID'));

  const duplicateCombination = structuredClone(model);
  duplicateCombination.stateMatrix.push({ ...duplicateCombination.stateMatrix[0], id: 'STATE-MATRIX-DUPLICATE' });
  await writeCanonical(path, duplicateCombination);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_STATE_MATRIX_INVALID'));

  const confusedKinds = structuredClone(model);
  confusedKinds.stateAxes.find((axis) => axis.kind === 'content-override').values[0].stateId = 'COMPONENT-STATE-DEFAULT';
  await writeCanonical(path, confusedKinds);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_STATE_MATRIX_INVALID'));
});

test('Mock Case Effect contract binds business scenarios, component instances, activation, behaviors and matrix entries', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const noDefault = structuredClone(model);
  noDefault.mockCases[0].isDefault = false;
  await writeCanonical(path, noDefault);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_MOCKCASE_COVERAGE_FAILED'));

  const missingReset = structuredClone(model);
  const missingResetTargetId = missingReset.mockCases.find((item) => item.id === 'MOCK-CASE-SUCCESS-DETAIL').effects[0].targetInstanceId;
  missingReset.mockCases.find((item) => item.isDefault).effects = missingReset.mockCases.find((item) => item.isDefault).effects.filter((effect) => effect.targetInstanceId !== missingResetTargetId);
  await writeCanonical(path, missingReset);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_MOCKCASE_COVERAGE_FAILED'));

  const mismatchedState = structuredClone(model);
  mismatchedState.mockCases.find((item) => item.id === 'MOCK-CASE-SUCCESS').effects[0].expectedStateMatrixEntryId = 'STATE-MATRIX-ERROR';
  await writeCanonical(path, mismatchedState);
  const mismatchCodes = codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']));
  assert.ok(mismatchCodes.has('AIH_MOCKCASE_STATE_MISMATCH') || mismatchCodes.has('AIH_MOCKCASE_CONTRACT_INVALID'));

  const missingInstance = structuredClone(model);
  missingInstance.mockCases.find((item) => item.id === 'MOCK-CASE-SUCCESS').effects[0].targetInstanceId = 'COMPONENT-INSTANCE-UNKNOWN';
  await writeCanonical(path, missingInstance);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_MOCKCASE_CONTRACT_INVALID'));

  const missingScenario = structuredClone(model);
  delete missingScenario.mockCases.find((item) => item.id === 'MOCK-CASE-SUCCESS').scenarioId;
  await writeCanonical(path, missingScenario);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_MOCKCASE_CONTRACT_INVALID'));
});

test('guided partial sources are valid while blocked and incomplete exact sources stay blocked', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);

  const partial = structuredClone(model);
  partial.designSources[0].status = 'partial';
  await writeCanonical(path, partial);
  const partialRendered = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(partialRendered.exitCode, 0, JSON.stringify(partialRendered.output, null, 2));
  const partialResult = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(partialResult.exitCode, 0, JSON.stringify(partialResult.output, null, 2));

  const blocked = structuredClone(model);
  Object.assign(blocked.designSources[0], { status: 'blocked', capturedAt: null, evidence: null, coverage: [] });
  blocked.gaps = [{ id: 'GAP-SOURCE-001', description: 'Figma 节点无访问权限', owner: 'product-design', sourceIds: ['DESIGN-SOURCE-001'] }];
  await writeCanonical(path, blocked);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_SOURCE_CAPTURE_BLOCKED'));

  const missingCoverage = structuredClone(model);
  missingCoverage.visualPolicy.mode = 'exact';
  missingCoverage.visualPolicy.aspects = ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'];
  missingCoverage.designSources[0].coverage[0].stateIds = ['INT-STATE-001'];
  await writeCanonical(path, missingCoverage);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_SOURCE_COVERAGE_FAILED'));

  const unknownCoverage = structuredClone(model);
  unknownCoverage.designSources[0].coverage[0].viewportIds.push('VIEWPORT-UNKNOWN');
  await writeCanonical(path, unknownCoverage);
  assert.ok(codes(runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--strict', '--json'])).has('AIH_REFERENCE_UNRESOLVED'));
});

test('evidence manifest rejects traversal and source identity mismatch', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  const manifestPath = resolve(areaPath, model.designSources[0].evidence.path);
  const originalManifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  const traversal = structuredClone(originalManifest);
  traversal.items[0].path = '../outside.json';
  const traversalText = JSON.stringify(traversal, null, 2) + '\n';
  await writeFile(manifestPath, traversalText);
  const traversalModel = structuredClone(model);
  traversalModel.designSources[0].evidence.sha256 = sha256(traversalText);
  await writeCanonical(path, traversalModel);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));

  const mismatched = structuredClone(originalManifest);
  mismatched.sourceId = 'DESIGN-SOURCE-999';
  const mismatchedText = JSON.stringify(mismatched, null, 2) + '\n';
  await writeFile(manifestPath, mismatchedText);
  const mismatchedModel = structuredClone(model);
  mismatchedModel.designSources[0].evidence.sha256 = sha256(mismatchedText);
  await writeCanonical(path, mismatchedModel);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));

  const wrongNode = structuredClone(originalManifest);
  wrongNode.nodeId = '9:9';
  const wrongNodeText = JSON.stringify(wrongNode, null, 2) + '\n';
  await writeFile(manifestPath, wrongNodeText);
  const wrongNodeModel = structuredClone(model);
  wrongNodeModel.designSources[0].evidence.sha256 = sha256(wrongNodeText);
  await writeCanonical(path, wrongNodeModel);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));

  const restoredText = JSON.stringify(originalManifest, null, 2) + '\n';
  await writeFile(manifestPath, restoredText);
  const screenshotAsAsset = structuredClone(model);
  screenshotAsAsset.designSources[0].evidence.sha256 = sha256(restoredText);
  screenshotAsAsset.assets[0].path = originalManifest.items.find((item) => item.role === 'screenshot').path;
  await writeCanonical(path, screenshotAsAsset);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_ASSET_MISSING'));
});

test('Figma evidence requires normalized parameters and layer-scoped static assets', async () => {
  const versionRoot = await temporaryRepository();
  await completeProductFixture(versionRoot);
  const versionFixture = await canonicalFixture(versionRoot);
  const versionEvidencePath = resolve(versionFixture.areaPath, versionFixture.model.designSources[0].evidence.path);
  const versionEvidence = JSON.parse(await readFile(versionEvidencePath, 'utf8'));
  const versionContextItem = versionEvidence.items.find((item) => item.role === 'design-context');
  const versionContextPath = resolve(versionFixture.areaPath, versionContextItem.path);
  const versionContext = JSON.parse(await readFile(versionContextPath, 'utf8'));
  versionContext.sourceVersion = { kind: 'figma-file-version', value: 'different-remote-version' };
  const versionContextText = JSON.stringify(versionContext, null, 2) + '\n';
  await writeFile(versionContextPath, versionContextText);
  versionContextItem.sha256 = sha256(versionContextText);
  const versionEvidenceText = JSON.stringify(versionEvidence, null, 2) + '\n';
  await writeFile(versionEvidencePath, versionEvidenceText);
  const versionModel = structuredClone(versionFixture.model);
  versionModel.designSources[0].evidence.sha256 = sha256(versionEvidenceText);
  await writeCanonical(versionFixture.path, versionModel);
  const mismatchedVersion = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', versionRoot, ['--json']);
  assert.ok(codes(mismatchedVersion).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(mismatchedVersion.output, null, 2));

  const contextRoot = await temporaryRepository();
  await completeProductFixture(contextRoot);
  const contextFixture = await canonicalFixture(contextRoot);
  const contextEvidencePath = resolve(contextFixture.areaPath, contextFixture.model.designSources[0].evidence.path);
  const contextEvidence = JSON.parse(await readFile(contextEvidencePath, 'utf8'));
  const contextItem = contextEvidence.items.find((item) => item.role === 'design-context');
  const contextPath = resolve(contextFixture.areaPath, contextItem.path);
  const incompleteContext = '{}\n';
  await writeFile(contextPath, incompleteContext);
  contextItem.sha256 = sha256(incompleteContext);
  const contextEvidenceText = JSON.stringify(contextEvidence, null, 2) + '\n';
  await writeFile(contextEvidencePath, contextEvidenceText);
  const contextModel = structuredClone(contextFixture.model);
  contextModel.designSources[0].evidence.sha256 = sha256(contextEvidenceText);
  await writeCanonical(contextFixture.path, contextModel);
  const incomplete = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', contextRoot, ['--json']);
  assert.ok(codes(incomplete).has('AIH_VISUAL_SOURCE_INCOMPLETE'), JSON.stringify(incomplete.output, null, 2));

  const assetRoot = await temporaryRepository();
  await completeProductFixture(assetRoot);
  const assetFixture = await canonicalFixture(assetRoot);
  const assetEvidencePath = resolve(assetFixture.areaPath, assetFixture.model.designSources[0].evidence.path);
  const assetEvidence = JSON.parse(await readFile(assetEvidencePath, 'utf8'));
  assetEvidence.items.find((item) => item.role === 'asset').captureScope = 'artwork-subtree';
  const assetEvidenceText = JSON.stringify(assetEvidence, null, 2) + '\n';
  await writeFile(assetEvidencePath, assetEvidenceText);
  const assetModel = structuredClone(assetFixture.model);
  assetModel.designSources[0].evidence.sha256 = sha256(assetEvidenceText);
  await writeCanonical(assetFixture.path, assetModel);
  const invalidAsset = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', assetRoot, ['--json']);
  assert.ok(codes(invalidAsset).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(invalidAsset.output, null, 2));
});

test('Figma asset closure blocks missing files, hash drift, and manifest drift', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  const assetRelativePath = model.assets[0].path;
  const assetPath = resolve(areaPath, assetRelativePath);
  const original = await readFile(assetPath);

  await rm(assetPath);
  const missing = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(missing).has('AIH_ASSET_MISSING'), JSON.stringify(missing.output, null, 2));

  await writeFile(assetPath, Buffer.concat([original, Buffer.from('<!-- drift -->\n')]));
  const hashDrift = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(hashDrift).has('AIH_ASSET_HASH_MISMATCH'), JSON.stringify(hashDrift.output, null, 2));

  await writeFile(assetPath, original);
  const manifestDrift = structuredClone(model);
  manifestDrift.assets[0].sha256 = 'sha256:' + 'f'.repeat(64);
  await writeCanonical(path, manifestDrift);
  const closure = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(closure).has('AIH_ASSET_CLOSURE_FAILED'), JSON.stringify(closure.output, null, 2));

  await writeCanonical(path, model);
  const closed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(closed.exitCode, 0, JSON.stringify(closed.output, null, 2));
});

test('browser validator executes declared routes, interactions and viewports with temporary evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  assert.equal(result.output.evidence.length, 8);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'route').length, 2);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'scenario').length, 6);
  assert.deepEqual(new Set(result.output.evidence.filter((item) => item.kind === 'scenario').map((item) => item.viewportId)), new Set(['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP']));
  for (const item of result.output.evidence.filter((entry) => entry.kind === 'scenario')) {
    const expected = item.scenarioId === 'SCENARIO-001'
      ? [['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS']]
      : item.scenarioId === 'SCENARIO-002'
        ? [['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR']]
        : [['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'], ['COMPONENT-STATE-DEFAULT']];
    assert.deepEqual(item.actionStateTraces.map((trace) => trace.stateIds), expected);
  }
  assert.ok(result.output.evidence.every((item) => !item.screenshot.startsWith(root)));

  const indexPath = resolve(areaPath, 'index.html');
  const index = await readFile(indexPath, 'utf8');
  await writeFile(indexPath, index.replace('mode="default"', 'mode="special"'));
  const mismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(mismatch).has('AIH_COMPONENT_IMPLEMENTATION_MISMATCH'), JSON.stringify(mismatch.output, null, 2));
});

test('visual policy supports autonomous, guided and exact enforcement without a change-profile bypass', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);

  const unresolved = structuredClone(model);
  unresolved.visualPolicy = { mode: 'unresolved', selectedBy: 'default-policy', aspects: [], coverage: [] };
  unresolved.sourceParityAssertions = [];
  await writeCanonical(path, unresolved);
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_VISUAL_POLICY_UNRESOLVED'));

  const autonomous = structuredClone(model);
  autonomous.visualPolicy = { mode: 'autonomous', selectedBy: 'default-policy', aspects: [], coverage: [] };
  autonomous.designSources = [];
  autonomous.assets = [];
  autonomous.tokens = [];
  autonomous.componentInventory = [];
  autonomous.componentMappings = [];
  autonomous.componentVariantCoverage = [];
  for (const contract of autonomous.componentContracts) {
    delete contract.mappingId;
    contract.figmaInstanceNodeIds = [];
    for (const instance of contract.pageInstances) delete instance.figmaInstanceNodeId;
  }
  autonomous.sourceParityAssertions = [];
  await writeCanonical(path, autonomous);
  const autonomousResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(autonomousResult.exitCode, 0, JSON.stringify(autonomousResult.output, null, 2));

  await writeCanonical(path, model);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const guidedMismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(guidedMismatch).has('AIH_VISUAL_STYLE_BINDING_FAILED'), JSON.stringify(guidedMismatch.output, null, 2));
  const guidedRepair = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(guidedRepair.output.status, 'BLOCKED');
  assert.equal(guidedRepair.output.repairPacket, undefined);
  assert.ok(codes(guidedRepair).has('AIH_VISUAL_STYLE_BINDING_FAILED'));
  await writeFile(appPath, app);

  const guidedRuntime = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(guidedRuntime.exitCode, 0, JSON.stringify(guidedRuntime.output, null, 2));
  const routeBaseline = guidedRuntime.output.evidence.find((item) => item.kind === 'route' && item.viewportId === 'VIEWPORT-DESKTOP').screenshot;
  const baselineContent = await readFile(routeBaseline);
  const baselineRelativePath = 'design-sources/DESIGN-SOURCE-001/exact-desktop.png';
  await writeFile(resolve(areaPath, baselineRelativePath), baselineContent);
  const evidencePath = resolve(areaPath, model.designSources[0].evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.items.push({ id: 'EVIDENCE-EXACT-DESKTOP', role: 'screenshot', path: baselineRelativePath, sha256: sha256(baselineContent) });
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);

  const exact = structuredClone(model);
  exact.visualPolicy = {
    mode: 'exact',
    selectedBy: 'user-explicit',
    aspects: ['layout', 'dimensions', 'typography', 'color', 'spacing', 'shape', 'shadow', 'assets', 'visual-hierarchy'],
    coverage: [{ sourceId: 'DESIGN-SOURCE-001', screenId: 'SCREEN-001', stateIds: exact.states.map((item) => item.id), viewportIds: ['VIEWPORT-DESKTOP'], evidenceItemIds: ['EVIDENCE-EXACT-DESKTOP'] }],
  };
  exact.repairPolicy.enabled = true;
  exact.designSources[0].evidence.sha256 = sha256(evidenceText);
  exact.designSources[0].coverage[0].viewportIds = ['VIEWPORT-DESKTOP'];
  exact.designSources[0].coverage[0].evidenceItemIds.push('EVIDENCE-EXACT-DESKTOP');
  exact.viewports = exact.viewports.filter((item) => item.id === 'VIEWPORT-DESKTOP');
  exact.scenarios = [];
  for (const mockCase of exact.mockCases) { mockCase.kind = 'technical'; delete mockCase.scenarioId; }
  exact.renderAssertions = exact.renderAssertions.filter((item) => !item.scenarioId).map((item) => ({ ...item, viewportIds: ['VIEWPORT-DESKTOP'] }));
  exact.sourceParityAssertions = [{
    id: 'PARITY-EXACT-DESKTOP',
    sourceId: 'DESIGN-SOURCE-001',
    routeId: 'ROUTE-001',
    viewportId: 'VIEWPORT-DESKTOP',
    baselineEvidenceItemId: 'EVIDENCE-EXACT-DESKTOP',
    aspects: exact.visualPolicy.aspects,
    checks: [{ kind: 'screenshot-match' }],
  }];
  await writeCanonical(path, exact);
  const exactInput = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(exactInput.exitCode, 0, JSON.stringify(exactInput.output, null, 2));
  const exactMatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(exactMatch.exitCode, 0, JSON.stringify(exactMatch.output, null, 2));

  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const exactMismatch = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(exactMismatch.exitCode, 0, JSON.stringify(exactMismatch.output, null, 2));
  assert.ok(exactMismatch.output.evidence.some((item) => item.kind === 'source-parity-diagnostic' && item.diagnosticCode === 'AIH_VISUAL_PIXEL_DIAGNOSTIC'));

  const localManifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  const defaultProfile = localManifest.validationProfiles.find((item) => item.id === 'canonical-ui-prototype');
  assert.ok(defaultProfile.commands.includes('product-strict'));
});

test('exact visual repair emits a complete packet and passes after an allowed implementation fix', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { appPath, app } = await prepareExactFixture(root);
  await writeFile(appPath, app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));

  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));
  assert.equal(requested.output.attempt, 1);
  const packet = JSON.parse(await readFile(requested.output.repairPacket, 'utf8'));
  assert.equal(packet.version, '4.0.0');
  assert.equal(packet.status, 'REPAIR_REQUIRED');
  assert.equal(packet.maxAttempts, 1);
  assert.deepEqual(packet.implementationPolicy, {
    evidenceBeforeEdit: true,
    requireSourceResolution: true,
    preserveInteractiveDom: true,
    preferSourceAssets: true,
    allowSubjectiveApproximation: false,
    minimalImplementationScope: true,
    stableComparisonEnvironment: true,
    fixOrder: ['source-resolution', 'structure', 'geometry', 'typography', 'paint', 'effects', 'assets'],
  });
  const styleFailure = packet.failures.find((failure) => failure.checkKind === 'computed-style');
  assert.equal(styleFailure.targetId, 'CONTROL-001');
  assert.equal(styleFailure.styleProperty, 'background-color');
  assert.equal(styleFailure.expectedStyle, 'rgb(200, 243, 106)');

  await writeFile(appPath, app);
  const repaired = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', root, ['--json']);
  assert.equal(repaired.exitCode, 0, JSON.stringify(repaired.output, null, 2));
  assert.equal(repaired.output.status, 'PASS');
  assert.equal(repaired.output.attempts, 1);
  assert.equal(repaired.output.attemptHistory[0].attempt, 1);
  assert.ok(repaired.output.attemptHistory[0].failures.length > 0);
  const actionReport = JSON.parse(await readFile(repaired.output.repairActionReport, 'utf8'));
  assert.equal(actionReport.status, 'PASS');
  assert.equal(actionReport.actor, 'ACTOR-001');
  assert.equal(actionReport.attempts, 1);
});

test('exact visual repair keeps external evidence hashes but does not hash-gate code edits', async () => {
  const changedRoot = await temporaryRepository();
  await completeProductFixture(changedRoot);
  const changed = await prepareExactFixture(changedRoot);
  await writeFile(changed.appPath, changed.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const requested = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', changedRoot, ['--json']);
  assert.equal(requested.output.status, 'REPAIR_REQUIRED', JSON.stringify(requested.output, null, 2));
  await appendFile(changed.baselinePath, 'baseline-mutated');
  const changedEvidence = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', changedRoot, ['--json']);
  assert.ok(codes(changedEvidence).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(changedEvidence.output, null, 2));

  const missingRoot = await temporaryRepository();
  await completeProductFixture(missingRoot);
  const missing = await prepareExactFixture(missingRoot);
  await rm(missing.baselinePath);
  const missingSource = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', missingRoot, ['--json']);
  assert.equal(missingSource.output.status, 'BLOCKED');
  assert.equal(missingSource.output.repairPacket, undefined);
  assert.ok(codes(missingSource).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(missingSource.output, null, 2));
});

test('exact visual repair blocks non-visual failures and permits only one manual implementation attempt', async () => {
  const nonVisualRoot = await temporaryRepository();
  await completeProductFixture(nonVisualRoot);
  const nonVisual = await prepareExactFixture(nonVisualRoot);
  await writeFile(
    nonVisual.appPath,
    nonVisual.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;') + "\nconsole.error('repair-nonvisual');\n",
  );
  const nonVisualResult = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', nonVisualRoot, ['--json']);
  assert.equal(nonVisualResult.output.status, 'BLOCKED');
  assert.equal(nonVisualResult.output.repairPacket, undefined);
  assert.ok(codes(nonVisualResult).has('AIH_CANONICAL_UI_CONSOLE_FAILED'), JSON.stringify(nonVisualResult.output, null, 2));

  const exhaustedRoot = await temporaryRepository();
  await completeProductFixture(exhaustedRoot);
  const exhausted = await prepareExactFixture(exhaustedRoot);
  await writeFile(exhausted.appPath, exhausted.app.replace('--accent: #c8f36a;', '--accent: #ff00ff;'));
  const first = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--json']);
  assert.equal(first.output.attempt, 1, JSON.stringify(first.output, null, 2));
  await appendFile(exhausted.appPath, '\n// single manual repair attempt\n');
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--json']);
  assert.equal(result.output.status, 'BLOCKED', JSON.stringify(result.output, null, 2));
  assert.match(result.stderr, /AIH_VISUAL_REPAIR_EXHAUSTED/);
  assert.equal(result.output.attempts.length, 1);
  assert.ok(result.output.attempts[0].failures.some((failure) => failure.checkKind === 'computed-style'));
});

test('browser validator uses the browser accessible-name algorithm for aria-labelledby', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app
    .replace('<div class="actions">', '<span id="fixture-success-label">模拟成功</span>\n            <div class="actions">')
    .replace('                class="primary"\n                data-control-id="CONTROL-001"', '                class="primary"\n                aria-labelledby="fixture-success-label"\n                data-control-id="CONTROL-001"')
    .replace('              >\n                模拟成功\n              </button>', '              >\n              </button>'));
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
});

test('Component Contract runner generates isolated Playwright checks from the shared State Matrix', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const ready = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.equal(ready.exitCode, 0, JSON.stringify(ready.output, null, 2));

  const { path, model } = await canonicalFixture(root);
  model.componentContracts[0].properties[0].defaultValue = 'unexpected';
  await writeCanonical(path, model);
  const failed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', root, ['--json']);
  assert.ok(codes(failed).has('AIH_COMPONENT_CONTRACT_TEST_FAILED'), JSON.stringify(failed.output, null, 2));
});

test('incremental validation selects impacted component routes and viewports, then reuses OS-temporary cache', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const args = ['--actor', 'ACTOR-001', '--changed-path', 'src/psp-app.ts', '--json'];
  const first = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-incremental.mjs', root, args);
  assert.equal(first.exitCode, 0, JSON.stringify(first.output, null, 2));
  assert.equal(first.output.formalReadiness, 'NOT_RUN');
  assert.deepEqual(first.output.impact.components, ['COMPONENT-001']);
  assert.deepEqual(first.output.impact.routes, ['ROUTE-001']);
  assert.deepEqual(first.output.impact.viewports.sort(), ['VIEWPORT-DESKTOP', 'VIEWPORT-MOBILE']);
  assert.ok(first.output.layers.every((item) => ['PASS', 'NOT_RUN'].includes(item.status)));
  assert.equal(first.output.performance.before.browserRuntimeMs.p50Ms, 49102);

  const second = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-incremental.mjs', root, args);
  assert.equal(second.exitCode, 0, JSON.stringify(second.output, null, 2));
  assert.equal(second.output.cache.hits, 4);
  assert.equal(second.output.cache.misses, 0);
  assert.ok(second.output.layers.every((item) => item.cacheHit));
  assert.ok(second.output.performance.after.machineGatesMs.p50Ms !== null);
});

test('browser validator skips accessibility checks when the user did not select them', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  delete model.accessibility;
  await writeCanonical(path, model);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app.replace(/              >\r?\n                模拟错误\r?\n              <\/button>/, '              >\n              </button>'));
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED'), false, JSON.stringify(result.output, null, 2));
});

test('browser validator requires a font asset to be used by the declared target computed style', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { path, model } = await canonicalFixture(root);
  Object.assign(model.assets[0], { kind: 'font', fontFamily: 'FixtureUnusedFont' });
  await writeCanonical(path, model);
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.ok(codes(result).has('AIH_ASSET_CSS_BYPASS'), JSON.stringify(result.output, null, 2));
  assert.ok(result.output.blockers.some((item) => item.message.includes('未在声明目标中实际使用')));
  assert.equal(result.output.blockers.some((item) => item.message.includes('资源未成功加载')), false);
});

test('browser validator separates console, network, visual, accessibility and asset blockers', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app
    .replace("this.feedback = '选择一种 Mock 行为，验证 Loading、Success 与 Error 状态。';", "this.feedback = '选择一种 Mock 行为，验证 Loading、Success 与 Error 状态。';\n    console.error('fixture console failure');\n    setTimeout(() => { throw new Error('fixture page failure'); }, 0);\n    void fetch('https://example.com/blocked').catch(() => undefined);")
    .replace(/            <img src="\/assets\/DESIGN-SOURCE-001\/source\.svg" alt="Fixture source" width="40" height="40" \/>\r?\n/, '')
    .replace(/                data-control-id="CONTROL-001"\r?\n/, '                data-control-id="CONTROL-001"\n                tabindex="-1"\n')
    .replace('                data-action-id="ACTION-001"', '                data-action-id="ACTION-UNKNOWN"')
    .replace(/              >\r?\n                模拟错误\r?\n              <\/button>/, '              >\n              </button>')
    .replace(/    button \{\r?\n      min-height: 44px;/, '    button {\n      box-sizing: border-box;\n      width: 30px;\n      overflow: hidden;\n      min-height: 10px;')
    .replace('button.primary { background: var(--accent); }', 'button.primary { background: var(--accent); }\n    button + button { margin-left: -10px; }')
    .replace('button:focus-visible { outline: 3px solid #678e25; outline-offset: 3px; }', 'button:focus-visible { outline: none; box-shadow: none; }'));

  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  const actual = codes(result);
  for (const expected of [
    'AIH_CANONICAL_UI_CONSOLE_FAILED',
    'AIH_CANONICAL_UI_NETWORK_FAILED',
    'AIH_CANONICAL_UI_VISUAL_FAILED',
    'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED',
    'AIH_ASSET_CSS_BYPASS',
  ]) assert.ok(actual.has(expected), JSON.stringify(result.output, null, 2));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_CONSOLE_FAILED' && item.message.includes('页面异常')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_RUNTIME_FAILED' && item.message.includes('事件控件未绑定声明动作')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('键盘 Tab 到达')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('缺少可访问名称')));
  assert.equal(result.output.evidence.length, 8);
});
