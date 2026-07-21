import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { stringify as stringifyYaml } from 'yaml';
import { cleanupTemporaryRepositories, codes, runScript, temporaryRepository } from './helpers/fixture.mjs';
import { completeProductFixture, fixtureProject, readArtifact, writeArtifact } from './helpers/product-fixture.mjs';

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

test('generic initialization creates one atomic UC model without an independent Wireflow collection', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  assert.equal(stage.status, 'active');
  assert.deepEqual(Object.keys(stage.artifacts), ['capabilities', 'canonical-ui-prototype']);
  assert.equal(stage.areas['canonical-ui-prototypes'].root, 'Canonical-UI-Prototypes');
  assert.equal(stage.artifacts['html-mock'], undefined);
  const initialUseCases = await readFile(resolve(root, stage.root, stage.artifacts.capabilities.outputs[0].path), 'utf8');
  assert.match(initialUseCases, /Product Behavior/);
  assert.match(initialUseCases, /Interaction Flow/);
  assert.match(initialUseCases, /Low-Fi UI Blueprint/);
  assert.equal(await stat(resolve(root, stage.root, stage.artifacts.capabilities.internalModel)).then(() => true), true);
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
  assert.equal(manifest.validationProfiles.some((item) => item.id === 'canonical-ui-review-readiness'), false);
  const skill = await readFile(resolve(root, '.agents/skills/product-design/SKILL.md'), 'utf8');
  assert.match(skill, /AIH_CANONICAL_UI_SERVER_FAILED/);
  assert.match(skill, /不得根据默认端口猜测或伪造地址/);
  assert.ok((await stat(resolve(templateRoot, 'public/vendor/html2canvas-1.4.1.min.js'))).isFile());
});

