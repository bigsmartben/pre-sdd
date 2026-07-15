import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  fixtureProject,
  markReady,
  readArtifact,
  writeArtifact,
} from '../../product-design/tests/helpers/product-fixture.mjs';
import { cleanupTemporaryRepositories, codes, runScript, temporaryRepository } from './helpers/fixture.mjs';

test.after(cleanupTemporaryRepositories);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function completeUseCasesFixture(root) {
  const initialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['product-design'];
  const product = await readArtifact(root, stage, stage.artifacts['product-package']);
  const capabilities = await readArtifact(root, stage, stage.artifacts.capabilities);

  markReady(product.data);
  product.data.overview = {
    productName: '示例产品',
    productGoal: '验证 Use Cases 到架构的独立移交',
    targetUsers: '规格作者',
    coreValue: '提供确定性规格交付',
  };

  markReady(capabilities.data);
  capabilities.data.intent = {
    productConcept: '规格验证工具',
    problem: '规格错误只能在交付后被发现',
    businessGoal: '减少不一致规格',
    successSignal: 'Use Cases 严格门禁稳定通过',
  };
  capabilities.data.actors = [{ id: 'ACTOR-001', name: '规格作者', goal: '交付一致规格', description: '创建和维护产品规格' }];
  capabilities.data.productScope = { included: ['创建结构化产品规格'], excluded: ['生成生产架构实现'] };
  capabilities.data.businessRules = [{ id: 'BR-001', statement: '只有有效规格才能通过验证', rationale: '保证下游输入确定', appliesTo: ['UC-001'] }];
  capabilities.data.useCases = [{
    id: 'UC-001',
    name: '验证产品规格',
    actor: 'ACTOR-001',
    goal: '交付前确认规格可被安全消费',
    value: '提前发现结构与引用问题',
    trigger: '规格作者请求验证',
    preconditions: ['规格包含待验证内容'],
    postconditions: { success: ['显示通过状态与证据'], failure: ['保留规格并显示错误'] },
    mainScenario: [{ id: 'UC-001-STEP-01', initiator: 'actor', action: '提交验证请求', systemResponse: '执行结构和引用检查', observableResult: '看到状态与证据' }],
    alternateScenarios: [{
      id: 'UC-001-EXC-01', type: 'exception', name: '规格引用无效', startsAt: 'UC-001-STEP-01', condition: '存在无法解析的引用',
      steps: [{ id: 'UC-001-EXC-01-STEP-01', initiator: 'system', action: '停止交付判定', systemResponse: '返回错误位置', observableResult: '看到失败状态' }],
      outcome: '规格保持不可交付',
    }],
    businessRules: ['BR-001'],
    acceptanceCriteria: [
      { id: 'AC-001', scenario: 'main', given: '规格有效', when: '运行验证', then: '显示通过状态与证据' },
      { id: 'AC-002', scenario: 'UC-001-EXC-01', given: '规格引用无效', when: '运行验证', then: '显示失败状态与错误位置' },
    ],
    relationships: [],
  }];

  await Promise.all([writeArtifact(product), writeArtifact(capabilities)]);
  const render = runScript('.agents/skills/product-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
}

async function completeArchitectureFixture(root) {
  await completeUseCasesFixture(root);
  const initialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-architecture', '--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));

  const project = await fixtureProject(root);
  const productStage = project.stages['product-design'];
  const stage = project.stages['architecture-design'];
  const capabilities = await readArtifact(root, productStage, productStage.artifacts.capabilities);
  const architecture = await readArtifact(root, stage, stage.artifacts['architecture-package']);
  const boundary = await readArtifact(root, stage, stage.artifacts['system-boundary']);
  const conceptual = await readArtifact(root, stage, stage.artifacts['conceptual-model']);
  const validation = await readArtifact(root, stage, stage.artifacts['technical-validation']);

  markReady(architecture.data);
  architecture.data.upstream.version = capabilities.data.metadata.version;
  architecture.data.overview = {
    systemName: '规格验证系统',
    architectureGoal: '从用例事实建立可追溯架构输入',
    constraints: ['架构只依赖已批准 Use Cases'],
  };

  markReady(boundary.data);
  boundary.data.system = {
    name: '规格验证系统',
    mission: '验证结构化规格并输出确定性结果',
    includedResponsibilities: ['校验规格结构、引用和门禁'],
    excludedResponsibilities: ['生成或改写产品事实'],
  };
  boundary.data.useCases = ['UC-001'];
  boundary.data.actorInteractions = [{
    actor: 'ACTOR-001',
    useCases: ['UC-001'],
    interaction: '提交规格并读取验证结果',
  }];
  boundary.data.subsystems = [{
    id: 'SUBSYSTEM-001',
    name: '规格校验子系统',
    purpose: '执行结构、引用与门禁检查',
    actors: ['ACTOR-001'],
    useCases: ['UC-001'],
    includedResponsibilities: ['执行规格验证并产生可审阅结果'],
    excludedResponsibilities: ['推导或修改上游产品事实'],
    capabilities: [{
      id: 'ARCH-CAP-001',
      name: '执行规格校验',
      description: '接收验证请求并输出确定性校验结果',
      useCases: ['UC-001'],
      inputs: [{ name: 'validationRequest', description: '包含规格版本的验证请求', required: true }],
      outputs: [{ name: 'validationResult', description: '包含门禁状态与证据的校验结果', required: true }],
      technicalValidationRequired: true,
    }],
    dependencies: [{ type: 'external-system', target: 'EXT-001', reason: '调用外部规则完成部分判定' }],
  }];
  boundary.data.externalSystems = [{
    id: 'EXT-001',
    name: '三方规则服务',
    responsibility: '提供外部规则判定结果',
    interaction: '通过 HTTPS 请求规则判定',
    useCases: ['UC-001'],
    dataExchanged: ['脱敏规格摘要', '规则判定状态'],
    trustBoundary: 'external',
  }];
  boundary.data.constraints = [{
    id: 'ARCH-CONSTRAINT-001',
    source: 'operational',
    statement: '三方调用必须使用 HTTPS 且不得记录凭据',
    status: 'confirmed',
    useCases: ['UC-001'],
  }];

  markReady(conceptual.data);
  conceptual.data.objects = [{
    id: 'OBJECT-001',
    name: '验证请求',
    aliases: ['规格校验请求'],
    kind: 'entity',
    definition: '一次针对结构化规格的可追溯验证请求',
    ownedBy: 'SUBSYSTEM-001',
    useCases: ['UC-001'],
    capabilities: ['ARCH-CAP-001'],
    fields: [{ name: 'requestId', type: 'Identifier', required: true, definition: '稳定标识', constraints: ['全系统唯一'] }],
    keys: [{ id: 'KEY-001', type: 'primary', fields: ['requestId'], scope: '全系统', immutable: true }],
    constraints: [{ id: 'OBJECT-RULE-001', type: 'invariant', description: '每个验证请求只绑定一个规格版本' }],
    states: [
      { id: 'OBJECT-STATE-001', name: '待验证', definition: '等待执行验证', initial: true, terminal: false },
      { id: 'OBJECT-STATE-002', name: '已完成', definition: '已形成终态结果', initial: false, terminal: true },
    ],
  }];
  conceptual.data.relationships = [];
  conceptual.data.objectFlows = [
    {
      id: 'OBJECT-FLOW-001', object: 'OBJECT-001', useCase: 'UC-001', capability: 'ARCH-CAP-001', subsystem: 'SUBSYSTEM-001', operation: 'create',
      source: { type: 'actor', ref: 'ACTOR-001' }, target: { type: 'subsystem', ref: 'SUBSYSTEM-001' },
      inputFields: ['requestId'], outputFields: ['requestId'], fromState: null, toState: 'OBJECT-STATE-001', description: '创建待验证请求', rules: ['requestId 必须唯一'],
    },
    {
      id: 'OBJECT-FLOW-002', object: 'OBJECT-001', useCase: 'UC-001', capability: 'ARCH-CAP-001', subsystem: 'SUBSYSTEM-001', operation: 'transition',
      source: { type: 'subsystem', ref: 'SUBSYSTEM-001' }, target: { type: 'actor', ref: 'ACTOR-001' },
      inputFields: ['requestId'], outputFields: ['requestId'], fromState: 'OBJECT-STATE-001', toState: 'OBJECT-STATE-002', description: '完成验证并返回结果', rules: ['只有待验证请求可以完成'],
    },
  ];

  const experimentSource = resolve(root, stage.root, stage.areas['technical-validation'].root, 'cases', 'EXP-001.case.mjs');
  await writeFile(experimentSource, `export const experiment = {
  id: 'EXP-001',
  requiredEnvironment: [],
  async run() {
    const parsed = JSON.parse('{"valid":true}');
    return {
      status: parsed.valid ? 'passed' : 'failed',
      summary: '真实代码完成结构化规则校验。',
      evidence: ['parsed.valid=' + parsed.valid],
    };
  },
};
`, 'utf8');
  const sourceSha256 = createHash('sha256').update(await readFile(experimentSource)).digest('hex');
  const technicalRoot = resolve(root, stage.root, stage.areas['technical-validation'].root);
  const execution = spawnSync(process.execPath, [resolve(technicalRoot, 'src', 'verify.mjs'), '--case', 'EXP-001'], {
    cwd: technicalRoot,
    encoding: 'utf8',
    env: { ...process.env },
    windowsHide: true,
  });
  assert.equal(execution.status, 0, execution.stderr + execution.stdout);
  const executionReceipt = JSON.parse(execution.stdout);
  assert.equal(executionReceipt.status, 'PASS');
  assert.equal(executionReceipt.sourceSha256, sourceSha256);
  markReady(validation.data);
  validation.data.decisions = [{
    id: 'TECH-001',
    category: 'library',
    subsystem: 'SUBSYSTEM-001',
    capabilities: ['ARCH-CAP-001'],
    useCases: ['UC-001'],
    externalSystems: [],
    decisionQuestion: '哪种规则校验库可验证结构化规格',
    criteria: ['可执行结构化规则', '返回确定性结果'],
    candidates: [{
      id: 'OPTION-001', name: '示例规则库', provider: '示例 Provider', version: 'v1',
      officialDocumentation: 'https://example.com/docs', strengths: ['返回确定性结果'], risks: ['规则版本漂移'],
    }],
    status: 'selected',
    selectedCandidate: 'OPTION-001',
    rationale: '真实代码实验已证明该选择满足关键能力约束',
    limitations: ['尚未覆盖供应商限流'],
  }];
  validation.data.experiments = [{
    id: 'EXP-001',
    decision: 'TECH-001',
    candidate: 'OPTION-001',
    hypothesis: '结构化输入可被真实代码解析并返回确定性通过状态',
    source: 'cases/EXP-001.case.mjs',
    command: 'npm run verify -- --case EXP-001',
    requiredEnvironment: [],
    assertions: ['真实代码完成 JSON 解析', '结果状态为 passed'],
    result: {
      status: executionReceipt.result.status,
      executedAt: executionReceipt.executedAt,
      sourceSha256: executionReceipt.sourceSha256,
      summary: executionReceipt.result.summary,
      evidence: executionReceipt.result.evidence,
    },
    limitations: ['尚未覆盖供应商限流'],
  }];

  await Promise.all([
    writeArtifact(architecture),
    writeArtifact(boundary),
    writeArtifact(conceptual),
    writeArtifact(validation),
  ]);
  const render = runScript('.agents/skills/architecture-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
  return { project, stage, validation };
}

