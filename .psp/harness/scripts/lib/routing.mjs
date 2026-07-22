import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import { normalizeRepositoryPath } from './repository.mjs';

export const EXECUTION_CONTEXTS = [
  'local-edit',
  'explicit-consistency',
  'handoff',
  'pull-request',
  'main',
  'release',
];

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

export function matchingScopes(manifest, paths, root) {
  const selected = new Map();
  const blockers = [];
  for (const input of paths) {
    const normalized = normalizeRepositoryPath(input, root);
    if (normalized.error) {
      blockers.push({ code: normalized.error, message: normalized.message, path: input });
      continue;
    }
    const matches = manifest.scopes
      .filter((scope) => scope.status === 'active' && scope.selector?.type === 'static')
      .filter((scope) => scope.selector.paths.some((pattern) => picomatch(pattern, { dot: true })(normalized.path)));
    if (matches.length === 0) {
      blockers.push({ code: 'AIH_SCOPE_UNRESOLVED', message: '路径未归入脚手架 Scope：' + normalized.path, path: normalized.path });
      continue;
    }
    const byGroup = new Map();
    for (const scope of matches) {
      const current = byGroup.get(scope.selectionGroup);
      if (!current || scope.priority > current.priority) byGroup.set(scope.selectionGroup, scope);
    }
    for (const scope of byGroup.values()) selected.set(scope.id, scope);
  }
  return { scopes: [...selected.values()], blockers };
}

function profileFor(scope, executionContext) {
  if (executionContext === 'release') return scope.readinessProfile;
  if (executionContext === 'main') return scope.mainProfile;
  if (executionContext === 'pull-request') return scope.checkpointProfile;
  if (executionContext === 'explicit-consistency') return scope.consistencyProfile || scope.checkpointProfile;
  return scope.defaultProfile;
}

export function resolvedPlan(manifest, scopes, executionContext, normalizedPaths, options = {}) {
  const blockers = [];
  const profileIds = [];
  for (const scope of scopes) {
    const id = profileFor(scope, executionContext);
    if (!profileIds.includes(id)) profileIds.push(id);
  }
  const profiles = profileIds
    .map((id) => manifest.validationProfiles.find((profile) => profile.id === id))
    .filter(Boolean);
  const inputDigest = options.inputDigest || createHash('sha256').update(normalizedPaths.slice().sort().join('\n')).digest('hex');
  const standardDigest = digest(manifest.standard);
  const dependencyDigest = digest([]);
  const runtimeDigest = options.runtimeDigest || digest({ repositoryKind: manifest.repositoryKind, version: manifest.version });
  const costRank = { quick: 0, standard: 1, full: 2 };
  const contextLimit = executionContext === 'local-edit'
    ? 'quick'
    : executionContext === 'pull-request' || executionContext === 'explicit-consistency'
      ? 'standard'
      : 'full';
  const requested = new Map();
  for (const profile of profiles) {
    if (!profile.allowedContexts.includes(executionContext)) {
      blockers.push({ code: 'AIH_EXECUTION_CONTEXT_INVALID', message: `Profile ${profile.id} 不允许在 ${executionContext} 执行。` });
      continue;
    }
    if (costRank[profile.costClass] > costRank[contextLimit]) {
      blockers.push({ code: 'AIH_COST_POLICY_EXCEEDED', message: `Profile ${profile.id} 成本超出 ${executionContext} 上限。` });
      continue;
    }
    for (const commandId of profile.commands) {
      const command = manifest.commands.find((item) => item.id === commandId);
      if (!command) continue;
      if (!command.allowedContexts.includes(executionContext)) {
        blockers.push({ code: 'AIH_EXECUTION_CONTEXT_INVALID', message: `命令 ${command.id} 不允许在 ${executionContext} 执行。` });
        continue;
      }
      if (costRank[command.costClass] > costRank[contextLimit]) {
        blockers.push({ code: 'AIH_COST_POLICY_EXCEEDED', message: `命令 ${command.id} 成本超出 ${executionContext} 上限。` });
        continue;
      }
      const deduplicationKey = command.id + ':' + inputDigest + ':' + profile.version;
      const existing = requested.get(deduplicationKey);
      if (existing) {
        existing.selectedBy.push('profile:' + profile.id);
        for (const scope of scopes.filter((item) => profileFor(item, executionContext) === profile.id)) {
          if (!existing.selectedBy.includes('direct-scope:' + scope.id)) existing.selectedBy.push('direct-scope:' + scope.id);
        }
        continue;
      }
      const sourceScope = scopes.find((scope) => profileFor(scope, executionContext) === profile.id)?.id || scopes[0]?.id || null;
      const directScopes = scopes.filter((scope) => profileFor(scope, executionContext) === profile.id).map((scope) => 'direct-scope:' + scope.id);
      const bindings = {
        standardDigest,
        profileDigest: digest(profile),
        executorDigest: digest({ id: command.id, npmScript: command.npmScript, run: command.run }),
        sourceDigest: inputDigest,
        dependencyDigest,
        runtimeDigest,
      };
      const cacheKey = digest({ commandId: command.id, bindings });
      requested.set(deduplicationKey, {
        commandId: command.id,
        command: command.run,
        selectedBy: ['profile:' + profile.id, ...directScopes],
        sourceScope,
        scopeExpansionPath: sourceScope ? [sourceScope] : [],
        executionContext,
        costClass: command.costClass,
        timeoutMs: Math.min(command.timeoutMs, profile.timeoutMs),
        inputDigest,
        profileVersion: profile.version,
        cache: {
          key: cacheKey,
          policy: command.cache.mode,
          status: command.cache.mode === 'disabled' ? 'BYPASS' : 'MISS',
          reason: command.cache.mode === 'disabled' ? 'cache-disabled' : 'operation-cache-empty',
          bindings,
        },
      });
    }
  }
  return { profiles, plan: [...requested.values()], blockers };
}
