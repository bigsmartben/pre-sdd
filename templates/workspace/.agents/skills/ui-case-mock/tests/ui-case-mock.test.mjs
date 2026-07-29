import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { cleanupTemporaryRepositories, runScript, temporaryRepository } from '../../product-design/tests/helpers/fixture.mjs';
import {
  completeProductFixture,
  fixtureProject,
  readArtifact,
  writeArtifact,
} from '../../product-design/tests/helpers/product-fixture.mjs';
import { analyzeUiCaseCoverage, compileUiCaseRuntime } from '../scripts/model.mjs';
import { runRuntime } from '../scripts/runtime-runner.mjs';

const workspaceRoot = resolve(import.meta.dirname, '../../../..');
test.after(cleanupTemporaryRepositories);

function minimalModel() {
  const contracts = ['A', 'B'].map((suffix) => ({
    id: `CONTRACT-${suffix}`,
    componentId: `COMPONENT-${suffix}`,
    visualComponentId: `VISUAL-COMPONENT-00${suffix === 'A' ? '1' : '2'}`,
    mappingId: `MAPPING-${suffix}`,
    defaultStateMatrixEntryId: `MATRIX-${suffix}-DEFAULT`,
    attributes: [{ name: 'disabled', propertyName: 'disabled' }],
    properties: [
      { name: 'mode', type: 'string' },
      { name: 'previewState', type: 'string' },
      { name: 'message', type: 'string' },
      { name: 'disabled', type: 'boolean' },
    ],
    slots: ['label'],
    pageInstances: [{ id: `INSTANCE-${suffix}`, screenId: 'SCREEN-001' }],
  }));
  const mappings = contracts.map((contract, index) => ({
    id: contract.mappingId,
    propertyMappings: [{
      kind: 'variant',
      figmaProperty: 'Mode',
      litProperty: 'mode',
      litAttribute: 'mode',
      values: [
        { figmaValue: 'Default', litValue: 'default' },
        { figmaValue: 'Busy', litValue: 'busy' },
      ],
    }],
  }));
  const axes = contracts.flatMap((contract, index) => {
    const suffix = index === 0 ? 'A' : 'B';
    return [
      {
        id: `AXIS-${suffix}-MODE`,
        componentContractId: contract.id,
        kind: 'variant',
        name: 'Mode',
        renderBinding: { kind: 'mapped-variant' },
        values: [
          { id: `VALUE-${suffix}-MODE-DEFAULT`, value: 'Default' },
          { id: `VALUE-${suffix}-MODE-BUSY`, value: 'Busy' },
        ],
      },
      {
        id: `AXIS-${suffix}-STATE`,
        componentContractId: contract.id,
        kind: 'runtime-state',
        name: 'status',
        renderBinding: { kind: 'component-state', name: 'previewState' },
        values: [
          { id: `VALUE-${suffix}-STATE-DEFAULT`, value: 'default', stateId: `STATE-${suffix}-DEFAULT`, renderValue: `STATE-${suffix}-DEFAULT` },
          { id: `VALUE-${suffix}-STATE-LOADING`, value: 'loading', stateId: `STATE-${suffix}-LOADING`, renderValue: `STATE-${suffix}-LOADING` },
        ],
      },
      {
        id: `AXIS-${suffix}-DISABLED`,
        componentContractId: contract.id,
        kind: 'content-override',
        name: 'disabled',
        renderBinding: { kind: 'lit-attribute', name: 'disabled' },
        values: [
          { id: `VALUE-${suffix}-ENABLED`, value: 'enabled', renderValue: false },
          { id: `VALUE-${suffix}-DISABLED`, value: 'disabled', renderValue: true },
        ],
      },
      {
        id: `AXIS-${suffix}-MESSAGE`,
        componentContractId: contract.id,
        kind: 'content-override',
        name: 'message',
        renderBinding: { kind: 'lit-property', name: 'message' },
        values: [
          { id: `VALUE-${suffix}-MESSAGE-DEFAULT`, value: 'default', renderValue: '默认信息' },
          { id: `VALUE-${suffix}-MESSAGE-ALT`, value: 'alternate', renderValue: '替代信息' },
        ],
      },
      {
        id: `AXIS-${suffix}-LABEL`,
        componentContractId: contract.id,
        kind: 'content-override',
        name: 'label',
        renderBinding: { kind: 'slot-text', name: 'label' },
        values: [
          { id: `VALUE-${suffix}-LABEL-DEFAULT`, value: 'default', renderValue: '提交' },
          { id: `VALUE-${suffix}-LABEL-ALT`, value: 'alternate', renderValue: '重试' },
        ],
      },
    ];
  });
  const matrix = contracts.flatMap((contract, index) => {
    const suffix = index === 0 ? 'A' : 'B';
    return [
      {
        id: `MATRIX-${suffix}-DEFAULT`,
        componentContractId: contract.id,
        values: {
          [`AXIS-${suffix}-MODE`]: `VALUE-${suffix}-MODE-DEFAULT`,
          [`AXIS-${suffix}-STATE`]: `VALUE-${suffix}-STATE-DEFAULT`,
          [`AXIS-${suffix}-DISABLED`]: `VALUE-${suffix}-ENABLED`,
          [`AXIS-${suffix}-MESSAGE`]: `VALUE-${suffix}-MESSAGE-DEFAULT`,
          [`AXIS-${suffix}-LABEL`]: `VALUE-${suffix}-LABEL-DEFAULT`,
        },
        classification: 'legal',
      },
      {
        id: `MATRIX-${suffix}-ALT`,
        componentContractId: contract.id,
        values: {
          [`AXIS-${suffix}-MODE`]: `VALUE-${suffix}-MODE-BUSY`,
          [`AXIS-${suffix}-STATE`]: `VALUE-${suffix}-STATE-LOADING`,
          [`AXIS-${suffix}-DISABLED`]: `VALUE-${suffix}-DISABLED`,
          [`AXIS-${suffix}-MESSAGE`]: `VALUE-${suffix}-MESSAGE-ALT`,
          [`AXIS-${suffix}-LABEL`]: `VALUE-${suffix}-LABEL-ALT`,
        },
        classification: 'legal',
      },
    ];
  });
  return {
    routes: [{ id: 'ROUTE-001', path: '/', screenId: 'SCREEN-001' }],
    viewports: [{ id: 'VIEWPORT-DESKTOP', width: 1440, height: 900 }],
    componentContracts: contracts,
    componentMappings: mappings,
    stateAxes: axes,
    stateMatrix: matrix,
    uiViewModels: [
      { id: 'UI-VM-001', name: '默认组合', routeId: 'ROUTE-001', base: 'component-contract-defaults', overrides: [] },
      {
        id: 'UI-VM-002',
        name: '双组件变体组合',
        routeId: 'ROUTE-001',
        base: 'component-contract-defaults',
        overrides: [
          { pageInstanceId: 'INSTANCE-A', stateMatrixEntryId: 'MATRIX-A-ALT' },
          { pageInstanceId: 'INSTANCE-B', stateMatrixEntryId: 'MATRIX-B-ALT' },
        ],
      },
    ],
    uiCases: [
      { id: 'UI-CASE-001', name: '默认页', viewModelId: 'UI-VM-001', viewportIds: ['VIEWPORT-DESKTOP'] },
      { id: 'UI-CASE-002', name: '组合态页', viewModelId: 'UI-VM-002', viewportIds: ['VIEWPORT-DESKTOP'] },
    ],
  };
}

