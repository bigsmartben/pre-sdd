import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { stringify as stringifyYaml } from 'yaml';
import {
  cleanupTemporaryRepositories,
  codes,
  repositoryRoot,
  runScript,
  temporaryRepository,
} from '../helpers/fixture.mjs';
import {
  completeProductFixture,
  fixtureProject,
  markReady,
  readArtifact,
  writeArtifact,
} from '../helpers/product-fixture.mjs';

test.after(cleanupTemporaryRepositories);

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function completeArchitectureFixture(root) {
  await completeProductFixture(root);
  const initialization = runScript('.psp/harness/scripts/init-architecture.mjs', root, ['--json']);
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
    architectureGoal: '为 Spec-Kit 提供可追溯且经过实测的架构输入',
    constraints: ['产品事实只从 Product Design 读取'],
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
      inputs: [{
        name: 'validationRequest',
        description: '包含规格版本的验证请求',
        required: true,
      }],
      outputs: [{
        name: 'validationResult',
        description: '包含门禁状态与证据的校验结果',
        required: true,
      }],
      selectionRequired: true,
    }],
    dependencies: [{
      type: 'external-system',
      target: 'EXT-001',
      reason: '调用外部规则完成部分判定',
    }],
  }];
  boundary.data.externalSystems = [{
    id: 'EXT-001',
    name: '三方规则 API',
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
    fields: [{
      name: 'requestId',
      type: 'Identifier',
      required: true,
      definition: '验证请求的稳定标识',
      constraints: ['全系统唯一', '创建后不可变'],
    }, {
      name: 'specificationVersion',
      type: 'Version',
      required: true,
      definition: '被验证规格的版本',
      constraints: ['必须对应一个已存在的规格版本'],
    }],
    keys: [{
      id: 'KEY-001',
      type: 'primary',
      fields: ['requestId'],
      scope: '全系统',
      immutable: true,
    }],
    constraints: [{
      id: 'OBJECT-RULE-001',
      type: 'invariant',
      description: '每个验证请求绑定且只绑定一个规格版本',
    }],
    states: [{
      id: 'OBJECT-STATE-001',
      name: '待验证',
      definition: '请求已经建立，等待执行验证',
      initial: true,
      terminal: false,
    }, {
      id: 'OBJECT-STATE-002',
      name: '已完成',
      definition: '请求已经形成终态验证结果',
      initial: false,
      terminal: true,
    }],
  }];
  conceptual.data.relationships = [];
  conceptual.data.objectFlows = [{
    id: 'OBJECT-FLOW-001',
    object: 'OBJECT-001',
    useCase: 'UC-001',
    capability: 'ARCH-CAP-001',
    subsystem: 'SUBSYSTEM-001',
    operation: 'create',
    source: { type: 'actor', ref: 'ACTOR-001' },
    target: { type: 'subsystem', ref: 'SUBSYSTEM-001' },
    inputFields: ['requestId', 'specificationVersion'],
    outputFields: ['requestId'],
    fromState: null,
    toState: 'OBJECT-STATE-001',
    description: '规格作者创建一个待验证请求',
    rules: ['requestId 必须唯一'],
  }, {
    id: 'OBJECT-FLOW-002',
    object: 'OBJECT-001',
    useCase: 'UC-001',
    capability: 'ARCH-CAP-001',
    subsystem: 'SUBSYSTEM-001',
    operation: 'transition',
    source: { type: 'subsystem', ref: 'SUBSYSTEM-001' },
    target: { type: 'actor', ref: 'ACTOR-001' },
    inputFields: ['requestId'],
    outputFields: ['requestId'],
    fromState: 'OBJECT-STATE-001',
    toState: 'OBJECT-STATE-002',
    description: '校验完成后返回终态请求结果',
    rules: ['只有待验证请求可以进入已完成状态'],
  }];

  markReady(validation.data);
  validation.data.decisions = [{
    id: 'TECH-001',
    category: 'third-party-api',
    subsystem: 'SUBSYSTEM-001',
    capabilities: ['ARCH-CAP-001'],
    useCases: ['UC-001'],
    inputModels: ['OBJECT-001'],
    outputModels: ['OBJECT-001'],
    externalSystems: ['EXT-001'],
    decisionQuestion: '哪一种三方规则 API 能在约束内完成规格校验能力',
    criteria: ['支持 HTTPS', '返回可判定的结构化结果', '满足超时预算'],
    candidates: [{
      id: 'OPTION-001',
      name: '示例规则 API',
      provider: '示例 Provider',
      version: 'v1',
      officialDocumentation: 'https://example.com/docs',
      strengths: ['支持 HTTPS 与 JSON 响应'],
      risks: ['网络波动', '限流'],
    }],
    status: 'selected',
    selectedCandidate: 'OPTION-001',
    rationale: '代码实验已证明候选项满足能力输入输出和关键约束',
    limitations: ['尚未覆盖供应商限流场景'],
  }];
  validation.data.experiments = [{
    id: 'EXP-001',
    decision: 'TECH-001',
    candidate: 'OPTION-001',
    hypothesis: '合法请求可在超时预算内返回 2xx',
    source: 'cases/example-third-party-api.case.mjs',
    command: 'npm run verify -- --case EXP-001',
    requiredEnvironment: ['THIRD_PARTY_API_URL'],
    assertions: ['使用 HTTPS', 'HTTP 状态为 2xx'],
    result: {
      status: 'passed',
      executedAt: '2026-07-13T10:00:00.000Z',
      summary: 'Endpoint 可达并返回 200。',
      evidence: ['httpStatus=200', 'contentType=application/json'],
    },
    limitations: ['尚未覆盖供应商限流场景'],
  }];

  await Promise.all([
    writeArtifact(architecture),
    writeArtifact(boundary),
    writeArtifact(conceptual),
    writeArtifact(validation),
  ]);
  const render = runScript('.psp/harness/scripts/render-architecture.mjs', root, ['--json']);
  assert.equal(render.exitCode, 0, JSON.stringify(render.output, null, 2));
}

