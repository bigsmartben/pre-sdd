import picomatch from 'picomatch';
import { createHash } from 'node:crypto';
import {
  artifactPaths,
  joinRepositoryPath,
  normalizeRepositoryPath,
} from './repository.mjs';
import { dependencyIds, handoffConsumerIds } from './project-dag.mjs';
import { stageIsReadable } from './stage-state.mjs';

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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function areaPatterns(project, stageId, areaIds = []) {
  const stage = project.stages?.[stageId];
  if (!stage) return [];
  return areaIds.flatMap((areaId) => {
    const area = stage.areas?.[areaId];
    if (!area) return [];
    const root = joinRepositoryPath(stage.root, area.root);
    return [root, root + '/**'];
  });
}

export function selectorPatterns(selector, project, manifest = {}) {
  if (selector.type === 'static') return selector.paths;
  if (selector.type === 'domain') {
    const domain = (manifest.domainRegistry || []).find((item) => item.id === selector.domain);
    const roots = domain ? [domain.root, ...(domain.mirrors || [])] : [];
    return roots.flatMap((root) => [root, root + '/**']);
  }
  if (selector.type === 'workspace') {
    return Object.values(project.stages || {})
      .filter((stage) => stage.status !== 'unavailable')
      .map((stage) => joinRepositoryPath(stage.root, selector.marker));
  }
  const stage = project.stages?.[selector.stage];
  if (!stage) return [];
  if (selector.type === 'artifact') {
    const artifactPatterns = selector.artifacts.flatMap((artifactId) => {
      const paths = artifactPaths(project, artifactId, selector.stage);
      return paths ? [paths.authorityPath, ...(paths.authorityRoot ? [paths.authorityRoot + '/**'] : []), ...paths.outputPaths, ...(paths.memberOutputs || []).flatMap((output) => [output.root, output.root + '/**']), ...(
        paths.inputRoot ? [paths.inputRoot, paths.inputRoot + '/**'] : []
      )] : [];
    });
    return [...artifactPatterns, ...areaPatterns(project, selector.stage, selector.areas)];
  }
  if (selector.type === 'stage') return [stage.root, stage.root + '/**'];
  return areaPatterns(project, selector.stage, [selector.area]);
}

function outputAuthorities(project, manifest) {
  const pairs = [];
  for (const artifact of manifest.artifactRegistry || []) {
    const paths = artifactPaths(project, artifact.id, artifact.stage);
    if (!paths) continue;
    for (const output of paths.outputPaths) {
      pairs.push({ output, authorityPath: paths.authorityPath });
    }
    for (const output of paths.memberOutputs || []) {
      pairs.push({ outputRoot: output.root, member: output.member, authorityRoot: paths.authorityRoot, authorityMember: paths.member || paths.semanticEntry });
    }
  }
  return pairs;
}

function scopeStage(scope) {
  return ['static', 'workspace', 'domain'].includes(scope?.selector?.type) ? null : scope?.selector?.stage;
}

function commandsForProfiles(manifest, profiles, profileIds) {
  const requested = new Set();
  for (const profileId of profileIds) {
    for (const commandId of profiles.get(profileId)?.commands || []) requested.add(commandId);
  }
  return (manifest.commands || []).filter((command) => requested.has(command.id));
}

