import picomatch from 'picomatch';
import {
  artifactPaths,
  joinRepositoryPath,
  normalizeRepositoryPath,
} from './repository.mjs';

function catalogBlocker(catalog, code, location, message) {
  const declared = catalog.get(code);
  return {
    code,
    severity: declared?.severity || 'blocker',
    owner: declared?.owner || 'repository-harness',
    meaning: declared?.meaning || message,
    ...(location ? { location } : {}),
    ...(message ? { message } : {}),
  };
}

export function selectorPatterns(selector, project) {
  if (selector.type === 'static') return selector.paths;
  const stage = project.stages?.[selector.stage];
  if (!stage) return [];
  if (selector.type === 'stage') return [stage.root, stage.root + '/**'];
  const area = stage.areas?.[selector.area];
  if (!area) return [];
  const root = joinRepositoryPath(stage.root, area.root);
  return [root, root + '/**'];
}

function outputModels(project, manifest) {
  const pairs = [];
  for (const artifact of manifest.artifactRegistry || []) {
    const paths = artifactPaths(project, artifact.id, artifact.stage);
    if (!paths) continue;
    for (const output of paths.outputPaths) {
      pairs.push({ output, internalModel: paths.internalModel });
    }
  }
  return pairs;
}

export function resolveHarness(manifest, project, inputPaths, intent, root) {
  const blockers = [];
  const catalog = new Map((manifest.blockers || []).map((item) => [item.code, item]));
  const profiles = new Map((manifest.validationProfiles || []).map((item) => [item.id, item]));
  const scopes = new Map((manifest.scopes || []).map((item) => [item.id, item]));
  const normalizedInputs = [];

  if (!['change', 'readiness'].includes(intent)) {
    blockers.push(catalogBlocker(catalog, 'AIH_PATH_INVALID', 'intent', '不支持的 intent：' + intent));
  }
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    blockers.push(catalogBlocker(catalog, 'AIH_SCOPE_UNRESOLVED', 'paths', '至少需要一个 --path。'));
  }

  for (const input of inputPaths || []) {
    const normalized = normalizeRepositoryPath(input, root);
    if (normalized.error) {
      blockers.push(catalogBlocker(catalog, normalized.error, input, normalized.message));
    } else {
      normalizedInputs.push(normalized.path);
    }
  }

  const inputSet = new Set(normalizedInputs);
  for (const pair of outputModels(project, manifest)) {
    if (inputSet.has(pair.output) && !inputSet.has(pair.internalModel)) {
      blockers.push(catalogBlocker(
        catalog,
        'AIH_GENERATED_DRIFT',
        pair.output,
        '生成 output 不能单独修改；请修改 Harness 内部模型：' + pair.internalModel,
      ));
    }
  }

  const selectedById = new Map();
  for (const path of normalizedInputs) {
    const matches = [];
    for (const scope of manifest.scopes || []) {
      const patterns = selectorPatterns(scope.selector, project);
      if (patterns.some((pattern) => picomatch(pattern, { dot: true })(path))) matches.push(scope);
    }
    if (matches.length === 0) {
      blockers.push(catalogBlocker(catalog, 'AIH_SCOPE_UNRESOLVED', path, '路径未命中任何 Scope：' + path));
      continue;
    }
    const selectedByGroup = new Map();
    for (const match of matches) {
      const current = selectedByGroup.get(match.selectionGroup);
      if (!current || match.priority > current.priority) selectedByGroup.set(match.selectionGroup, match);
    }
    for (const match of selectedByGroup.values()) selectedById.set(match.id, match);
  }

  const selected = [...selectedById.values()].sort((left, right) =>
    right.priority - left.priority || left.id.localeCompare(right.id),
  );
  for (const scope of selected) {
    if (scope.status === 'unsupported') {
      blockers.push(catalogBlocker(catalog, scope.blockerCode, scope.id));
      continue;
    }
    if (
      intent === 'readiness'
      && scope.selector.type !== 'static'
      && project.stages?.[scope.selector.stage]?.status === 'uninitialized'
    ) {
      blockers.push(catalogBlocker(
        catalog,
        'AIH_STAGE_UNINITIALIZED',
        scope.selector.stage,
        '阶段尚未初始化，不能执行 readiness：' + scope.selector.stage,
      ));
    }
  }

  const dependencyProfiles = [];
  const visitedDependencies = new Set();
  function scopeStage(scope) {
    return scope?.selector?.type === 'static' ? null : scope?.selector?.stage;
  }
  function visitDependencies(scope) {
    const downstreamStage = scopeStage(scope);
    for (const dependencyId of scope.dependencies || []) {
      const edge = scope.id + '->' + dependencyId;
      if (visitedDependencies.has(edge)) continue;
      visitedDependencies.add(edge);
      const dependency = scopes.get(dependencyId);
      if (!dependency) continue;
      const dependencyStage = scopeStage(dependency);
      const crossStage = dependencyStage && dependencyStage !== downstreamStage;
      if (dependency.status !== 'active') {
        blockers.push(catalogBlocker(
          catalog,
          'AIH_UPSTREAM_NOT_READY',
          dependencyId,
          '依赖 Scope 当前不可消费：' + dependencyId,
        ));
      } else if (crossStage) {
        if (project.stages?.[dependencyStage]?.status !== 'active') {
          blockers.push(catalogBlocker(
            catalog,
            'AIH_UPSTREAM_NOT_READY',
            dependencyStage,
            '下游变更要求依赖阶段先达到 active：' + dependencyStage,
          ));
        }
        if (!dependencyProfiles.includes(dependency.readinessProfile)) {
          dependencyProfiles.push(dependency.readinessProfile);
        }
      }
      visitDependencies(dependency);
    }
  }
  for (const scope of selected) visitDependencies(scope);

  const selectedProfiles = [...dependencyProfiles];
  for (const scope of selected) {
    if (scope.status !== 'active') continue;
    const stageState = scope.selector.type === 'static'
      ? null
      : project.stages?.[scope.selector.stage]?.status;
    const profileId = intent === 'readiness'
      ? scope.readinessProfile
      : stageState === 'uninitialized'
        ? (scope.uninitializedProfile || scope.defaultProfile)
        : scope.defaultProfile;
    if (!selectedProfiles.includes(profileId)) selectedProfiles.push(profileId);
  }

  const requestedCommands = new Set();
  for (const profileId of selectedProfiles) {
    for (const commandId of profiles.get(profileId)?.commands || []) requestedCommands.add(commandId);
  }
  const orderedCommands = (manifest.commands || []).filter((command) => requestedCommands.has(command.id));

  return {
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    scopes: selected.map((scope) => scope.id),
    profiles: selectedProfiles,
    commandIds: orderedCommands.map((command) => command.id),
    commands: orderedCommands.map((command) => command.run),
    blockers,
  };
}
