import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
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

async function snapshotTree(path, relative = '') {
  const entries = await readdir(resolve(path, relative), { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries) {
    const next = relative ? relative + '/' + entry.name : entry.name;
    if (entry.isDirectory()) snapshot.push(...await snapshotTree(path, next));
    else if (entry.isFile()) snapshot.push([next, (await readFile(resolve(path, next))).toString('base64')]);
  }
  return snapshot.sort(([left], [right]) => left.localeCompare(right));
}

async function completeArchitectureFixture(root) {
  const initialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-architecture', '--json']);
  assert.equal(initialization.exitCode, 0, JSON.stringify(initialization.output, null, 2));

  const project = await fixtureProject(root);
  const stage = project.stages['architecture-design'];
  const architecture = await readArtifact(root, stage, stage.artifacts['architecture-package']);
  const boundary = await readArtifact(root, stage, stage.artifacts['system-boundary']);
  const conceptual = await readArtifact(root, stage, stage.artifacts['conceptual-model']);
  const validation = await readArtifact(root, stage, stage.artifacts['technical-validation']);

  markReady(architecture.data);
  architecture.data.overview = {
    systemName: '规格验证系统',
    architectureGoal: '从用例事实建立可追溯架构输入',
    constraints: ['架构输入与 Product Design 生命周期解耦'],
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

test('architecture initialization ignores Product Design lifecycle state and never writes 01', async () => {
  const scenarios = [
    { name: 'uninitialized', initializeProduct: false, status: 'uninitialized' },
    { name: 'active with draft artifacts', initializeProduct: true, status: 'active' },
    { name: 'published', initializeProduct: true, status: 'published' },
    { name: 'reopened as active', initializeProduct: true, status: 'active', reopened: true },
  ];
  for (const scenario of scenarios) {
    const root = await temporaryRepository();
    if (scenario.initializeProduct) {
      const productInitialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
      assert.equal(productInitialization.exitCode, 0, scenario.name + ': ' + JSON.stringify(productInitialization.output, null, 2));
      const projectPath = resolve(root, 'psp.project.yaml');
      const project = parseYaml(await readFile(projectPath, 'utf8'));
      if (scenario.reopened) project.stages['product-design'].status = 'published';
      project.stages['product-design'].status = scenario.status;
      await writeFile(projectPath, stringifyYaml(project));
    }
    const productRoot = resolve(root, '01-product-design');
    const before = await snapshotTree(productRoot);
    const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-architecture', '--json']);
    assert.equal(initialized.exitCode, 0, scenario.name + ': ' + JSON.stringify(initialized.output, null, 2));
    assert.deepEqual(await snapshotTree(productRoot), before, scenario.name);
    assert.equal(initialized.output.outputs.some((path) => path.startsWith('01-product-design/')), false, scenario.name);
    const project = await fixtureProject(root);
    const stage = project.stages['architecture-design'];
    for (const binding of Object.values(stage.artifacts)) {
      assert.equal(await pathExists(resolve(root, stage.root, binding.inputRoot)), true, binding.inputRoot);
    }
  }
});

test('architecture artifact operation commits its YAML and Markdown as one revision', async () => {
  const root = await temporaryRepository();
  const initialized = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-architecture', '--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['architecture-design'];
  const binding = stage.artifacts['system-boundary'];
  const artifact = await readArtifact(root, stage, binding);
  artifact.data.system.name = '轻量产物写入架构系统';
  const candidate = resolve(root, '.psp/candidate-system-boundary.yaml');
  await writeFile(candidate, stringifyYaml(artifact.data));
  const productRoot = resolve(root, '01-product-design');
  const productBefore = await snapshotTree(productRoot);
  const applied = runScript('.agents/skills/architecture-design/scripts/apply-artifact.mjs', root, [
    '--operation', 'apply-architecture-artifact',
    '--artifact', 'system-boundary',
    '--input', candidate,
    '--json',
  ]);
  assert.equal(applied.exitCode, 0, JSON.stringify(applied.output, null, 2));
  const authority = await readFile(artifact.path, 'utf8');
  const markdown = await readFile(resolve(root, stage.root, binding.outputs[0].path), 'utf8');
  assert.match(authority, /轻量产物写入架构系统/);
  assert.match(markdown, /轻量产物写入架构系统/);
  assert.doesNotMatch(markdown, /sourceSha256:/);
  assert.deepEqual(await snapshotTree(productRoot), productBefore);
});

test('complete Architecture mapping from local Use Case to capability to real-code conclusion passes strict validation', async () => {
  const root = await temporaryRepository();
  await completeArchitectureFixture(root);
  const strict = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
});

test('optional Product Design reference is fixed-version read-only and ignores lifecycle status', async () => {
  const root = await temporaryRepository();
  const productInitialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-product', '--json']);
  assert.equal(productInitialization.exitCode, 0, JSON.stringify(productInitialization.output, null, 2));
  const architectureInitialization = runScript('.psp/harness/scripts/initialize-stage.mjs', root, ['--operation', 'initialize-architecture', '--json']);
  assert.equal(architectureInitialization.exitCode, 0, JSON.stringify(architectureInitialization.output, null, 2));

  const projectPath = resolve(root, 'psp.project.yaml');
  const project = parseYaml(await readFile(projectPath, 'utf8'));
  project.stages['product-design'].status = 'published';
  await writeFile(projectPath, stringifyYaml(project));
  const stage = project.stages['architecture-design'];
  const architecture = await readArtifact(root, stage, stage.artifacts['architecture-package']);
  architecture.data.productDesignInput = {
    mode: 'reference',
    reference: {
      stage: 'product-design',
      artifact: 'capabilities',
      version: '0.1.0',
      access: 'read-only',
    },
  };
  await writeArtifact(architecture);
  let render = runScript('.agents/skills/architecture-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
  const productRoot = resolve(root, '01-product-design');
  const productBefore = await snapshotTree(productRoot);
  const valid = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--json']);
  assert.equal(valid.exitCode, 0, JSON.stringify(valid.output, null, 2));
  assert.deepEqual(await snapshotTree(productRoot), productBefore);

  architecture.data.productDesignInput.reference.version = '9.9.9';
  await writeArtifact(architecture);
  render = runScript('.agents/skills/architecture-design/scripts/render.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
  const invalid = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--json']);
  assert.ok(codes(invalid).has('AIH_REFERENCE_UNRESOLVED'));
  assert.equal(codes(invalid).has('AIH_UPSTREAM_NOT_READY'), false);
  assert.deepEqual(await snapshotTree(productRoot), productBefore);
});

test('each Architecture artifact passes its independent readiness step', async () => {
  const root = await temporaryRepository();
  await completeArchitectureFixture(root);
  for (const step of ['system-boundary', 'conceptual-model', 'technical-validation', 'architecture-package']) {
    const result = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--step', step, '--json']);
    assert.equal(result.exitCode, 0, step + ': ' + JSON.stringify(result.output, null, 2));
    assert.equal(result.output.mode, step);
  }
});

test('strict validation accepts the current experiment result without a persisted source hash', async () => {
  const root = await temporaryRepository();
  const { validation } = await completeArchitectureFixture(root);
  assert.equal(Object.hasOwn(validation.data.experiments[0].result, 'sourceSha256'), false);
  const strict = runScript('.agents/skills/architecture-design/scripts/validate.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
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
    'architecture-package': ['system-boundary', 'conceptual-model', 'technical-validation'],
    'system-boundary': [],
    'conceptual-model': ['system-boundary'],
    'technical-validation': ['system-boundary'],
  };
  for (const item of artifacts) {
    const contract = parseYaml(await readFile(resolve(root, item.contract), 'utf8'));
    assert.deepEqual(contract.spec.inputs.artifacts, expectedInputs[item.id]);
    assert.equal(contract.spec.inputs.directoryRole, 'supporting-input');
  }
  const packageContract = parseYaml(await readFile(resolve(root, artifacts.find((item) => item.id === 'architecture-package').contract), 'utf8'));
  assert.deepEqual(packageContract.spec.references, [{
    stage: 'product-design',
    artifact: 'capabilities',
    required: false,
    access: 'read-only',
    fixedVersionField: 'productDesignInput.reference.version',
    lifecycleControl: 'none',
  }]);
});