test.skip('legacy streamlined Use Cases projection is replaced by the atomic UC projection', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts.capabilities;
  assert.deepEqual(binding.outputs.map((output) => output.path), ['UC.md']);
  const artifact = await readArtifact(root, stage, binding);
  const ucPath = resolve(root, stage.root, binding.outputs[0].path);
  const initialMarkdown = await readFile(ucPath, 'utf8');
  assert.match(initialMarkdown, /尚未形成可供 Wireflow 消费的稳定 Use Case 行为目录/);
  assert.doesNotMatch(initialMarkdown, /GAP-001|useCases/);

  artifact.data.metadata.status = 'ready';
  artifact.data.metadata.version = '1.0.0';
  artifact.data.intent = {
    productName: '轻量用例产品',
    productConcept: '稳定产品行为目录',
    problem: '下游缺少可追溯的行为输入',
    businessGoal: '让页面流程稳定消费产品行为',
    successSignal: '用例通过严格校验',
  };
  artifact.data.actors = [{ id: 'ACTOR-001', name: '产品负责人', goal: '确认稳定产品行为' }];
  artifact.data.productScope = { included: ['维护稳定用例'], excluded: ['定义详细功能验收'] };
  artifact.data.businessRules = [{ id: 'BR-001', statement: '每个用例必须归属已知参与者', appliesTo: ['UC-001'] }];
  artifact.data.useCases = [{
    id: 'UC-001',
    name: '确认产品行为',
    actor: 'ACTOR-001',
    goal: '确认下游可消费的稳定行为',
    value: '减少行为理解偏差',
    trigger: '产品负责人提交行为目录',
    preconditions: ['产品目标已经明确'],
    successOutcome: '稳定行为目录可供页面流程消费',
    minimumGuarantee: '原始行为目录保持不变并给出问题原因',
    mainScenario: [{
      id: 'UC-001-STEP-01',
      initiator: 'actor',
      action: '提交行为目录',
      outcome: '系统检查行为和引用',
    }],
    alternateScenarios: [{
      id: 'UC-001-EXC-01',
      type: 'exception',
      name: '参与者引用无效',
      startsAt: 'UC-001-STEP-01',
      condition: '用例引用未知参与者',
      steps: [{
        id: 'UC-001-EXC-01-STEP-01',
        initiator: 'system',
        action: '停止接受行为目录',
        outcome: '展示可理解的问题原因',
      }],
      outcome: '行为目录等待修正',
    }],
    businessRules: ['BR-001'],
    relationships: [],
  }];
  artifact.data.gaps = [];

  const candidate = resolve(root, '.psp/candidate-use-cases.yaml');
  await writeFile(candidate, stringifyYaml(artifact.data));
  const applied = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact',
    '--artifact', 'capabilities',
    '--input', candidate,
    '--json',
  ]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));
  const authority = await readFile(artifact.path, 'utf8');
  const ucMarkdown = await readFile(ucPath, 'utf8');
  assert.match(authority, /轻量用例产品/);
  assert.match(ucMarkdown, /# 轻量用例产品用例/);
  assert.equal((ucMarkdown.match(/```mermaid/g) || []).length, 1);
  assert.match(ucMarkdown, /flowchart TB/);
  assert.match(ucMarkdown, /- 范围内：维护稳定用例/);
  assert.match(ucMarkdown, /- 产品负责人 → 确认产品行为（UC-001）/);
  assert.match(ucMarkdown, /### UC-001｜确认产品行为/);
  assert.match(ucMarkdown, /结果：系统检查行为和引用/);
  assert.match(ucMarkdown, /参与者引用无效/);
  assert.doesNotMatch(ucMarkdown, /<!-- OFFICIAL|^---$|generated:|artifactRole|internalModel|^status:|^version:|## Gates|GAP-[0-9]|Projection Rules|Product Package|PSP\.md/mi);
  assert.doesNotMatch(ucMarkdown, /^\|/m);

  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
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
      message: /UI Use Case 缺少 Low-Fi UI Blueprint/,
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

test.skip('independent Interactions projection was removed by the atomic UC model', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts.interactions;
  const interactionArtifact = await readArtifact(root, stage, binding);
  interactionArtifact.data.screens[0].regions[1].controls.push({
    id: 'CONTROL-003',
    type: 'selection',
    label: '严格模式',
    purpose: '选择是否执行严格校验',
    dataBinding: 'strictMode',
    action: null,
  }, {
    id: 'CONTROL-004',
    type: 'input',
    label: 'Package 路径',
    purpose: '输入待校验 Package 路径',
    dataBinding: 'packagePath',
    action: null,
  });
  interactionArtifact.data.interactionStates.push({
    id: 'INT-STATE-004',
    screen: 'SCREEN-001',
    type: 'validation',
    condition: '等待人工复核',
    stateDelta: {
      show: ['REGION-001', 'REGION-002', 'REGION-003', 'CONTROL-002'],
      hide: [],
      enable: [],
      disable: ['CONTROL-001'],
      content: [{ target: 'CONTROL-002', value: '待确认状态和复核原因' }],
    },
    terminal: true,
  });
  interactionArtifact.data.wireflows[0].completionStates.push('INT-STATE-004');
  interactionArtifact.data.wireflows[0].steps.push({
    id: 'WF-001-STEP-03',
    scenarioRef: 'main',
    useCaseStepRefs: ['UC-001-STEP-01'],
    from: { screen: 'SCREEN-001', state: 'INT-STATE-001' },
    trigger: { event: 'manual-review-required', control: null },
    guard: '需要人工复核',
    branchLabel: '待确认',
    to: { screen: 'SCREEN-001', state: 'INT-STATE-004' },
  });
  const interactionCandidate = resolve(root, '.psp/candidate-interactions');
  await mkdir(resolve(interactionCandidate, 'ACTOR-001'), { recursive: true });
  await writeFile(resolve(interactionCandidate, 'ACTOR-001', 'wireflow-mid.yaml'), stringifyYaml(interactionArtifact.data));
  const interactionApplied = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact',
    '--artifact', 'interactions',
    '--input', interactionCandidate,
    '--json',
  ]);
  assert.equal(interactionApplied.exitCode, 0, JSON.stringify(interactionApplied.output, null, 2));
  const markdown = await readFile(resolve(root, stage.root, binding.memberOutputs[0].root, 'ACTOR-001', binding.memberOutputs[0].member), 'utf8');
  assert.match(markdown, /## 站点地图（Sitemap）/);
  assert.match(markdown, /- 单页站点：规格检查页（入口）/);
  assert.match(markdown, /## 用户流程图（User Flow）/);
  assert.match(markdown, /图例：矩形 State Node（状态节点）/);
  assert.match(markdown, /flowchart LR/);
  assert.match(markdown, /运行验证/);
  const userFlow = markdown.match(/```mermaid\nflowchart LR[\s\S]+?```/);
  assert.ok(userFlow, '必须生成 User Flow Mermaid');
  assert.match(userFlow[0], /entry\(\["入口"\]\) --> state_1/);
  assert.match(userFlow[0], /state_1\["规格检查页<br\/>尚未运行验证"\]/);
  assert.match(userFlow[0], /decision_1\{"验证规格结果"\}/);
  assert.match(userFlow[0], /-->\|"成功"\| state_2/);
  assert.match(userFlow[0], /-->\|"失败"\| state_3/);
  assert.match(userFlow[0], /terminal_1\(\["成功结束"\]\)/);
  assert.match(userFlow[0], /terminal_2\(\["失败结束"\]\)/);
  assert.match(userFlow[0], /state_1 -->\|"系统返回结果"\| decision_2/);
  assert.match(userFlow[0], /decision_2 -->\|"待确认"\| state_4/);
  assert.match(userFlow[0], /terminal_3\(\["待确认结束"\]\)/);
  assert.doesNotMatch(userFlow[0], /WF-|UC-|SCREEN-|CONTROL-|validate-package|manual-review-required|Package 中存在无法解析的引用|需要人工复核/);
  assert.match(markdown, /## 线框图（Wireframe）/);
  assert.match(markdown, /对应 Use Case：\[UC-001\]\(\.\.\/\.\.\/UC\.md\)/);
  assert.match(markdown, /\+----------------------------------------------------------------------------------------\+/);
  assert.match(markdown, /验证工作区/);
  assert.match(markdown, /\[运行验证\]/);
  assert.match(markdown, /\( \) 严格模式/);
  assert.match(markdown, /Package 路径：\[____________\]/);
  assert.match(markdown, /#### 页面状态/);
  assert.match(markdown, /\*\*成功\*\*｜所有结构、引用和门禁检查通过/);
  assert.match(markdown, /控件「验证结果」显示“通过状态和验证证据”/);
  assert.doesNotMatch(markdown, /纵向排列|横向排列/);
  const frame = markdown.match(/```text\n([\s\S]+?)\n```/);
  assert.ok(frame, '必须生成文本线框图');
  const visualWidths = frame[1].split('\n').map((line) => [...line].reduce((width, character) => (
    width + (/[ᄀ-ᅟ〈〉⺀-꓏가-힣豈-﫿︐-﹯＀-｠￠-￦]/u.test(character) ? 2 : 1)
  ), 0));
  assert.deepEqual([...new Set(visualWidths)], [90], '中英文混排时线框应保持右边界对齐');
  assert.doesNotMatch(markdown, /\| 用户目标 \||\| Actor 动作 \||\| 系统响应 \||\| 可见反馈 \|/);
  assert.doesNotMatch(markdown, /规格作者选择运行验证|执行检查并汇总通过证据|结果区显示通过状态和证据/);
  assert.doesNotMatch(markdown, /<!-- OFFICIAL|^---$|generated:|artifactRole|internalModel|^status:|^version:|## Gates|GAP-[0-9]|siteMap:|wireflows:|interactionStates:|SCREEN-001|INT-STATE-001|CONTROL-001/mi);
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'wireflow', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
  const useCasesOnly = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'use-cases', '--json']);
  assert.equal(useCasesOnly.exitCode, 0, JSON.stringify(useCasesOnly.output, null, 2));
});

test.skip('independent Interactions validation was removed by the atomic UC model', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const interactions = await readArtifact(root, stage, stage.artifacts.interactions);
  interactions.data.siteMap.nodes.push({ screen: 'SCREEN-001', parent: 'SCREEN-001' });
  interactions.data.screens[0].layoutTree.children.push({ type: 'region', region: 'REGION-001' });
  interactions.data.wireflows[0].steps[0].useCaseStepRefs = ['UC-001-STEP-99'];
  interactions.data.wireflows[0].steps.push({
    ...structuredClone(interactions.data.wireflows[0].steps[0]),
    id: 'WF-001-STEP-03',
    guard: '另一项成功结果',
  });
  interactions.data.wireflows[0].steps[1].from = { screen: 'SCREEN-001', state: 'INT-STATE-003' };
  interactions.data.interactionStates[0].stateDelta.enable = [];
  interactions.data.gates[0].id = interactions.data.gates[1].id;
  await writeArtifact(interactions);
  const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'wireflow', '--json']);
  assert.notEqual(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  const messages = result.output.blockers.map((item) => item.message).join('\n');
  assert.match(messages, /Sitemap 重复放置 Screen：SCREEN-001/);
  assert.match(messages, /Sitemap 页面不能以自身为父页面：SCREEN-001/);
  assert.match(messages, /布局树必须且只能放置一次 Region：SCREEN-001 \/ REGION-001/);
  assert.match(messages, /useCaseStepRefs 引用不存在：UC-001-STEP-99/);
  assert.match(messages, /同一判断的 branchLabel 必须唯一：WF-001 \/ 成功/);
  assert.match(messages, /触发 Control 在起始状态未启用：WF-001-STEP-01 \/ CONTROL-001/);
  assert.match(messages, /完成状态无法从 Wireflow 入口到达：WF-001 \/ INT-STATE-003/);
  assert.ok(codes(result).has('AIH_ARTIFACT_SCHEMA_FAILED'));
});

test.skip('independent Wireflow collection transaction was removed by the atomic UC model', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);
  const firstInteraction = await readArtifact(root, stage, stage.artifacts.interactions);

  capabilities.data.actors.push({ id: 'ACTOR-002', name: '审核人员', goal: '复核产品规格' });
  const secondUseCase = JSON.parse(JSON.stringify(capabilities.data.useCases[0]).replaceAll('UC-001', 'UC-002').replaceAll('ACTOR-001', 'ACTOR-002'));
  secondUseCase.name = '复核产品规格 Package';
  secondUseCase.actor = 'ACTOR-002';
  secondUseCase.businessRules = [];
  capabilities.data.useCases.push(secondUseCase);
  const capabilityCandidate = resolve(root, '.psp/candidate-use-cases-two-actors.yaml');
  await writeFile(capabilityCandidate, stringifyYaml(capabilities.data));
  const capabilityApplied = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact', '--artifact', 'capabilities', '--input', capabilityCandidate, '--json',
  ]);
  assert.equal(capabilityApplied.exitCode, 0, JSON.stringify(capabilityApplied.output, null, 2));

  let second = JSON.stringify(firstInteraction.data);
  for (const [from, to] of [
    ['ACTOR-001', 'ACTOR-002'], ['UC-001', 'UC-002'], ['IF-001', 'WF-002'], ['SCREEN-001', 'SCREEN-002'],
    ['REGION-001', 'REGION-004'], ['REGION-002', 'REGION-005'], ['REGION-003', 'REGION-006'],
    ['CONTROL-001', 'CONTROL-005'], ['CONTROL-002', 'CONTROL-006'],
    ['INT-STATE-001', 'INT-STATE-005'], ['INT-STATE-002', 'INT-STATE-006'], ['INT-STATE-003', 'INT-STATE-007'],
  ]) second = second.replaceAll(from, to);
  const secondInteraction = JSON.parse(second);
  const candidateRoot = resolve(root, '.psp/candidate-wireflow-set');
  for (const [actor, data] of [['ACTOR-001', firstInteraction.data], ['ACTOR-002', secondInteraction]]) {
    await mkdir(resolve(candidateRoot, actor), { recursive: true });
    await writeFile(resolve(candidateRoot, actor, 'wireflow-mid.yaml'), stringifyYaml(data));
  }
  const applied = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact', '--artifact', 'interactions', '--input', candidateRoot, '--json',
  ]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));

  const modelRoot = resolve(root, stage.root, stage.artifacts.interactions.internalModelSet.root);
  const documentRoot = resolve(root, stage.root, stage.artifacts.interactions.memberOutputs[0].root);
  for (const actor of ['ACTOR-001', 'ACTOR-002']) {
    assert.ok((await stat(resolve(modelRoot, actor, 'wireflow-mid.yaml'))).isFile());
    assert.ok((await stat(resolve(documentRoot, actor, 'wireflow-mid.md'))).isFile());
  }
  const index = await readFile(resolve(documentRoot, 'README.md'), 'utf8');
  assert.match(index, /ACTOR-001.*规格作者.*ACTOR-001\/wireflow-mid\.md/s);
  assert.match(index, /ACTOR-002.*审核人员.*ACTOR-002\/wireflow-mid\.md/s);
  await assert.rejects(readFile(resolve(root, stage.root, '.psp/models/wireflow-mid.yaml'), 'utf8'));
  const strict = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'wireflow', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));

  const actorOneOnly = resolve(root, '.psp/candidate-wireflow-actor-one');
  await mkdir(resolve(actorOneOnly, 'ACTOR-001'), { recursive: true });
  await writeFile(resolve(actorOneOnly, 'ACTOR-001', 'wireflow-mid.yaml'), stringifyYaml(firstInteraction.data));
  const removed = runScript('.agents/skills/product-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-product-artifact', '--artifact', 'interactions', '--input', actorOneOnly, '--json',
  ]);
  assert.equal(removed.exitCode, 0, JSON.stringify(removed.output, null, 2));
  await assert.rejects(readFile(resolve(modelRoot, 'ACTOR-002', 'wireflow-mid.yaml'), 'utf8'));
  await assert.rejects(readFile(resolve(documentRoot, 'ACTOR-002', 'wireflow-mid.md'), 'utf8'));
  const missing = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--step', 'wireflow', '--json']);
  assert.ok(missing.output.blockers.some((item) => item.message.includes('ACTOR-002')));
});

test.skip('legacy Canonical UI Wireflow references were replaced by direct Interaction Flow references', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);
  const firstInteraction = await readArtifact(root, stage, stage.artifacts.interactions);

  capabilities.data.actors.push({ id: 'ACTOR-002', name: '审核人员', goal: '复核产品规格' });
  const secondUseCase = JSON.parse(JSON.stringify(capabilities.data.useCases[0]).replaceAll('UC-001', 'UC-002'));
  secondUseCase.name = '复核产品规格 Package';
  secondUseCase.actor = 'ACTOR-002';
  secondUseCase.businessRules = [];
  capabilities.data.useCases.push(secondUseCase);
  await writeArtifact(capabilities);

  let secondText = JSON.stringify(firstInteraction.data);
  for (const [from, to] of [
    ['ACTOR-001', 'ACTOR-002'], ['UC-001', 'UC-002'], ['IF-001', 'WF-002'], ['SCREEN-001', 'SCREEN-002'],
    ['REGION-001', 'REGION-004'], ['REGION-002', 'REGION-005'], ['REGION-003', 'REGION-006'],
    ['CONTROL-001', 'CONTROL-005'], ['CONTROL-002', 'CONTROL-006'],
    ['INT-STATE-001', 'INT-STATE-005'], ['INT-STATE-002', 'INT-STATE-006'], ['INT-STATE-003', 'INT-STATE-007'],
  ]) secondText = secondText.replaceAll(from, to);
  const secondPath = resolve(
    root,
    stage.root,
    stage.artifacts.interactions.internalModelSet.root,
    'ACTOR-002',
    stage.artifacts.interactions.internalModelSet.member,
  );
  await mkdir(resolve(secondPath, '..'), { recursive: true });
  await writeFile(secondPath, stringifyYaml(JSON.parse(secondText)));

  const { path, model } = await canonicalFixture(root);
  const crossActorModel = JSON.parse(
    JSON.stringify(model)
      .replaceAll('INT-STATE-001', 'INT-STATE-005')
      .replaceAll('IF-001', 'WF-002'),
  );
  await writeCanonical(path, crossActorModel);

  const result = runScript('.agents/skills/product-design/scripts/validate.mjs', root, ['--json']);
  const messages = result.output.blockers.map((item) => item.message).join('\n');
  assert.match(messages, /同参与者 Wireflow workflow state 引用不存在：INT-STATE-005/);
  assert.match(messages, /同参与者 Wireflow 场景 引用不存在：WF-002/);
  assert.match(messages, /同参与者 Wireflow 追溯 引用不存在：WF-002/);
});

test('static semantic entry generates deterministic hidden JSON and README projections', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const binding = stage.artifacts['canonical-ui-prototype'];
  const hidden = await readFile(resolve(root, stage.root, binding.memberProjections[0].root, 'ACTOR-001', binding.memberProjections[0].member), 'utf8');
  const readme = await readFile(resolve(root, stage.root, binding.memberProjections[1].root, 'ACTOR-001', binding.memberProjections[1].member), 'utf8');
  assert.match(hidden, /"screens":/);
  assert.match(readme, /# Canonical UI Prototype/);
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

test('Figma source registration packet validates adapter output without owning Canonical UI identifiers', async () => {
  const root = await temporaryRepository();
  const schema = JSON.parse(await readFile(
    resolve(root, '.agents/skills/capture-figma-design-source/source-registration.schema.json'),
    'utf8',
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  const packet = {
    version: '1.0.0',
    sourceId: 'DESIGN-SOURCE-001',
    sourceVersion: { kind: 'figma-file-version', value: 'fixture-version-20260715' },
    evidencePath: 'design-sources/DESIGN-SOURCE-001/evidence.json',
    evidenceSha256: 'sha256:' + 'a'.repeat(64),
    assets: [{
      path: 'public/assets/DESIGN-SOURCE-001/source.svg',
      sourceNodeId: '1:3',
      assetKind: 'icon',
      usageTargetIds: ['COMPONENT-001'],
    }],
    gaps: [],
  };
  assert.equal(validate(packet), true, JSON.stringify(validate.errors));
  assert.equal(Object.hasOwn(packet.assets[0], 'id'), false);
  delete packet.assets[0].usageTargetIds;
  assert.equal(validate(packet), false);
});

test('Canonical UI 5.0 rejects every removed legacy structure', async () => {
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
  assert.ok(codes(runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json'])).has('AIH_SOURCE_INTEGRITY_FAILED'));
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

test('exported Figma assets pass only after asset evidence and manifest hashes are closed', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  const assetRelativePath = 'public/assets/DESIGN-SOURCE-001/exported-badge.svg';
  const assetPath = resolve(areaPath, assetRelativePath);
  const assetContent = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#c8f36a"/></svg>\n';
  await writeFile(assetPath, assetContent);

  const exported = structuredClone(model);
  exported.assets.push({
    id: 'ASSET-EXPORTED-001',
    path: assetRelativePath,
    kind: 'image',
    sourceIds: ['DESIGN-SOURCE-001'],
    usageTargetIds: ['COMPONENT-001'],
    alt: 'Exported badge',
  });
  await writeCanonical(path, exported);
  const missingEvidence = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(missingEvidence).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(missingEvidence.output, null, 2));

  const evidencePath = resolve(areaPath, exported.designSources[0].evidence.path);
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  evidence.items.push({
    id: 'EVIDENCE-ASSET-EXPORTED-001',
    role: 'asset',
    path: assetRelativePath,
    sha256: sha256(assetContent),
    sourceNodeId: '1:3',
    assetKind: 'icon',
    captureScope: 'layer',
    containsDynamicContent: false,
  });
  const evidenceText = JSON.stringify(evidence, null, 2) + '\n';
  await writeFile(evidencePath, evidenceText);
  const staleManifestHash = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.ok(codes(staleManifestHash).has('AIH_SOURCE_INTEGRITY_FAILED'), JSON.stringify(staleManifestHash.output, null, 2));

  exported.designSources[0].evidence.sha256 = sha256(evidenceText);
  await writeCanonical(path, exported);
  const closed = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', root, ['--json']);
  assert.equal(closed.exitCode, 0, JSON.stringify(closed.output, null, 2));
});

test('browser validator executes declared routes, interactions and viewports with temporary evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath } = await canonicalFixture(root);
  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2));
  assert.equal(result.output.evidence.length, 6);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'route').length, 2);
  assert.equal(result.output.evidence.filter((item) => item.kind === 'scenario').length, 4);
  assert.deepEqual(new Set(result.output.evidence.filter((item) => item.kind === 'scenario').map((item) => item.viewportId)), new Set(['VIEWPORT-MOBILE', 'VIEWPORT-DESKTOP']));
  for (const item of result.output.evidence.filter((entry) => entry.kind === 'scenario')) {
    assert.equal(item.actionStateTraces.length, 1);
    const expected = item.scenarioId === 'SCENARIO-001'
      ? ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-SUCCESS']
      : ['COMPONENT-STATE-LOADING', 'COMPONENT-STATE-ERROR'];
    assert.deepEqual(item.actionStateTraces[0].stateIds, expected);
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
  assert.ok(codes(exactMismatch).has('AIH_VISUAL_SOURCE_PARITY_FAILED'), JSON.stringify(exactMismatch.output, null, 2));

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
  assert.equal(packet.maxAttempts, 3);
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
  assert.equal(packet.failures[0].blockerCode, 'AIH_VISUAL_SOURCE_PARITY_FAILED');
  assert.equal(packet.failures[0].sourceId, 'DESIGN-SOURCE-001');
  assert.equal(packet.failures[0].sourceKind, 'figma');
  assert.equal(packet.failures[0].checkKind, 'screenshot-match');
  assert.equal(packet.failures[0].designContextEvidenceItemId, 'EVIDENCE-CONTEXT-001');
  assert.ok((await stat(packet.failures[0].designContext)).isFile());
  assert.ok((await stat(packet.failures[0].sourceBaseline)).isFile());
  assert.ok((await stat(packet.failures[0].actualScreenshot)).isFile());
  assert.ok((await stat(packet.failures[0].differenceScreenshot)).isFile());
  assert.ok(packet.failures[0].differenceRegions.length > 0);
  assert.ok(packet.failures[0].differenceRegions.every((region) => (
    Number.isInteger(region.x)
    && Number.isInteger(region.y)
    && Number.isInteger(region.width)
    && Number.isInteger(region.height)
    && region.width > 0
    && region.height > 0
  )));
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

test('exact visual repair blocks non-visual failures and exhausts after three implementation attempts', async () => {
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
  let result = first;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await appendFile(exhausted.appPath, '\n// repair attempt ' + attempt + '\n');
    result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/repair.mjs', exhaustedRoot, ['--json']);
  }
  assert.equal(result.output.status, 'BLOCKED', JSON.stringify(result.output, null, 2));
  assert.match(result.stderr, /AIH_VISUAL_REPAIR_EXHAUSTED/);
  assert.equal(result.output.attempts.length, 3);
  assert.ok(result.output.attempts.every((item) => item.failures.every((failure) => (
    failure.actualScreenshot
    && failure.differenceScreenshot
  ))));
  assert.ok(result.output.attempts.every((item) => item.failures.some((failure) => (
    failure.checkKind === 'screenshot-match'
    && typeof failure.differenceRatio === 'number'
  ))));
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

test('browser validator skips accessibility checks when the user did not select them', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const { areaPath, path, model } = await canonicalFixture(root);
  delete model.accessibility;
  await writeCanonical(path, model);
  const appPath = resolve(areaPath, 'src/psp-app.ts');
  const app = await readFile(appPath, 'utf8');
  await writeFile(appPath, app.replace('              >\n                模拟错误\n              </button>', '              >\n              </button>'));
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
  assert.ok(codes(result).has('AIH_CANONICAL_UI_ASSET_FAILED'), JSON.stringify(result.output, null, 2));
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
    .replace('            <img src="/assets/DESIGN-SOURCE-001/source.svg" alt="Fixture source" width="40" height="40" />\n', '')
    .replace('                data-control-id="CONTROL-001"\n', '                data-control-id="CONTROL-001"\n                tabindex="-1"\n')
    .replace('                data-action-id="ACTION-001"', '                data-action-id="ACTION-UNKNOWN"')
    .replace('              >\n                模拟错误\n              </button>', '              >\n              </button>')
    .replace('    button {\n      min-height: 44px;', '    button {\n      box-sizing: border-box;\n      width: 30px;\n      overflow: hidden;\n      min-height: 10px;')
    .replace('button.primary { background: var(--accent); }', 'button.primary { background: var(--accent); }\n    button + button { margin-left: -10px; }')
    .replace('button:focus-visible { outline: 3px solid #678e25; outline-offset: 3px; }', 'button:focus-visible { outline: none; box-shadow: none; }'));

  const result = runScript('.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', root, ['--json']);
  const actual = codes(result);
  for (const expected of [
    'AIH_CANONICAL_UI_CONSOLE_FAILED',
    'AIH_CANONICAL_UI_NETWORK_FAILED',
    'AIH_CANONICAL_UI_VISUAL_FAILED',
    'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED',
    'AIH_CANONICAL_UI_ASSET_FAILED',
  ]) assert.ok(actual.has(expected), JSON.stringify(result.output, null, 2));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_CONSOLE_FAILED' && item.message.includes('页面异常')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_RUNTIME_FAILED' && item.message.includes('事件控件未绑定声明动作')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('键盘 Tab 到达')));
  assert.ok(result.output.blockers.some((item) => item.code === 'AIH_CANONICAL_UI_ACCESSIBILITY_FAILED' && item.message.includes('缺少可访问名称')));
  assert.equal(result.output.evidence.length, 6);
});
