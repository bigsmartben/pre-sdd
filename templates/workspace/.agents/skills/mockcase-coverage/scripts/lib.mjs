import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  artifactCollectionMembers,
  artifactPaths,
  loadProjectAndManifest,
  readStructured,
  repositoryFile,
  repositoryRootFrom,
} from '../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from '../../product-design/canonical-ui-prototype/scripts/extract.mjs';

const MODEL_VERSION = '1.0.0';

function sha256(value) {
  return 'sha256:' + createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

function values(name) {
  const result = [];
  for (let index = 0; index < process.argv.length; index += 1) if (process.argv[index] === name && process.argv[index + 1]) result.push(process.argv[index + 1]);
  return [...new Set(result)].sort();
}

function value(name) {
  return values(name)[0] ?? null;
}

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function gap(scenario, message) {
  return {
    code: 'AIH_MOCKCASE_UPSTREAM_GAP',
    feedbackClass: 'behavior',
    useCaseId: scenario.useCaseId,
    scenarioId: scenario.id,
    message,
    targetDomain: 'product-design',
    targetArtifact: 'capabilities',
    targetOperation: 'apply-product-artifact',
  };
}

function entryStateIds(model, entry) {
  return model.stateAxes.filter((axis) => axis.componentContractId === entry.componentContractId).flatMap((axis) => {
    const selected = axis.values.find((item) => item.id === entry.values[axis.id]);
    return selected?.stateId ? [selected.stateId] : [];
  });
}

function scopeScenarios(model, capabilities, actor, requested) {
  const routeIds = new Set(requested.routeIds);
  const useCaseIds = new Set(requested.useCaseIds);
  const scenarioIds = new Set(requested.scenarioIds);
  const reviewableUseCases = (capabilities.useCases || []).filter((item) => item.actor === actor && item.uiApplicability?.mode === 'required');
  for (const id of routeIds) if (!model.routes.some((item) => item.id === id)) fail('AIH_SCOPE_UNRESOLVED', '未知 Route Scope：' + id);
  for (const id of useCaseIds) if (!reviewableUseCases.some((item) => item.id === id)) fail('AIH_SCOPE_UNRESOLVED', '未知或不可进行 UI 评审的 Use Case Scope：' + id);
  for (const id of scenarioIds) if (!model.scenarios.some((item) => item.id === id)) fail('AIH_SCOPE_UNRESOLVED', '未知 Scenario Scope：' + id);
  const scenarios = model.scenarios.filter((scenario) => (
    (routeIds.size === 0 || routeIds.has(scenario.routeId))
    && (useCaseIds.size === 0 || useCaseIds.has(scenario.useCaseId))
    && (scenarioIds.size === 0 || scenarioIds.has(scenario.id))
  )).sort((left, right) => left.id.localeCompare(right.id));
  const selectedUseCases = useCaseIds.size > 0
    ? reviewableUseCases.filter((item) => useCaseIds.has(item.id))
    : routeIds.size === 0 && scenarioIds.size === 0 ? reviewableUseCases : [];
  return {
    scenarios,
    scope: {
      routeIds: [...routeIds].sort(),
      useCaseIds: [...useCaseIds].sort(),
      scenarioIds: [...scenarioIds].sort(),
    },
    missingUseCaseIds: selectedUseCases.filter((item) => !model.scenarios.some((scenario) => scenario.useCaseId === item.id)).map((item) => item.id).sort(),
  };
}

function caseAssessment(model, mockCase, scenarioMap, matrixMap, instanceMap) {
  if (mockCase.kind !== 'business') return { valid: true, coveredStateIds: [] };
  const scenario = scenarioMap.get(mockCase.scenarioId);
  const route = model.routes.find((item) => item.id === mockCase.routeId);
  const screen = route && model.screens.find((item) => item.id === route.screenId);
  if (!scenario || scenario.routeId !== mockCase.routeId || !screen || mockCase.effects.length === 0) return { valid: false, coveredStateIds: [] };
  const covered = [];
  const seenTargets = new Map();
  const scenarioStates = new Set(requiredStates(scenario));
  for (const effect of mockCase.effects) {
    const entry = matrixMap.get(effect.expectedStateMatrixEntryId);
    const instance = instanceMap.get(effect.targetInstanceId);
    if (!entry || entry.classification !== 'legal' || !instance || instance.screenId !== screen.id || instance.contract.id !== entry.componentContractId) return { valid: false, coveredStateIds: [] };
    if (seenTargets.has(instance.id) && seenTargets.get(instance.id) !== entry.id) return { valid: false, coveredStateIds: [] };
    seenTargets.set(instance.id, entry.id);
    const stateIds = entryStateIds(model, entry);
    if (!stateIds.some((id) => scenarioStates.has(id))) return { valid: false, coveredStateIds: [] };
    if (effect.activation.kind === 'request' && effect.mockBehaviorIds.length === 0) return { valid: false, coveredStateIds: [] };
    if (effect.mockBehaviorIds.some((id) => {
      const behavior = model.mockBehaviors.find((item) => item.id === id);
      return !behavior || behavior.responseStateIds.some((stateId) => !stateIds.includes(stateId));
    })) return { valid: false, coveredStateIds: [] };
    if (effect.activation.controlId) {
      const control = model.controls.find((item) => item.id === effect.activation.controlId);
      if (!control || control.componentId !== instance.contract.componentId) return { valid: false, coveredStateIds: [] };
    }
    covered.push(...stateIds);
  }
  return { valid: true, coveredStateIds: [...new Set(covered)] };
}

function requiredStates(scenario) {
  return [...new Set([...scenario.expectedStateIds, ...scenario.recoveryStateIds])].sort();
}

function generateCase(model, scenario, defaultsByRoute, uncoveredStateIds) {
  const route = model.routes.find((item) => item.id === scenario.routeId);
  const screen = route && model.screens.find((item) => item.id === route.screenId);
  if (!route || !screen) return { gap: gap(scenario, 'Scenario 没有可解析的 Canonical UI Route 与 Screen。') };
  const contracts = model.componentContracts.filter((contract) => screen.componentIds.includes(contract.componentId));
  const candidates = model.stateMatrix.filter((entry) => entry.classification === 'legal' && contracts.some((contract) => contract.id === entry.componentContractId));
  const remaining = new Set(uncoveredStateIds);
  const effects = [];
  const usedTargets = new Map();
  while (remaining.size > 0) {
    const ranked = candidates.map((entry) => ({ entry, states: entryStateIds(model, entry), score: entryStateIds(model, entry).filter((id) => remaining.has(id)).length }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id));
    const selected = ranked[0];
    if (!selected) return { gap: gap(scenario, `Scenario 结果缺少合法 State Matrix Entry：${[...remaining].join(', ')}`) };
    const contract = contracts.find((item) => item.id === selected.entry.componentContractId);
    const instance = contract?.pageInstances.filter((item) => item.screenId === screen.id).sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!contract || !instance) return { gap: gap(scenario, `Scenario 结果没有当前 Route 的组件实例：${selected.entry.id}`) };
    const previous = usedTargets.get(instance.id);
    if (previous && previous !== selected.entry.id) return { gap: gap(scenario, `Scenario 要求同一组件实例进入多个互斥结果：${instance.id}`) };
    usedTargets.set(instance.id, selected.entry.id);

    const matchedStates = selected.states.filter((id) => remaining.has(id));
    const event = scenario.eventIds.map((id) => model.events.find((item) => item.id === id)).filter(Boolean).find((item) => {
      const action = model.actions.find((candidate) => candidate.eventId === item.id);
      const control = model.controls.find((candidate) => candidate.id === item.controlId);
      return control?.componentId === contract.componentId && action?.resultingStateIds.some((id) => matchedStates.includes(id));
    });
    const behavior = model.mockBehaviors.filter((item) => (
      item.responseStateIds.some((id) => matchedStates.includes(id))
      && item.responseStateIds.every((id) => selected.states.includes(id))
    )).sort((left, right) => left.id.localeCompare(right.id))[0];
    if (!event && !behavior) return { gap: gap(scenario, `Scenario 结果没有真实 Control/Event 或 Mock Behavior 激活链路：${selected.entry.id}`) };
    effects.push({
      targetInstanceId: instance.id,
      mockBehaviorIds: behavior ? [behavior.id] : [],
      activation: event
        ? { kind: behavior ? 'request' : 'control-event', controlId: event.controlId }
        : { kind: 'request' },
      expectedStateMatrixEntryId: selected.entry.id,
    });
    for (const id of selected.states) remaining.delete(id);
  }
  const isDefault = !defaultsByRoute.has(route.id);
  if (isDefault) defaultsByRoute.add(route.id);
  const baseId = `MOCK-CASE-${scenario.id}`;
  let id = baseId;
  let suffix = 2;
  const existingIds = new Set(model.mockCases.map((item) => item.id));
  while (existingIds.has(id)) {
    id = `${baseId}-COVERAGE-${suffix}`;
    suffix += 1;
  }
  return {
    mockCase: {
      id,
      kind: 'business',
      label: `${scenario.useCaseId} · ${scenario.id}`,
      routeId: scenario.routeId,
      scenarioId: scenario.id,
      effects,
      isDefault,
    },
  };
}