test('empty architecture workspace passes structure and blocks readiness and initialization', async () => {
  const root = await temporaryRepository();
  const structure = runScript('.psp/harness/scripts/validate-architecture.mjs', root, ['--json']);
  assert.equal(structure.exitCode, 0, JSON.stringify(structure.output, null, 2));
  assert.equal(structure.output.state, 'uninitialized');
  const strict = runScript('.psp/harness/scripts/validate-architecture.mjs', root, ['--strict', '--json']);
  assert.ok(codes(strict).has('AIH_STAGE_UNINITIALIZED'));
  const initialization = runScript('.psp/harness/scripts/init-architecture.mjs', root, ['--dry-run', '--json']);
  assert.ok(codes(initialization).has('AIH_UPSTREAM_NOT_READY'));
  const project = await fixtureProject(root);
  assert.equal(await pathExists(resolve(root, project.stages['architecture-design'].root)), false);
});

test('initialization is explicit, upstream-gated, complete and collision-safe', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['architecture-design'];

  const dryRun = runScript('.psp/harness/scripts/init-architecture.mjs', root, ['--dry-run', '--json']);
  assert.equal(dryRun.exitCode, 0, JSON.stringify(dryRun.output, null, 2));
  assert.equal(dryRun.output.upstream.status, 'PASS');
  assert.ok(dryRun.output.targets.includes(stage.root + '/' + stage.artifacts['system-boundary'].outputs[0].path));
  assert.ok(dryRun.output.targets.includes(stage.root + '/' + stage.areas['technical-validation'].root + '/src/verify.mjs'));
  assert.equal(await pathExists(resolve(root, stage.root)), false);

  const initialized = runScript('.psp/harness/scripts/init-architecture.mjs', root, ['--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const active = await fixtureProject(root);
  assert.equal(active.stages['architecture-design'].status, 'active');
  for (const binding of Object.values(active.stages['architecture-design'].artifacts)) {
    assert.match(binding.internalModel, /^\.psp\/models\/.+\.(yaml|json)$/);
    assert.equal(await pathExists(resolve(root, stage.root, binding.internalModel)), true, binding.internalModel);
    for (const output of binding.outputs) {
      assert.equal(await pathExists(resolve(root, stage.root, output.path)), true, output.path);
      assert.equal(output.role, 'user-artifact');
      assert.match(output.path, /\.md$/);
      const content = await readFile(resolve(root, stage.root, output.path), 'utf8');
      assert.match(content, /artifactRole: user-artifact/);
      assert.match(content, /internalModel: /);
    }
  }
  assert.equal(runScript('.psp/harness/scripts/validate-architecture.mjs', root, ['--json']).exitCode, 0);
  assert.ok(codes(runScript('.psp/harness/scripts/validate-architecture.mjs', root, ['--strict', '--json'])).has('AIH_ARTIFACT_INCOMPLETE'));
  assert.ok(codes(runScript('.psp/harness/scripts/init-architecture.mjs', root, ['--json'])).has('AIH_STAGE_ALREADY_INITIALIZED'));

  const collisionRoot = await temporaryRepository();
  await completeProductFixture(collisionRoot);
  const collisionProject = await fixtureProject(collisionRoot);
  const collisionStage = collisionProject.stages['architecture-design'];
  const collisionFile = resolve(collisionRoot, collisionStage.root, collisionStage.artifacts['system-boundary'].internalModel);
  await mkdir(resolve(collisionFile, '..'), { recursive: true });
  await writeFile(collisionFile, 'user-owned\n');
  const collision = runScript('.psp/harness/scripts/init-architecture.mjs', collisionRoot, ['--json']);
  assert.ok(codes(collision).has('AIH_USER_CHANGE_COLLISION'));
  assert.equal(await readFile(collisionFile, 'utf8'), 'user-owned\n');
});

test('complete UC to boundary to concept to technology decision chain passes strict validation', async () => {
  const root = await temporaryRepository();
  await completeArchitectureFixture(root);
  const strict = runScript('.psp/harness/scripts/validate-architecture.mjs', root, ['--strict', '--json']);
  assert.equal(strict.exitCode, 0, JSON.stringify(strict.output, null, 2));
  assert.equal(runScript('.psp/harness/scripts/render-architecture.mjs', root, ['--check', '--json']).exitCode, 0);

  const project = await fixtureProject(root);
  const stage = project.stages['architecture-design'];
  const boundaryProjection = await readFile(resolve(root, stage.root, stage.artifacts['system-boundary'].outputs[0].path), 'utf8');
  const conceptProjection = await readFile(resolve(root, stage.root, stage.artifacts['conceptual-model'].outputs[0].path), 'utf8');
  assert.match(boundaryProjection, /# 系统边界/);
  assert.match(boundaryProjection, /语义输入/);
  assert.match(conceptProjection, /# 概念建模/);
  assert.match(conceptProjection, /唯一键/);
  assert.match(conceptProjection, /对象数据流/);
});

test('validator rejects orphan upstream references and missing experiment code', async () => {
  const root = await temporaryRepository();
  await completeArchitectureFixture(root);
  const project = await fixtureProject(root);
  const stage = project.stages['architecture-design'];
  const boundary = await readArtifact(root, stage, stage.artifacts['system-boundary']);
  const validation = await readArtifact(root, stage, stage.artifacts['technical-validation']);
  boundary.data.useCases = ['UC-999'];
  validation.data.experiments[0].source = 'cases/missing.case.mjs';
  const areaPackagePath = resolve(root, stage.root, stage.areas['technical-validation'].root, 'package.json');
  const areaPackage = JSON.parse(await readFile(areaPackagePath, 'utf8'));
  areaPackage.scripts.verify = 'node src/missing.mjs';
  await Promise.all([
    writeArtifact(boundary),
    writeArtifact(validation),
    writeFile(areaPackagePath, JSON.stringify(areaPackage, null, 2) + '\n'),
  ]);
  runScript('.psp/harness/scripts/render-architecture.mjs', root, ['--json']);
  const result = runScript('.psp/harness/scripts/validate-architecture.mjs', root, ['--json']);
  assert.ok(codes(result).has('AIH_REFERENCE_UNRESOLVED'), JSON.stringify(result.output, null, 2));
  assert.ok(codes(result).has('AIH_TECHNICAL_VALIDATION_FAILED'), JSON.stringify(result.output, null, 2));
});

test('technical validation runner blocks missing environment without leaking credentials', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const initialized = runScript('.psp/harness/scripts/init-architecture.mjs', root, ['--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  const project = await fixtureProject(root);
  const stage = project.stages['architecture-design'];
  const runner = resolve(root, stage.root, stage.areas['technical-validation'].root, 'src/verify.mjs');
  const environment = { ...process.env };
  delete environment.THIRD_PARTY_API_URL;
  delete environment.THIRD_PARTY_API_TOKEN;
  const described = spawnSync(process.execPath, [runner, '--case', 'EXP-001', '--describe'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(described.status, 0, described.stderr);
  assert.equal(JSON.parse(described.stdout).status, 'PASS');
  const executed = spawnSync(process.execPath, [runner, '--case', 'EXP-001'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: environment,
  });
  assert.notEqual(executed.status, 0);
  const output = JSON.parse(executed.stdout);
  assert.equal(output.status, 'BLOCKED');
  assert.equal(output.blockers[0].code, 'AIH_TECHNICAL_VALIDATION_FAILED');
  assert.deepEqual(output.blockers[0].missingEnvironment, ['THIRD_PARTY_API_URL']);
});

test('architecture initialization follows alternate project binding', async () => {
  const root = await temporaryRepository();
  await completeProductFixture(root);
  const projectPath = resolve(root, 'psp.project.yaml');
  const project = await fixtureProject(root);
  const alternateRoot = ['workspace', 'architecture'].join('/');
  project.stages['architecture-design'].root = alternateRoot;
  await writeFile(projectPath, stringifyYaml(project));
  const initialized = runScript('.psp/harness/scripts/init-architecture.mjs', root, ['--json']);
  assert.equal(initialized.exitCode, 0, JSON.stringify(initialized.output, null, 2));
  assert.equal(
    await pathExists(resolve(root, alternateRoot, project.stages['architecture-design'].artifacts['system-boundary'].internalModel)),
    true,
  );
});