test('UI Case coverage accepts one ViewModel covering multiple component instances and all finite axis values', () => {
  const model = minimalModel();
  const result = analyzeUiCaseCoverage(model);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.counts, { viewModels: 2, uiCases: 2, pageInstances: 2 });
  const runtime = compileUiCaseRuntime(model);
  assert.equal(runtime.status, 'PASS');
  const combined = runtime.cases.find((item) => item.id === 'UI-CASE-002');
  assert.equal(combined.components.length, 2);
  for (const component of combined.components) {
    assert.ok(component.operations.some((operation) => operation.kind === 'property' && operation.name === 'mode' && operation.value === 'busy'), 'Variant → Lit Property');
    assert.ok(component.operations.some((operation) => operation.kind === 'attribute' && operation.name === 'mode' && operation.value === 'busy'), 'Variant → Lit Attribute');
    assert.ok(component.operations.some((operation) => operation.kind === 'property' && operation.name === 'previewState' && /STATE-.*-LOADING/.test(operation.value)), 'Runtime State → public state Property');
    assert.ok(component.operations.some((operation) => operation.kind === 'property' && operation.name === 'message' && operation.value === '替代信息'), 'Content Axis → Lit Property');
    assert.ok(component.operations.some((operation) => operation.kind === 'attribute' && operation.name === 'disabled' && operation.value === true), 'Content Axis → Lit Attribute');
    assert.ok(component.operations.some((operation) => operation.kind === 'slot' && operation.name === 'label' && operation.value === '重试'), 'Content Axis → Slot');
  }
});