export function resolveHarness(manifest, project, inputPaths, intent, root, options = {}) {
  const blockers = [];
  const catalog = new Map((manifest.blockers || []).map((item) => [item.code, item]));
  const profiles = new Map((manifest.validationProfiles || []).map((item) => [item.id, item]));
  const scopes = new Map((manifest.scopes || []).map((item) => [item.id, item]));
  const normalizedInputs = [];

  const executionContext = intent;
  const allowedContexts = new Set([
    'local-edit',
    'explicit-consistency',
    'handoff',
    'pull-request',
    'main',
    'release',
  ]);
  if (!allowedContexts.has(executionContext)) {
    blockers.push(catalogBlocker(catalog, 'AIH_EXECUTION_CONTEXT_INVALID', 'executionContext', '不支持的执行上下文：' + executionContext));
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
  for (const pair of outputAuthorities(project, manifest)) {
    const dynamicInput = pair.outputRoot
      ? normalizedInputs.find((path) => path.startsWith(pair.outputRoot + '/') && path.endsWith('/' + pair.member))
      : null;
    const dynamicActor = dynamicInput?.slice(pair.outputRoot.length + 1).split('/')[0];
    const dynamicAuthority = dynamicActor ? joinRepositoryPath(pair.authorityRoot, dynamicActor, pair.authorityMember) : null;
    if ((pair.output && inputSet.has(pair.output) && !inputSet.has(pair.authorityPath)) || (dynamicInput && !inputSet.has(dynamicAuthority))) {
      blockers.push(catalogBlocker(
        catalog,
        'AIH_GENERATED_DRIFT',
        pair.output || dynamicInput,
        '生成 projection 不能单独修改；请修改权威入口：' + (pair.authorityPath || dynamicAuthority),
      ));
    }
  }

  const selectedById = new Map();
  for (const path of normalizedInputs) {
    const matches = [];
    for (const scope of manifest.scopes || []) {
      const patterns = selectorPatterns(scope.selector, project, manifest);
      if (patterns.some((pattern) => picomatch(pattern, { dot: true })(path))) matches.push(scope);
    }
    const workspaceMatches = matches.filter((scope) => scope.selector.type === 'workspace');
    const domainMatches = matches.filter((scope) => scope.selector.type === 'domain');
    const effectiveMatches = workspaceMatches.length > 0
      ? workspaceMatches
      : domainMatches.length > 0
        ? matches.filter((scope) => scope.kind !== 'repository')
        : matches;
    if (effectiveMatches.length === 0) {
      blockers.push(catalogBlocker(catalog, 'AIH_SCOPE_UNRESOLVED', path, '路径未命中任何 Scope：' + path));
      continue;
    }
    const selectedByGroup = new Map();
    for (const match of effectiveMatches) {
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
      ['handoff', 'release'].includes(executionContext)
      && !['static', 'workspace', 'domain'].includes(scope.selector.type)
      && project.stages?.[scope.selector.stage]?.status === 'uninitialized'
    ) {
      blockers.push(catalogBlocker(
        catalog,
        'AIH_STAGE_UNINITIALIZED',
        scope.selector.stage,
        '阶段尚未初始化，不能执行 ' + executionContext + '：' + scope.selector.stage,
      ));
    }
    if (
      executionContext === 'local-edit'
      && !['static', 'workspace', 'domain'].includes(scope.selector.type)
      && project.stages?.[scope.selector.stage]?.status === 'published'
    ) {
      blockers.push(catalogBlocker(
        catalog,
        'AIH_STAGE_LOCKED',
        scope.selector.stage,
        '阶段已经发布并锁定；修改前必须执行 Reopen：' + scope.selector.stage,
      ));
    }
  }

  const upstreamScopes = [];
  const upstreamProfiles = [];
  const visitedDependencies = new Set();
  function visitDependencies(scope) {
    const downstreamStage = scopeStage(scope);
    for (const dependencyId of dependencyIds(manifest, scope.id)) {
      const edge = dependencyId + '->' + scope.id;
      if (visitedDependencies.has(edge)) continue;
      visitedDependencies.add(edge);
      const dependency = scopes.get(dependencyId);
      if (!dependency) continue;
      visitDependencies(dependency);
      if (!upstreamScopes.includes(dependencyId)) upstreamScopes.push(dependencyId);
      if (dependency.status !== 'active') {
        blockers.push(catalogBlocker(
          catalog,
          'AIH_UPSTREAM_NOT_READY',
          dependencyId,
          '依赖 Scope 当前不可消费：' + dependencyId,
        ));
        continue;
      }
      const dependencyStage = scopeStage(dependency);
      const crossStage = dependencyStage && dependencyStage !== downstreamStage;
      if (crossStage && !stageIsReadable(project.stages?.[dependencyStage])) {
        blockers.push(catalogBlocker(
          catalog,
          'AIH_UPSTREAM_NOT_READY',
          dependencyStage,
          '下游变更要求依赖阶段先达到 active 或 published：' + dependencyStage,
        ));
      }
      const dependencyProfile = executionContext === 'release'
        ? dependency.readinessProfile
        : executionContext === 'main'
          ? (dependency.mainProfile || dependency.checkpointProfile || dependency.readinessProfile)
          : executionContext === 'pull-request'
            ? (dependency.checkpointProfile || dependency.readinessProfile)
            : executionContext === 'handoff'
              ? (dependency.handoffProfile || dependency.readinessProfile)
              : (dependency.consistencyProfile || dependency.checkpointProfile || dependency.readinessProfile);
      if (!upstreamProfiles.includes(dependencyProfile)) {
        upstreamProfiles.push(dependencyProfile);
      }
    }
  }
  if (['explicit-consistency', 'handoff', 'pull-request', 'main', 'release'].includes(executionContext)) {
    for (const scope of selected) visitDependencies(scope);
  }

  const selectedProfiles = [...upstreamProfiles];
  for (const scope of selected) {
    if (scope.status !== 'active') continue;
      const stageState = ['static', 'workspace', 'domain'].includes(scope.selector.type)
      ? null
      : project.stages?.[scope.selector.stage]?.status;
    const profileId = executionContext === 'release'
      ? scope.readinessProfile
      : executionContext === 'main'
        ? (scope.mainProfile || scope.checkpointProfile || scope.readinessProfile)
        : executionContext === 'pull-request'
          ? (scope.checkpointProfile || scope.readinessProfile)
          : executionContext === 'handoff'
            ? (scope.handoffProfile || scope.readinessProfile)
            : executionContext === 'explicit-consistency'
              ? (scope.consistencyProfile || scope.checkpointProfile || scope.readinessProfile)
              : stageState === 'uninitialized'
                ? (scope.uninitializedProfile || scope.defaultProfile)
                : scope.defaultProfile;
    if (!selectedProfiles.includes(profileId)) selectedProfiles.push(profileId);
  }

  const upstreamCommandList = commandsForProfiles(manifest, profiles, upstreamProfiles);
  const orderedCommands = commandsForProfiles(manifest, profiles, selectedProfiles);
  const inputDigest = options.inputDigest || createHash('sha256').update(normalizedInputs.slice().sort().join('\n')).digest('hex');
  const standardDigest = digest(manifest.standard);
  const dependencyDigest = digest({
    scopes: upstreamScopes.map((id) => scopes.get(id)),
    profiles: upstreamProfiles.map((id) => profiles.get(id)),
    edges: (manifest.projectDag?.edges || []).filter((edge) => edge.type === 'dependency' && upstreamScopes.includes(edge.from)),
    stages: Object.fromEntries([...new Set(upstreamScopes.map((id) => scopeStage(scopes.get(id))).filter(Boolean))]
      .map((id) => [id, project.stages?.[id]])),
    sourceDigest: options.dependencyDigest || digest([]),
  });
  const runtimeDigest = options.runtimeDigest || digest(manifest.runtime);
  const costRank = { quick: 0, standard: 1, full: 2 };
  const contextLimit = ['local-edit'].includes(executionContext)
    ? 'quick'
    : ['explicit-consistency', 'handoff', 'pull-request'].includes(executionContext)
      ? 'standard'
      : 'full';
  const plan = [];
  const plannedKeys = new Set();
  for (const command of orderedCommands) {
    const owningProfiles = selectedProfiles
      .map((id) => profiles.get(id))
      .filter((profile) => profile?.commands.includes(command.id));
    const profile = owningProfiles[0];
    if (!profile?.allowedContexts?.includes(executionContext) || !command.allowedContexts?.includes(executionContext)) {
      blockers.push(catalogBlocker(catalog, 'AIH_EXECUTION_CONTEXT_INVALID', command.id, '命令或 Profile 不允许在 ' + executionContext + ' 执行。'));
      continue;
    }
    if (costRank[command.costClass] > costRank[contextLimit] || costRank[profile.costClass] > costRank[contextLimit]) {
      blockers.push(catalogBlocker(catalog, 'AIH_COST_POLICY_EXCEEDED', command.id, '命令成本 ' + command.costClass + ' 超出 ' + executionContext + ' 上限 ' + contextLimit + '。'));
      continue;
    }
    const profileVersion = profile.version;
    const deduplicationKey = command.id + ':' + inputDigest + ':' + profileVersion;
    if (plannedKeys.has(deduplicationKey)) continue;
    plannedKeys.add(deduplicationKey);
    const bindings = {
      standardDigest,
      profileDigest: digest(owningProfiles),
      executorDigest: options.executorDigests?.[command.id] || digest(command.executor),
      sourceDigest: inputDigest,
      dependencyDigest,
      runtimeDigest,
    };
    const cacheKey = digest({ commandId: command.id, bindings });
    const sourceScope = selected.find((scope) => owningProfiles.some((item) => [
      scope.defaultProfile,
      scope.uninitializedProfile,
      scope.consistencyProfile,
      scope.handoffProfile,
      scope.checkpointProfile,
      scope.mainProfile,
      scope.readinessProfile,
    ].includes(item.id)))?.id || selected[0]?.id || null;
    const dependencyPath = sourceScope && upstreamScopes.length > 0
      ? [...upstreamScopes, sourceScope]
      : (sourceScope ? [sourceScope] : []);
    plan.push({
      commandId: command.id,
      command: command.run,
      selectedBy: [
        ...owningProfiles.map((item) => 'profile:' + item.id),
        ...selected.map((item) => 'direct-scope:' + item.id),
        ...upstreamScopes.map((item) => 'dependency:' + item),
      ],
      sourceScope,
      scopeExpansionPath: dependencyPath,
      executionContext,
      costClass: command.costClass,
      timeoutMs: Math.min(command.timeoutMs, profile.timeoutMs),
      inputDigest,
      profileVersion,
      cache: {
        key: cacheKey,
        policy: command.cache.mode,
        status: command.cache.mode === 'disabled' ? 'BYPASS' : 'MISS',
        reason: command.cache.mode === 'disabled' ? 'cache-disabled' : 'operation-cache-empty',
        bindings,
      },
    });
  }
  const downstreamConsumers = [];
  const selectedScopeIds = new Set(selected.map((scope) => scope.id));
  for (const selectedScope of selected) {
    for (const consumerId of handoffConsumerIds(manifest, selectedScope.id)) {
      const consumer = scopes.get(consumerId);
      const consumerStage = scopeStage(consumer);
      if (
        selectedScopeIds.has(consumerId)
        || consumer?.status !== 'active'
        || (consumerStage && project.stages?.[consumerStage]?.status === 'unavailable')
      ) continue;
      if (!downstreamConsumers.includes(consumerId)) downstreamConsumers.push(consumerId);
    }
  }

  return {
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    protocol: manifest.standard?.protocol,
    executionContext,
    scopes: selected.map((scope) => scope.id),
    upstreamScopes,
    downstreamConsumers,
    upstreamProfiles,
    upstreamCommandIds: upstreamCommandList.map((command) => command.id),
    upstreamCommands: upstreamCommandList.map((command) => command.run),
    profiles: selectedProfiles,
    plan,
    commandIds: plan.map((item) => item.commandId),
    commands: plan.map((item) => item.command),
    evidence: {
      plannedCommandCount: plan.length,
      executedCommandCount: 0,
      cacheHitCount: 0,
      notRunCount: 0,
      totalDurationMs: 0,
    },
    blockers,
  };
}