test('architecture empty scaffold passes structure and blocks readiness', async () => {
  const root = await temporaryRepository();
  const structure = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--json']);
  assert.equal(structure.exitCode, 0, JSON.stringify(structure.output, null, 2));
  assert.equal(structure.output.state, 'uninitialized');
  const strict = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(strict).has('AIH_STAGE_UNINITIALIZED'));
});

test('architecture initialization depends on Use Cases and creates every fixed input directory', async () => {
  const root = await temporaryRepository();
  const blocked = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-architecture', '--json']);
  assert.notEqual(blocked.exitCode, 0);
  assert.ok(codes(blocked).has('AIH_STAGE_UNINITIALIZED') || codes(blocked).has('AIH_UPSTREAM_NOT_READY'));

  await completeUseCasesFixture(root);
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-architecture', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['architecture-design'];
  for (const binding of Object.values(stage.artifacts)) {
    assert.equal(await pathExists(resolve(root, stage.root, binding.inputRoot)), true, binding.inputRoot);
  }
});

test('complete Use Case to key capability to selection to real-code conclusion mapping passes strict validation', async () => {
  const root = await temporaryRepository();
  await completeArchitectureFixture(root);
  const strict = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
});

test('strict validation blocks a recorded pass when the experiment source hash changes', async () => {
  const root = await temporaryRepository();
  const { validation } = await completeArchitectureFixture(root);
  validation.data.experiments[0].result.sourceSha256 = '0'.repeat(64);
  await writeArtifact(validation);
  runScript('.agents/skills/architecture-design/scripts/render.mjs', root, ['--json']);
  const strict = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.ok(codes(strict).has('AIH_TECHNICAL_VALIDATION_FAILED'), JSON.stringify(strict.output, null, 2));
});

