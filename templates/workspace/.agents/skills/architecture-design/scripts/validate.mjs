import { access, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { parse as parseYaml } from 'yaml';
import { outputDrift } from './lib/rendering.mjs';
import {
  artifactDefinitions,
  artifactPaths,
  joinRepositoryPath,
  loadProject,
  readJson,
  repositoryFile,
  repositoryRootFrom,
  stageHasUserFiles,
} from '../../../runtime/project.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
const stageId = 'architecture-design';
const strict = process.argv.includes('--strict');
const stepIndex = process.argv.indexOf('--step');
const step = stepIndex >= 0 ? process.argv[stepIndex + 1] : null;
const readiness = strict || Boolean(step);
const json = process.argv.includes('--json');
const blockers = [];
const warnings = [];
const readinessSteps = new Set(['architecture-package', 'system-boundary', 'conceptual-model', 'technical-validation']);

function selectedArchitectureArtifacts(currentStep) {
  const dependencies = {
    'system-boundary': ['system-boundary'],
    'conceptual-model': ['system-boundary', 'conceptual-model'],
    'technical-validation': ['system-boundary', 'technical-validation'],
    'architecture-package': ['system-boundary', 'conceptual-model', 'technical-validation', 'architecture-package'],
  };
  return dependencies[currentStep] || [];
}

if (step && !readinessSteps.has(step)) {
  block('AIH_COMMAND_INVALID', '未知的架构 readiness step：' + step, 'arguments');
}
const models = new Map();

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

function duplicateIds(items, collection) {
  const seen = new Set();
  for (const item of items || []) {
    if (seen.has(item.id)) block('AIH_REFERENCE_UNRESOLVED', '标识符重复：' + item.id, collection);
    seen.add(item.id);
  }
  return seen;
}

function duplicateValues(values, collection) {
  const seen = new Set();
  for (const value of values || []) {
    if (seen.has(value)) block('AIH_REFERENCE_UNRESOLVED', '值重复：' + value, collection);
    seen.add(value);
  }
  return seen;
}

function requireReference(value, known, location) {
  if (!known.has(value)) block('AIH_REFERENCE_UNRESOLVED', '引用未知标识符：' + value, location);
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function unionOf(items, field) {
  return new Set((items || []).flatMap((item) => item[field] || []));
}

function hasDirectedCycle(edges) {
  const graph = new Map();
  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(node) {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of graph.get(node) || []) {
      if (visit(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  }
  return [...graph.keys()].some(visit);
}

function parseValidatorOutput(validation) {
  try {
    return JSON.parse(validation.stdout);
  } catch {
    return null;
  }
}

let project;
try {
  project = await loadProject(root);
} catch (error) {
  block(error.code || 'AIH_PROJECT_BINDING_INVALID', error.message, 'psp.project.yaml');
}

const stage = project?.stages?.[stageId];
const initializing = process.env.PSP_STAGE_INITIALIZING === stageId;
if (project && stage?.status === 'uninitialized' && !initializing) {
  let partial = false;
  try {
    partial = await stageHasUserFiles(root, stage.root, ['.gitkeep']);
  } catch (error) {
    block('AIH_PROJECT_BINDING_INVALID', error.message, stage.root);
  }
  const lifecycleBlockers = blockers.length > 0
    ? [...blockers]
    : partial
      ? [{
        code: 'AIH_PARTIAL_INITIALIZATION',
        message: 'uninitialized 架构阶段出现了用户文件；请清理碰撞或重新执行完整初始化。',
        location: stage.root,
      }]
      : readiness
        ? [{
          code: 'AIH_STAGE_UNINITIALIZED',
          message: '架构设计阶段尚未初始化，不能执行严格 readiness。',
          location: 'stages.architecture-design.status',
        }]
        : [];
  const lifecycleResult = {
    status: lifecycleBlockers.length === 0 ? 'PASS' : 'BLOCKED',
    mode: step || (strict ? 'strict' : 'structure'),
    state: 'uninitialized',
    blockerCount: lifecycleBlockers.length,
    blockers: lifecycleBlockers,
    warnings: partial ? [] : [{
      code: 'AIH_STAGE_UNINITIALIZED',
      message: '架构设计用户 Workspace 为空；结构绑定有效，但不存在可交付实例。',
    }],
  };
  if (json) process.stdout.write(JSON.stringify(lifecycleResult, null, 2) + '\n');
  else if (lifecycleResult.status === 'PASS') {
    console.warn('[WARN] AIH_STAGE_UNINITIALIZED：架构设计用户 Workspace 为空。');
    console.log('[PASS] 架构空状态结构校验通过。');
  } else {
    for (const item of lifecycleBlockers) console.error('[' + item.code + '] ' + item.message);
  }
  process.exit(lifecycleResult.status === 'PASS' ? 0 : 1);
}

if (stage && !['active', 'uninitialized'].includes(stage.status)) {
  block(stage.blockerCode || 'AIH_ARCHITECTURE_UNAVAILABLE', '架构阶段当前不可验证：' + stage.status, stageId);
}

if (project && blockers.length === 0) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const architectureRegistries = artifactDefinitions(project, stageId);
  const architectureArtifactIds = new Set(architectureRegistries.map((item) => item.id));
  const selectedArtifactIds = step
    ? new Set(selectedArchitectureArtifacts(step).filter((id) => architectureArtifactIds.has(id)))
    : architectureArtifactIds;
  for (const registry of architectureRegistries.filter((item) => selectedArtifactIds.has(item.id))) {
    const paths = artifactPaths(project, registry.id, registry.stage);
    if (!paths) {
      block('AIH_PROJECT_BINDING_INVALID', '项目未绑定必需 artifact：' + registry.id, registry.id);
      continue;
    }
    const expectedInputRoot = joinRepositoryPath(stage.root, 'inputs', registry.id);
    if (paths.inputRoot !== expectedInputRoot) {
      block('AIH_PROJECT_BINDING_INVALID', '架构产物 inputRoot 必须使用固定工程路径：' + expectedInputRoot, registry.id + '.inputRoot');
    }
    try {
      const model = parseYaml(await readFile(repositoryFile(root, paths.authorityPath), 'utf8'));
      models.set(registry.id, model);
      const schema = await readJson(root, registry.schema);
      const validate = ajv.compile(schema);
      if (!validate(model)) {
        for (const error of validate.errors || []) {
          block(
            'AIH_ARTIFACT_SCHEMA_FAILED',
            (error.instancePath || '/') + ' ' + error.message,
            paths.authorityPath + (error.instancePath || ''),
          );
        }
      }
    } catch (error) {
      block('AIH_ARTIFACT_SCHEMA_FAILED', error.message, paths.authorityPath);
    }
  }
}

const architecturePackage = models.get('architecture-package');
const systemBoundary = models.get('system-boundary');
const conceptualModel = models.get('conceptual-model');
const technicalValidation = models.get('technical-validation');

let capabilities;
if (architecturePackage && blockers.every((item) => item.code !== 'AIH_ARTIFACT_SCHEMA_FAILED')) {
  const productInput = architecturePackage.productDesignInput;
  if (productInput.mode === 'reference') {
    try {
      const reference = productInput.reference;
      const productPaths = artifactPaths(project, reference.artifact, reference.stage);
      if (!productPaths) throw new Error('项目未绑定引用的 Product Design Artifact。');
      capabilities = parseYaml(await readFile(repositoryFile(root, productPaths.authorityPath), 'utf8'));
      if (capabilities?.metadata?.version !== reference.version) {
        block(
          'AIH_REFERENCE_UNRESOLVED',
          '固定 Product Design 输入版本与当前 capabilities 版本不一致。',
          'architecture-package.productDesignInput.reference.version',
        );
      }
    } catch (error) {
      block(
        'AIH_REFERENCE_UNRESOLVED',
        '无法解析固定的只读 Product Design 输入：' + error.message,
        'architecture-package.productDesignInput.reference',
      );
    }
  }
}

if (systemBoundary && blockers.every((item) => item.code !== 'AIH_ARTIFACT_SCHEMA_FAILED')) {
  const boundaryUseCases = duplicateValues(systemBoundary?.useCases, 'system-boundary.useCases');
  const interactionActors = duplicateValues(
    (systemBoundary?.actorInteractions || []).map((item) => item.actor),
    'system-boundary.actorInteractions',
  );
  const actorIds = capabilities
    ? duplicateIds(capabilities.actors, 'capabilities.actors')
    : interactionActors;
  const useCaseIds = capabilities
    ? duplicateIds(capabilities.useCases, 'capabilities.useCases')
    : boundaryUseCases;
  const subsystemIds = duplicateIds(systemBoundary?.subsystems, 'system-boundary.subsystems');
  const externalSystemIds = duplicateIds(systemBoundary?.externalSystems, 'system-boundary.externalSystems');
  duplicateIds(systemBoundary?.constraints, 'system-boundary.constraints');
  const architectureCapabilities = (systemBoundary?.subsystems || []).flatMap((item) => item.capabilities);
  const architectureCapabilityIds = duplicateIds(architectureCapabilities, 'system-boundary.subsystems.capabilities');
  const subsystemById = new Map((systemBoundary?.subsystems || []).map((item) => [item.id, item]));
  const capabilityById = new Map();
  for (const subsystem of systemBoundary?.subsystems || []) {
    for (const capability of subsystem.capabilities) capabilityById.set(capability.id, { capability, subsystem });
  }

  const objectIds = duplicateIds(conceptualModel?.objects, 'conceptual-model.objects');
  duplicateIds(conceptualModel?.relationships, 'conceptual-model.relationships');
  duplicateIds(conceptualModel?.objectFlows, 'conceptual-model.objectFlows');
  const objectById = new Map((conceptualModel?.objects || []).map((item) => [item.id, item]));
  const decisionIds = duplicateIds(technicalValidation?.decisions, 'technical-validation.decisions');
  const allCandidates = (technicalValidation?.decisions || []).flatMap((item) => item.candidates);
  const candidateIds = duplicateIds(allCandidates, 'technical-validation.decisions.candidates');
  duplicateIds(technicalValidation?.experiments, 'technical-validation.experiments');
  const decisionById = new Map((technicalValidation?.decisions || []).map((item) => [item.id, item]));

  for (const useCase of boundaryUseCases) requireReference(useCase, useCaseIds, 'system-boundary.useCases');
  for (const interaction of systemBoundary?.actorInteractions || []) {
    requireReference(interaction.actor, actorIds, 'system-boundary.actorInteractions.' + interaction.actor);
    for (const useCase of interaction.useCases) {
      requireReference(useCase, useCaseIds, 'system-boundary.actorInteractions.' + interaction.actor + '.useCases');
      const referencedUseCase = capabilities?.useCases.find((item) => item.id === useCase);
      if (referencedUseCase && referencedUseCase.actor !== interaction.actor) {
        block(
          'AIH_REFERENCE_UNRESOLVED',
          useCase + ' 的 Actor 与固定 Product Design 输入不一致。',
          'system-boundary.actorInteractions.' + interaction.actor,
        );
      }
    }
  }
  const actorsByUseCase = new Map();
  for (const interaction of systemBoundary?.actorInteractions || []) {
    for (const useCase of interaction.useCases) {
      const existing = actorsByUseCase.get(useCase);
      if (existing && existing !== interaction.actor) {
        block('AIH_REFERENCE_UNRESOLVED', useCase + ' 不能同时归属多个 Actor。', 'system-boundary.actorInteractions');
      } else {
        actorsByUseCase.set(useCase, interaction.actor);
      }
    }
  }

  for (const subsystem of systemBoundary?.subsystems || []) {
    for (const actor of subsystem.actors) requireReference(actor, actorIds, 'system-boundary.subsystems.' + subsystem.id + '.actors');
    for (const useCase of subsystem.useCases) requireReference(useCase, boundaryUseCases, 'system-boundary.subsystems.' + subsystem.id + '.useCases');
    for (const capability of subsystem.capabilities) {
      duplicateValues(capability.inputs.map((item) => item.name), 'system-boundary.capabilities.' + capability.id + '.inputs');
      duplicateValues(capability.outputs.map((item) => item.name), 'system-boundary.capabilities.' + capability.id + '.outputs');
      for (const useCase of capability.useCases) {
        requireReference(useCase, new Set(subsystem.useCases), 'system-boundary.capabilities.' + capability.id + '.useCases');
      }
    }
    for (const dependency of subsystem.dependencies) {
      const known = dependency.type === 'subsystem' ? subsystemIds : externalSystemIds;
      requireReference(dependency.target, known, 'system-boundary.subsystems.' + subsystem.id + '.dependencies');
      if (dependency.target === subsystem.id) {
        block('AIH_REFERENCE_UNRESOLVED', '子系统不能依赖自身：' + subsystem.id, 'system-boundary.subsystems.' + subsystem.id + '.dependencies');
      }
    }
  }
  for (const external of systemBoundary?.externalSystems || []) {
    for (const useCase of external.useCases) requireReference(useCase, boundaryUseCases, 'system-boundary.externalSystems.' + external.id + '.useCases');
  }
  for (const constraint of systemBoundary?.constraints || []) {
    for (const useCase of constraint.useCases) requireReference(useCase, boundaryUseCases, 'system-boundary.constraints.' + constraint.id + '.useCases');
  }

  if (conceptualModel) {
    const normalizedNames = new Map();
    const allKeys = [];
    const allRules = [];
    for (const object of conceptualModel.objects || []) {
      requireReference(object.ownedBy, subsystemIds, 'conceptual-model.objects.' + object.id + '.ownedBy');
      for (const useCase of object.useCases) requireReference(useCase, boundaryUseCases, 'conceptual-model.objects.' + object.id + '.useCases');
      for (const capability of object.capabilities) {
        requireReference(capability, architectureCapabilityIds, 'conceptual-model.objects.' + object.id + '.capabilities');
        const owner = capabilityById.get(capability)?.subsystem.id;
        if (owner && owner !== object.ownedBy) {
          block('AIH_REFERENCE_UNRESOLVED', object.id + ' 引用了其他子系统拥有的 capability：' + capability, 'conceptual-model.objects.' + object.id);
        }
      }
      const fieldNames = duplicateValues(object.fields.map((item) => item.name), 'conceptual-model.objects.' + object.id + '.fields');
      allKeys.push(...object.keys);
      allRules.push(...object.constraints);
      duplicateIds(object.states, 'conceptual-model.objects.' + object.id + '.states');
      for (const key of object.keys) {
        for (const field of key.fields) requireReference(field, fieldNames, 'conceptual-model.objects.' + object.id + '.keys.' + key.id);
      }
      for (const term of [object.name, ...object.aliases]) {
        const normalized = term.trim().toLocaleLowerCase('zh-CN');
        const owner = normalizedNames.get(normalized);
        if (owner && owner !== object.id) {
          block('AIH_REFERENCE_UNRESOLVED', '对象名称或别名未归一：' + term + ' 同时属于 ' + owner + ' 与 ' + object.id, 'conceptual-model.objects');
        } else if (owner === object.id) {
          block('AIH_REFERENCE_UNRESOLVED', '对象规范名称与别名重复：' + term, 'conceptual-model.objects.' + object.id + '.aliases');
        } else {
          normalizedNames.set(normalized, object.id);
        }
      }
    }
    duplicateIds(allKeys, 'conceptual-model.objects.keys');
    duplicateIds(allRules, 'conceptual-model.objects.constraints');

    const generalizations = [];
    for (const relationship of conceptualModel.relationships || []) {
      requireReference(relationship.from, objectIds, 'conceptual-model.relationships.' + relationship.id + '.from');
      requireReference(relationship.to, objectIds, 'conceptual-model.relationships.' + relationship.id + '.to');
      if (relationship.from === relationship.to) {
        block('AIH_REFERENCE_UNRESOLVED', '对象关系不能自引用：' + relationship.id, 'conceptual-model.relationships.' + relationship.id);
      }
      if (relationship.type === 'generalization') generalizations.push([relationship.from, relationship.to]);
    }
    if (hasDirectedCycle(generalizations)) {
      block('AIH_REFERENCE_UNRESOLVED', '对象泛化继承关系存在循环。', 'conceptual-model.relationships');
    }

    function validateEndpoint(endpoint, location) {
      if (endpoint.type === 'none') {
        if (endpoint.ref !== null) block('AIH_REFERENCE_UNRESOLVED', 'none endpoint 的 ref 必须为 null。', location);
        return;
      }
      if (!endpoint.ref) {
        block('AIH_REFERENCE_UNRESOLVED', '非 none endpoint 必须提供 ref。', location);
        return;
      }
      const known = endpoint.type === 'actor'
        ? actorIds
        : endpoint.type === 'subsystem'
          ? subsystemIds
          : externalSystemIds;
      requireReference(endpoint.ref, known, location + '.ref');
    }

    for (const flow of conceptualModel.objectFlows || []) {
      requireReference(flow.object, objectIds, 'conceptual-model.objectFlows.' + flow.id + '.object');
      requireReference(flow.useCase, boundaryUseCases, 'conceptual-model.objectFlows.' + flow.id + '.useCase');
      requireReference(flow.capability, architectureCapabilityIds, 'conceptual-model.objectFlows.' + flow.id + '.capability');
      requireReference(flow.subsystem, subsystemIds, 'conceptual-model.objectFlows.' + flow.id + '.subsystem');
      const capabilityOwner = capabilityById.get(flow.capability);
      if (capabilityOwner && capabilityOwner.subsystem.id !== flow.subsystem) {
        block('AIH_REFERENCE_UNRESOLVED', flow.id + ' 的 capability 不属于声明的 subsystem。', 'conceptual-model.objectFlows.' + flow.id);
      }
      if (capabilityOwner && !capabilityOwner.capability.useCases.includes(flow.useCase)) {
        block('AIH_REFERENCE_UNRESOLVED', flow.id + ' 的 UC 不属于声明的 capability。', 'conceptual-model.objectFlows.' + flow.id);
      }
      const object = objectById.get(flow.object);
      if (object) {
        if (!object.useCases.includes(flow.useCase) || !object.capabilities.includes(flow.capability)) {
          block('AIH_REFERENCE_UNRESOLVED', flow.id + ' 与对象声明的 UC/capability 不一致。', 'conceptual-model.objectFlows.' + flow.id);
        }
        const fields = new Set(object.fields.map((item) => item.name));
        for (const field of [...flow.inputFields, ...flow.outputFields]) requireReference(field, fields, 'conceptual-model.objectFlows.' + flow.id + '.fields');
        const states = new Set(object.states.map((item) => item.id));
        if (flow.fromState) requireReference(flow.fromState, states, 'conceptual-model.objectFlows.' + flow.id + '.fromState');
        if (flow.toState) requireReference(flow.toState, states, 'conceptual-model.objectFlows.' + flow.id + '.toState');
      }
      validateEndpoint(flow.source, 'conceptual-model.objectFlows.' + flow.id + '.source');
      validateEndpoint(flow.target, 'conceptual-model.objectFlows.' + flow.id + '.target');
    }
  }

  if (technicalValidation) {
    const areaRoot = stage?.areas?.['technical-validation']?.root;
    const technicalArea = joinRepositoryPath(stage.root, areaRoot);
    const runnerPath = joinRepositoryPath(technicalArea, 'src/verify.mjs');
    let runnerAvailable = false;
    try {
      const areaPackage = JSON.parse(await readFile(repositoryFile(root, joinRepositoryPath(technicalArea, 'package.json')), 'utf8'));
      if (areaPackage.scripts?.verify !== 'node src/verify.mjs') {
        block('AIH_TECHNICAL_VALIDATION_FAILED', 'technical-validation area 必须声明 verify="node src/verify.mjs"。', joinRepositoryPath(technicalArea, 'package.json'));
      }
      await access(repositoryFile(root, runnerPath));
      runnerAvailable = true;
    } catch (error) {
      block('AIH_TECHNICAL_VALIDATION_FAILED', '技术验证 runner 不完整：' + error.message, technicalArea);
    }

    for (const decision of technicalValidation.decisions || []) {
      requireReference(decision.subsystem, subsystemIds, 'technical-validation.decisions.' + decision.id + '.subsystem');
      const decisionUseCases = new Set();
      for (const capability of decision.capabilities) {
        requireReference(capability, architectureCapabilityIds, 'technical-validation.decisions.' + decision.id + '.capabilities');
        const owner = capabilityById.get(capability);
        if (owner && owner.subsystem.id !== decision.subsystem) {
          block('AIH_REFERENCE_UNRESOLVED', decision.id + ' 引用了其他子系统的 capability：' + capability, 'technical-validation.decisions.' + decision.id);
        }
        for (const useCase of owner?.capability.useCases || []) decisionUseCases.add(useCase);
      }
      for (const useCase of decision.useCases) requireReference(useCase, decisionUseCases, 'technical-validation.decisions.' + decision.id + '.useCases');
      for (const external of decision.externalSystems) requireReference(external, externalSystemIds, 'technical-validation.decisions.' + decision.id + '.externalSystems');
      const localCandidateIds = new Set(decision.candidates.map((item) => item.id));
      if (decision.selectedCandidate) requireReference(decision.selectedCandidate, localCandidateIds, 'technical-validation.decisions.' + decision.id + '.selectedCandidate');
    }

    for (const experiment of technicalValidation.experiments || []) {
      requireReference(experiment.decision, decisionIds, 'technical-validation.experiments.' + experiment.id + '.decision');
      requireReference(experiment.candidate, candidateIds, 'technical-validation.experiments.' + experiment.id + '.candidate');
      const decision = decisionById.get(experiment.decision);
      if (decision && !decision.candidates.some((item) => item.id === experiment.candidate)) {
        block('AIH_REFERENCE_UNRESOLVED', experiment.id + ' 的 candidate 不属于对应 decision。', 'technical-validation.experiments.' + experiment.id);
      }
      const expectedCommand = 'npm run verify -- --case ' + experiment.id;
      if (experiment.command !== expectedCommand) {
        block('AIH_REFERENCE_UNRESOLVED', '实验命令与 id 不一致：' + expectedCommand, 'technical-validation.experiments.' + experiment.id + '.command');
      }
      const expectedSource = 'cases/' + experiment.id + '.case.mjs';
      if (experiment.source !== expectedSource) {
        block('AIH_REFERENCE_UNRESOLVED', '实验 source 必须使用固定路径：' + expectedSource, 'technical-validation.experiments.' + experiment.id + '.source');
      }
      const source = joinRepositoryPath(stage.root, areaRoot, experiment.source);
      try {
        await access(repositoryFile(root, source));
        const content = await readFile(repositoryFile(root, source), 'utf8');
        if (/(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/.test(content)) {
          block('AIH_TECHNICAL_VALIDATION_FAILED', '验证代码疑似包含明文凭据。', source);
        }
      } catch {
        block('AIH_REFERENCE_UNRESOLVED', '技术验证代码不存在：' + experiment.source, source);
      }
      if (runnerAvailable) {
        const described = spawnSync(process.execPath, [repositoryFile(root, runnerPath), '--case', experiment.id, '--describe'], {
          cwd: repositoryFile(root, technicalArea),
          encoding: 'utf8',
          env: { ...process.env },
          timeout: 5_000,
          windowsHide: true,
        });
        const description = parseValidatorOutput(described);
        if (described.status !== 0 || description?.status !== 'PASS' || description?.experiment !== experiment.id || description?.source !== experiment.source) {
          block('AIH_TECHNICAL_VALIDATION_FAILED', 'runner 无法识别实验代码或 source 不一致：' + experiment.id, source);
        }
        if (!sameSet(new Set(description?.requiredEnvironment || []), new Set(experiment.requiredEnvironment))) {
          block('AIH_TECHNICAL_VALIDATION_FAILED', '真实代码声明的环境变量与技术验证模型不一致：' + experiment.id, 'technical-validation.experiments.' + experiment.id + '.requiredEnvironment');
        }
      }
      const evidenceText = (experiment.result.evidence || []).join('\n');
      if (/(?:sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{20,})/.test(evidenceText)) {
        block('AIH_TECHNICAL_VALIDATION_FAILED', '实验 evidence 疑似包含明文凭据。', 'technical-validation.experiments.' + experiment.id + '.result.evidence');
      }
    }
  }

  if (architecturePackage) {
    const bound = new Set(Object.keys(stage.artifacts));
    const declared = new Set(['architecture-package', ...architecturePackage.artifactOrder]);
    if (!sameSet(bound, declared)) {
      block('AIH_PROJECT_BINDING_INVALID', 'Architecture Package artifactOrder 与项目绑定不一致。', 'architecture-package.artifactOrder');
    }
  }

  if (readiness) {
    const selectedArtifacts = strict ? new Set(models.keys()) : new Set([step]);
    const selected = (artifactId) => selectedArtifacts.has(artifactId);
    for (const [artifactId, model] of models) {
      if (!selected(artifactId)) continue;
      if (model.metadata.status !== 'ready') block('AIH_ARTIFACT_INCOMPLETE', artifactId + ' status 不是 ready。', artifactId + '.metadata.status');
      if (model.gaps.length > 0) block('AIH_ARTIFACT_INCOMPLETE', artifactId + ' 仍存在显式 gaps。', artifactId + '.gaps');
      for (const gate of model.gates) {
        if (!gate.checked) block('AIH_ARTIFACT_INCOMPLETE', '门禁未完成：' + gate.label, artifactId + '.gates.' + gate.id);
      }
    }

    if (selected('architecture-package')) {
      for (const [field, value] of Object.entries(architecturePackage?.overview || {})) {
        if (field !== 'constraints' && !value) block('AIH_ARTIFACT_INCOMPLETE', 'Architecture Overview 未定义：' + field, 'architecture-package.overview.' + field);
      }
    }
    if (selected('system-boundary')) {
      if (!systemBoundary?.system?.name || !systemBoundary?.system?.mission) {
        block('AIH_ARTIFACT_INCOMPLETE', '系统名称与使命必须完整。', 'system-boundary.system');
      }
      if (!systemBoundary.system.includedResponsibilities.length || !systemBoundary.system.excludedResponsibilities.length) {
        block('AIH_ARTIFACT_INCOMPLETE', '系统级做什么与不做什么必须显式定义。', 'system-boundary.system');
      }
      const responsibilityOverlap = systemBoundary.system.includedResponsibilities.filter((item) => systemBoundary.system.excludedResponsibilities.includes(item));
      if (responsibilityOverlap.length) {
        block('AIH_REFERENCE_UNRESOLVED', '系统负责与不负责范围冲突：' + responsibilityOverlap.join(', '), 'system-boundary.system');
      }
      if (!sameSet(boundaryUseCases, useCaseIds)) block('AIH_REFERENCE_UNRESOLVED', '系统边界必须精确覆盖当前 Architecture 输入的全部 Use Case。', 'system-boundary.useCases');
      const expectedActors = capabilities
        ? new Set(capabilities.useCases.map((item) => item.actor))
        : new Set(actorsByUseCase.values());
      if (!sameSet(interactionActors, expectedActors)) block('AIH_REFERENCE_UNRESOLVED', 'Actor 交互必须覆盖所有具有 Use Case 的 Actor。', 'system-boundary.actorInteractions');
      if (!sameSet(unionOf(systemBoundary.actorInteractions, 'useCases'), useCaseIds)) block('AIH_REFERENCE_UNRESOLVED', 'Actor 交互必须精确覆盖全部 Use Case。', 'system-boundary.actorInteractions');
      if (!sameSet(unionOf(systemBoundary.subsystems, 'useCases'), useCaseIds)) block('AIH_REFERENCE_UNRESOLVED', '子系统必须精确覆盖全部 Use Case。', 'system-boundary.subsystems');
      if (!sameSet(unionOf(architectureCapabilities, 'useCases'), useCaseIds)) block('AIH_REFERENCE_UNRESOLVED', '子系统能力必须精确覆盖全部 Use Case。', 'system-boundary.subsystems.capabilities');
      for (const subsystem of systemBoundary.subsystems) {
        const subsystemActors = capabilities
          ? new Set(capabilities.useCases.filter((item) => subsystem.useCases.includes(item.id)).map((item) => item.actor))
          : new Set(subsystem.useCases.map((useCase) => actorsByUseCase.get(useCase)).filter(Boolean));
        if (!sameSet(new Set(subsystem.actors), subsystemActors)) block('AIH_REFERENCE_UNRESOLVED', '子系统 Actor 与其 UC 不一致：' + subsystem.id, 'system-boundary.subsystems.' + subsystem.id + '.actors');
        if (!subsystem.includedResponsibilities.length || !subsystem.excludedResponsibilities.length) block('AIH_ARTIFACT_INCOMPLETE', '子系统必须明确做什么与不做什么：' + subsystem.id, 'system-boundary.subsystems.' + subsystem.id);
      }
      for (const capability of architectureCapabilities) {
        if (capability.inputs.length + capability.outputs.length === 0) block('AIH_ARTIFACT_INCOMPLETE', '能力必须定义语义输入或输出：' + capability.id, 'system-boundary.capabilities.' + capability.id);
        if (capability.technicalValidationRequired && (!capability.inputs.length || !capability.outputs.length)) block('AIH_ARTIFACT_INCOMPLETE', '需要真实代码技术验证的关键能力必须同时定义输入和输出：' + capability.id, 'system-boundary.capabilities.' + capability.id);
      }
      for (const constraint of systemBoundary.constraints) {
        if (constraint.status === 'gap') block('AIH_ARTIFACT_INCOMPLETE', '架构约束仍是 gap：' + constraint.id, 'system-boundary.constraints.' + constraint.id);
      }
    }

    if (selected('conceptual-model')) {
      if (!conceptualModel.objects.length) block('AIH_ARTIFACT_INCOMPLETE', '严格门禁要求至少一个关键对象实体。', 'conceptual-model.objects');
      if (!sameSet(unionOf(conceptualModel.objects, 'useCases'), boundaryUseCases)) block('AIH_REFERENCE_UNRESOLVED', '对象模型必须精确覆盖系统边界 Use Case。', 'conceptual-model.objects');
      if (!sameSet(unionOf(conceptualModel.objects, 'capabilities'), architectureCapabilityIds)) block('AIH_REFERENCE_UNRESOLVED', '对象模型必须覆盖全部子系统能力。', 'conceptual-model.objects');
      if (!sameSet(new Set(conceptualModel.objectFlows.map((item) => item.useCase)), boundaryUseCases)) block('AIH_REFERENCE_UNRESOLVED', '对象数据流必须精确覆盖全部 Use Case。', 'conceptual-model.objectFlows');
      if (!sameSet(new Set(conceptualModel.objectFlows.map((item) => item.object)), objectIds)) block('AIH_REFERENCE_UNRESOLVED', '每个关键对象都必须出现在对象数据流中。', 'conceptual-model.objectFlows');
      if (!sameSet(new Set(conceptualModel.objectFlows.map((item) => item.capability)), architectureCapabilityIds)) block('AIH_REFERENCE_UNRESOLVED', '对象数据流必须覆盖全部子系统能力。', 'conceptual-model.objectFlows');
      for (const object of conceptualModel.objects) {
        if (object.kind === 'entity' && !object.keys.some((key) => ['primary', 'business'].includes(key.type))) block('AIH_ARTIFACT_INCOMPLETE', 'entity 必须定义 primary 或 business key：' + object.id, 'conceptual-model.objects.' + object.id + '.keys');
        if (object.kind === 'entity') {
          const initialStates = object.states.filter((state) => state.initial);
          if (!object.states.length || initialStates.length !== 1) block('AIH_ARTIFACT_INCOMPLETE', 'entity 必须定义且仅定义一个初始状态：' + object.id, 'conceptual-model.objects.' + object.id + '.states');
        }
      }
      for (const flow of conceptualModel.objectFlows) {
        if (flow.operation === 'create' && (flow.fromState !== null || flow.toState === null)) block('AIH_REFERENCE_UNRESOLVED', 'create flow 必须从空状态进入对象状态：' + flow.id, 'conceptual-model.objectFlows.' + flow.id);
        if (flow.operation === 'delete' && (flow.fromState === null || flow.toState !== null)) block('AIH_REFERENCE_UNRESOLVED', 'delete flow 必须从对象状态进入空状态：' + flow.id, 'conceptual-model.objectFlows.' + flow.id);
        if (flow.operation === 'transition' && (!flow.fromState || !flow.toState || flow.fromState === flow.toState)) block('AIH_REFERENCE_UNRESOLVED', 'transition flow 必须声明不同的前后状态：' + flow.id, 'conceptual-model.objectFlows.' + flow.id);
      }
    }

    if (selected('technical-validation')) {
      const requiredCapabilities = new Set(architectureCapabilities.filter((item) => item.technicalValidationRequired).map((item) => item.id));
      const selectedCapabilities = unionOf(technicalValidation.decisions, 'capabilities');
      if (!sameSet(requiredCapabilities, selectedCapabilities)) block('AIH_REFERENCE_UNRESOLVED', '技术决策必须精确覆盖所有标记为 technicalValidationRequired 的关键能力，且不得扩展到其他架构能力。', 'technical-validation.decisions');
      for (const decision of technicalValidation.decisions) {
        if (decision.status !== 'selected' || !decision.selectedCandidate || !decision.rationale) block('AIH_ARTIFACT_INCOMPLETE', '技术决策尚未完成最终选择：' + decision.id, 'technical-validation.decisions.' + decision.id);
        const passed = technicalValidation.experiments.some((experiment) =>
          experiment.decision === decision.id
          && experiment.candidate === decision.selectedCandidate
          && experiment.result.status === 'passed',
        );
        if (!passed) block('AIH_TECHNICAL_VALIDATION_FAILED', '最终选型缺少 passed 代码实验：' + decision.id, 'technical-validation.decisions.' + decision.id);
      }
      for (const experiment of technicalValidation.experiments) {
        if (!['passed', 'failed'].includes(experiment.result.status)) block('AIH_TECHNICAL_VALIDATION_FAILED', '实验尚未形成终态结果：' + experiment.id, 'technical-validation.experiments.' + experiment.id + '.result');
        if (!experiment.result.executedAt || !experiment.result.summary || !experiment.result.evidence.length) block('AIH_ARTIFACT_INCOMPLETE', '实验缺少执行时间、摘要或证据：' + experiment.id, 'technical-validation.experiments.' + experiment.id + '.result');
      }
    }

    const serialized = JSON.stringify([...models].filter(([artifactId]) => selected(artifactId)).map(([, model]) => model));
    if (/(?:待填写|(?:^|[^A-Z])NNN(?:[^A-Z]|$)|未定义)/.test(serialized)) block('AIH_ARTIFACT_INCOMPLETE', '权威实例仍含禁止的占位符。', stageId);
  } else if ([...models.values()].some((model) => model.metadata.status === 'draft' || model.gaps.length > 0)) {
    warnings.push('结构有效，但架构实例仍处于 draft 或包含显式 gap；不得声明 ready。');
  }
}

if (project && ['active', 'uninitialized'].includes(stage?.status)) {
  try {
    const selectedOutputs = step
      ? selectedArchitectureArtifacts(step)
      : null;
    for (const drift of await outputDrift(root, project, stageId, selectedOutputs)) {
      block('AIH_GENERATED_DRIFT', 'Markdown 用户产物与内部模型不一致：' + drift.internalModel, drift.output);
    }
  } catch (error) {
    block('AIH_GENERATED_DRIFT', error.message, 'architecture-outputs');
  }
}

const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  mode: step || (strict ? 'strict' : 'structure'),
  state: initializing ? 'initializing' : 'active',
  blockerCount: blockers.length,
  blockers,
  warnings,
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const warning of warnings) console.warn('[WARN] ' + warning);
  if (result.status === 'PASS') console.log('[PASS] 架构 ' + (step || (strict ? '严格' : '结构')) + '校验通过。');
  else for (const item of blockers) console.error('[' + item.code + '] (' + (item.location || 'unknown') + ') ' + item.message);
}

if (result.status !== 'PASS') process.exitCode = 1;