test('UI Case semantic validation rejects cross-route, wrong-contract, duplicate override, unknown viewport and incomplete coverage', () => {
  const model = minimalModel();
  model.uiViewModels[1].overrides.push(
    { pageInstanceId: 'INSTANCE-A', stateMatrixEntryId: 'MATRIX-B-ALT' },
    { pageInstanceId: 'INSTANCE-UNKNOWN', stateMatrixEntryId: 'MATRIX-A-ALT' },
  );
  model.uiCases[1].viewportIds.push('VIEWPORT-UNKNOWN');
  model.uiCases.splice(0, 1);
  const result = analyzeUiCaseCoverage(model);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.blockers.some((item) => item.code === 'AIH_UI_CASE_CONTRACT_INVALID' && /重复覆盖/.test(item.message)));
  assert.ok(result.blockers.some((item) => item.code === 'AIH_UI_CASE_CONTRACT_INVALID' && /跨 Route/.test(item.message)));
  assert.ok(result.blockers.some((item) => item.code === 'AIH_UI_CASE_CONTRACT_INVALID' && /未知 Viewport/.test(item.message)));
  assert.ok(result.blockers.some((item) => item.code === 'AIH_UI_CASE_COVERAGE_INCOMPLETE' && /默认态/.test(item.message)));
});

test('Canonical UI schema rejects raw property overrides and business identities inside UI Case', async () => {
  const schema = JSON.parse(await readFile(resolve(workspaceRoot, '.agents/skills/product-design/canonical-ui-prototype/schema.json'), 'utf8'));
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  ajv.addSchema(schema);
  const validateViewModel = ajv.getSchema(`${schema.$id}#/$defs/uiViewModel`);
  const validateUiCase = ajv.getSchema(`${schema.$id}#/$defs/uiCase`);
  assert.equal(validateViewModel({
    id: 'UI-VM-001',
    name: '非法原始属性',
    routeId: 'ROUTE-001',
    base: 'component-contract-defaults',
    overrides: [{
      pageInstanceId: 'INSTANCE-A',
      stateMatrixEntryId: 'MATRIX-A-ALT',
      properties: { disabled: true },
    }],
  }), false);
  assert.equal(validateUiCase({
    id: 'UI-CASE-001',
    name: '非法业务绑定',
    viewModelId: 'UI-VM-001',
    viewportIds: ['VIEWPORT-DESKTOP'],
    useCaseId: 'UC-001',
    scenarioId: 'SCENARIO-001',
  }), false);
});