test('all architecture artifacts declare fixed inputs owned by the Architecture Design Skill', async () => {
  const root = await temporaryRepository();
  const project = await fixtureProject(root);
  const manifest = JSON.parse(await readFile(resolve(root, '.psp/harness/harness.manifest.json'), 'utf8'));
  const artifacts = manifest.artifactRegistry.filter((item) => item.stage === 'architecture-design');
  assert.equal(artifacts.length, 4);
  for (const item of artifacts) {
    assert.equal(item.domain, 'architecture-design');
    assert.match(item.contract, /^\.agents\/skills\/architecture-design\//);
    assert.match(item.schema, /^\.agents\/skills\/architecture-design\//);
    assert.match(project.stages['architecture-design'].artifacts[item.id].inputRoot, /^inputs\/[a-z][a-z0-9-]*$/);
  }
  const expectedInputs = {
    'architecture-package': ['capabilities', 'system-boundary', 'conceptual-model', 'technical-validation'],
    'system-boundary': ['capabilities'],
    'conceptual-model': ['capabilities', 'system-boundary'],
    'technical-validation': ['capabilities', 'system-boundary'],
  };
  for (const item of artifacts) {
    const contract = parseYaml(await readFile(resolve(root, item.contract), 'utf8'));
    assert.deepEqual(contract.spec.inputs.artifacts, expectedInputs[item.id]);
    assert.equal(contract.spec.inputs.directoryRole, 'supporting-input');
  }
});