async function inputs() {
  const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
  const { project, manifest } = await loadProjectAndManifest(root);
  if (project.kind !== 'PSPProject') fail('AIH_PROJECT_BINDING_INVALID', 'mockcase-coverage 只能在生成工作区 PSPProject 中运行。');
  const actor = value('--actor');
  if (!actor || !/^ACTOR-[0-9]{3}$/.test(actor)) fail('AIH_SCOPE_UNRESOLVED', '必须提供 --actor ACTOR-NNN。');
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  if (!paths || paths.authorityKind !== 'area-set') fail('AIH_PROJECT_BINDING_INVALID', '项目没有绑定 Canonical UI Prototype area-set。');
  const members = await artifactCollectionMembers(root, paths);
  const member = members.find((item) => item.actor === actor);
  if (!member) fail('AIH_SCOPE_UNRESOLVED', 'Canonical UI Actor 不存在：' + actor);
  const model = await extractCanonicalUi(root, member.authorityPath);
  const targetPath = repositoryFile(root, member.authorityPath);
  const targetSource = await readFile(targetPath, 'utf8');
  const manifestSource = await readFile(repositoryFile(root, '.psp/harness/harness.manifest.json'), 'utf8');
  const capabilitiesPaths = artifactPaths(project, 'capabilities', 'product-design');
  if (!capabilitiesPaths) fail('AIH_PROJECT_BINDING_INVALID', '项目没有绑定 capabilities。');
  let capabilities;
  let capabilitiesSource;
  try {
    capabilitiesSource = await readFile(repositoryFile(root, capabilitiesPaths.authorityPath), 'utf8');
    capabilities = await readStructured(root, capabilitiesPaths.authorityPath, 'yaml');
  } catch {
    fail('AIH_MOCKCASE_UPSTREAM_GAP', 'Use Cases 权威模型不存在或不可读。');
  }
  if (capabilities.metadata?.status !== 'ready' || capabilities.gaps?.length > 0 || capabilities.gates?.some((item) => item.checked !== true)) {
    fail('AIH_MOCKCASE_UPSTREAM_GAP', 'Use Cases 权威模型尚未达到 ready，拒绝生成 MockCase 候选。');
  }
  const targetModelHash = sha256(targetSource);
  const inputHash = sha256(stableJson({
    modelVersion: MODEL_VERSION,
    manifestHash: sha256(manifestSource),
    capabilitiesHash: sha256(capabilitiesSource),
    targetModelHash,
  }));
  return { root, project, manifest, actor, model, targetPath, targetSource, targetModelHash, inputHash, capabilities };
}