test('UI Case Mock reports a browser blocker and contains no browser installation path', async () => {
  const runner = await readFile(resolve(workspaceRoot, '.agents/skills/ui-case-mock/scripts/runtime-runner.mjs'), 'utf8');
  assert.match(runner, /AIH_UI_CASE_BROWSER_MISSING/);
  assert.match(runner, /Agent 需在后台准备浏览器依赖/);
  assert.doesNotMatch(runner, /spawn(?:Sync)?\(|exec(?:File|Sync)?\(|chromium\.install/);
});

test('project bindings keep UI Case Mock inside Product Design while independent MockCase remains separate', async () => {
  const project = parseYaml(await readFile(resolve(workspaceRoot, 'psp.project.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(project.stages), ['product-design', 'mockcase', 'architecture-design']);
  assert.ok(project.stages['product-design'].artifacts['canonical-ui-prototype']);
  assert.ok(project.stages.mockcase.artifacts['mockcase-suite']);
  for (const path of ['analyze.mjs', 'review.mjs', 'verify.mjs']) {
    assert.ok((await readFile(resolve(workspaceRoot, '.agents/skills/ui-case-mock/scripts', path), 'utf8')).length > 0);
  }
});

test('UC Case analyzer derives main, alternate and exception cases, exempts non-UI paths, and writes nothing', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);
  capabilities.data.useCases[0].alternateScenarios.push({
    id: 'UC-001-ALT-01',
    type: 'alternate',
    name: '验证内容为空',
    startsAt: 'UC-001-STEP-01',
    condition: 'Package 没有可验证内容',
    steps: [{
      id: 'UC-001-ALT-01-STEP-01',
      initiator: 'system',
      action: '系统跳过验证执行',
      outcome: '规格作者看到无需验证提示',
    }],
    outcome: 'Package 保持原状',
  });
  capabilities.data.interactionFlows[0].transitions.push({
    id: 'IF-001-TRANS-03',
    scenarioRef: 'UC-001-ALT-01',
    useCaseStepRefs: ['UC-001-ALT-01-STEP-01'],
    from: 'INT-STATE-001',
    to: 'INT-STATE-002',
    guard: '没有可验证内容',
    branchLabel: '无需验证',
    failureResponse: null,
  });
  capabilities.data.useCases.push({
    id: 'UC-002',
    name: '离线归档 Package',
    actor: 'ACTOR-001',
    goal: '按保留策略归档 Package',
    value: '满足审计保留要求',
    trigger: '归档周期到期',
    preconditions: [],
    successOutcome: 'Package 已归档',
    minimumGuarantee: '原始 Package 保持可恢复',
    uiApplicability: { mode: 'not-applicable', reason: '该用例由离线批处理完成。' },
    mainScenario: [{
      id: 'UC-002-STEP-01',
      initiator: 'system',
      action: '系统归档到期 Package',
      outcome: '归档记录可供审计',
    }],
    alternateScenarios: [],
    businessRules: ['BR-001'],
    relationships: [],
  });
  await writeArtifact(capabilities);
  const before = (await readdir(root, { recursive: true })).map(String).sort();
  const result = runScript('.agents/skills/product-design/scripts/analyze-uc-case-coverage.mjs', root, ['--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result.output, null, 2) + '\n' + result.stderr);
  const output = result.output;
  assert.equal(output.status, 'PASS');
  assert.deepEqual(output.cases.map((item) => item.id), [
    'UC-001-MAIN',
    'UC-001-EXC-01',
    'UC-001-ALT-01',
    'UC-002-MAIN',
  ]);
  assert.deepEqual(
    output.cases.slice(0, 3).map((item) => item.interactionCoverage),
    ['covered', 'covered', 'covered'],
  );
  assert.equal(output.cases.at(-1).interactionCoverage, 'not-applicable');
  assert.equal(output.cases.at(-1).uiApplicability, 'not-applicable');
  assert.ok(output.cases.every((item) => item.covered));
  const after = (await readdir(root, { recursive: true })).map(String).sort();
  assert.deepEqual(after, before);
});

test('UI Case Mock runtime verifies review boundary, projection, screenshots and dispose rollback', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const result = await runRuntime('verify', {
    root,
    actor: 'ACTOR-001',
    launchHeadless: true,
  });
  try {
    assert.equal(result.status, 'PASS');
    assert.ok(result.evidence.temporary);
    assert.ok(result.evidence.facts.length >= 5);
    assert.ok(result.evidence.facts.every((item) => item.status === 'PASS'));
    assert.ok(result.evidence.facts.every((item) => item.excludedReviewTools >= 1));
  } finally {
    await rm(result.evidence.root, { recursive: true, force: true });
  }
});

test('UI Case Mock runtime review waits for one explicit headed review action without creating lifecycle evidence', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const result = await runRuntime('review', {
    root,
    actor: 'ACTOR-001',
    interactiveReview: true,
    launchHeadless: true,
    reviewTimeoutMs: 15000,
    onInteractiveReady: async (page) => {
      await page.locator('[data-review-tool="ui-case-mock"] [data-ui-case-id]').first().click();
      await page.locator('[data-review-tool="ui-case-mock"] button').filter({ hasText: '结束评审' }).click();
    },
  });
  try {
    assert.equal(result.status, 'PASS');
    assert.equal(result.operation, 'review:ui-case-mock');
    assert.equal(Object.hasOwn(result, 'lifecycle'), false);
    assert.equal(result.evidence.temporary, true);
    assert.deepEqual(result.evidence.facts.map((item) => item.kind), ['review-decision']);
  } finally {
    await rm(result.evidence.root, { recursive: true, force: true });
  }
});
