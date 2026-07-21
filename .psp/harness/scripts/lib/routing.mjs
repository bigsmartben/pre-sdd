import picomatch from 'picomatch';
import { normalizeRepositoryPath } from './repository.mjs';

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

export function resolvedProfiles(manifest, scopes, intent) {
  const ids = [];
  for (const scope of scopes) {
    const id = intent === 'readiness'
      ? scope.readinessProfile
      : intent === 'checkpoint'
        ? scope.checkpointProfile
        : scope.defaultProfile;
    if (!ids.includes(id)) ids.push(id);
  }
  const profiles = ids.map((id) => manifest.validationProfiles.find((profile) => profile.id === id)).filter(Boolean);
  const commandIds = new Set(profiles.flatMap((profile) => profile.commands));
  const commands = manifest.commands.filter((command) => commandIds.has(command.id));
  return { profiles, commands };
}