export async function coverageCandidate(requestedScope = null) {
  const input = await inputs();
  const requested = requestedScope ?? { routeIds: values('--route'), useCaseIds: values('--use-case'), scenarioIds: values('--scenario') };
  const { scenarios, scope, missingUseCaseIds } = scopeScenarios(input.model, input.capabilities, input.actor, requested);
  const scenarioMap = new Map(input.model.scenarios.map((item) => [item.id, item]));
  const matrixMap = new Map(input.model.stateMatrix.map((item) => [item.id, item]));
  const instanceMap = new Map(input.model.componentContracts.flatMap((contract) => contract.pageInstances.map((item) => [item.id, { ...item, contract }])));
  const assessments = new Map(input.model.mockCases.map((item) => [item.id, caseAssessment(input.model, item, scenarioMap, matrixMap, instanceMap)]));
  const inScopeScenarioIds = new Set(scenarios.map((item) => item.id));
  const existingCases = input.model.mockCases.filter((item) => item.kind === 'business' && inScopeScenarioIds.has(item.scenarioId) && assessments.get(item.id)?.valid).sort((left, right) => left.id.localeCompare(right.id));
  const staleCaseIds = input.model.mockCases.filter((item) => {
    if (item.kind !== 'business' || assessments.get(item.id)?.valid) return false;
    const scenario = scenarioMap.get(item.scenarioId);
    return (requested.routeIds.length === 0 || requested.routeIds.includes(item.routeId))
      && (requested.useCaseIds.length === 0 || (scenario && requested.useCaseIds.includes(scenario.useCaseId)))
      && (requested.scenarioIds.length === 0 || requested.scenarioIds.includes(item.scenarioId));
  }).map((item) => item.id).sort();
  const coveredBefore = new Set(scenarios.filter((scenario) => {
    const needed = requiredStates(scenario);
    const covered = new Set(existingCases.filter((item) => item.scenarioId === scenario.id).flatMap((item) => assessments.get(item.id)?.coveredStateIds ?? []));
    return needed.every((id) => covered.has(id));
  }).map((item) => item.id));
  const defaultsByRoute = new Set(input.model.mockCases.filter((item) => item.isDefault && !staleCaseIds.includes(item.id)).map((item) => item.routeId));
  const defaultTargetsByRoute = new Map(input.model.routes.map((route) => [
    route.id,
    new Set(input.model.mockCases.filter((item) => item.routeId === route.id && item.isDefault && !staleCaseIds.includes(item.id)).flatMap((item) => item.effects.map((effect) => effect.targetInstanceId))),
  ]));
  const generatedCases = [];
  const gaps = missingUseCaseIds.map((useCaseId) => gap({ useCaseId }, `正式 UI Use Case 缺少可评审 Scenario：${useCaseId}`));
  const invalidScenarioIds = new Set();
  for (const scenario of scenarios) {
    const useCase = (input.capabilities.useCases || []).find((item) => item.id === scenario.useCaseId && item.actor === input.actor && item.uiApplicability?.mode === 'required');
    if (!useCase) {
      invalidScenarioIds.add(scenario.id);
      gaps.push(gap(scenario, `Scenario 未绑定当前 Actor 的正式 UI Use Case：${scenario.id}`));
    }
  }
  for (const scenario of scenarios.filter((item) => !coveredBefore.has(item.id) && !invalidScenarioIds.has(item.id))) {
    const coveredStates = new Set(existingCases.filter((item) => item.scenarioId === scenario.id).flatMap((item) => assessments.get(item.id)?.coveredStateIds ?? []));
    const generated = generateCase(input.model, scenario, defaultsByRoute, requiredStates(scenario).filter((id) => !coveredStates.has(id)));
    if (generated.gap) gaps.push(generated.gap);
    else {
      const defaultTargets = defaultTargetsByRoute.get(scenario.routeId);
      const missingResetTarget = generated.mockCase.isDefault ? null : generated.mockCase.effects.find((effect) => !defaultTargets?.has(effect.targetInstanceId));
      if (missingResetTarget) gaps.push(gap(scenario, `目标组件实例缺少默认 Case Effect，无法安全撤销：${missingResetTarget.targetInstanceId}`));
      else {
        generatedCases.push(generated.mockCase);
        if (generated.mockCase.isDefault) defaultTargetsByRoute.set(scenario.routeId, new Set(generated.mockCase.effects.map((effect) => effect.targetInstanceId)));
      }
    }
  }
  generatedCases.sort((left, right) => left.id.localeCompare(right.id));
  gaps.sort((left, right) => (left.scenarioId ?? '').localeCompare(right.scenarioId ?? ''));
  const coverageBefore = { requiredScenarios: scenarios.length, coveredScenarios: coveredBefore.size };
  const coverageAfter = { requiredScenarios: scenarios.length, coveredScenarios: coveredBefore.size + generatedCases.length };
  const base = {
    schemaVersion: MODEL_VERSION,
    status: gaps.length === 0 ? 'PASS' : 'BLOCKED',
    actor: input.actor,
    scope,
    inputHash: input.inputHash,
    targetModelHash: input.targetModelHash,
    existingCaseIds: existingCases.map((item) => item.id),
    generatedCases,
    staleCaseIds,
    coverageBefore,
    coverageAfter,
    gaps,
  };
  return { ...base, candidateHash: sha256(stableJson(base)) };
}

export function coverageReport(candidate) {
  return {
    schemaVersion: candidate.schemaVersion,
    status: candidate.status,
    actor: candidate.actor,
    scope: candidate.scope,
    inputHash: candidate.inputHash,
    targetModelHash: candidate.targetModelHash,
    existingCaseIds: candidate.existingCaseIds,
    generatableScenarioIds: candidate.generatedCases.map((item) => item.scenarioId),
    staleCaseIds: candidate.staleCaseIds,
    coverageBefore: candidate.coverageBefore,
    coverageAfter: candidate.coverageAfter,
    gaps: candidate.gaps,
  };
}

export function failure(error) {
  const blocker = { code: error.code || 'AIH_MOCKCASE_COVERAGE_FAILED', message: error.message };
  if (blocker.code === 'AIH_MOCKCASE_UPSTREAM_GAP') {
    const diagnostic = {
      ...blocker,
      feedbackClass: 'behavior',
      targetDomain: 'product-design',
      targetArtifact: 'capabilities',
      targetOperation: 'apply-product-artifact',
    };
    return { status: 'BLOCKED', blockers: [diagnostic], gaps: [diagnostic] };
  }
  return { status: 'BLOCKED', blockers: [blocker] };
}
