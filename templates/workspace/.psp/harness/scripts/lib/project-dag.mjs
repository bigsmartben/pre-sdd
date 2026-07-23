export function dagNodes(manifest) {
  return new Map((manifest.projectDag?.nodes || []).map((node) => [node.id, node]));
}

export function incomingDagEdges(manifest, nodeId) {
  return (manifest.projectDag?.edges || []).filter((edge) => edge.to === nodeId);
}

export function dependencyIds(manifest, nodeId) {
  return incomingDagEdges(manifest, nodeId)
    .filter((edge) => edge.type === 'dependency')
    .map((edge) => edge.from);
}

export function handoffConsumerIds(manifest, nodeId) {
  return (manifest.projectDag?.edges || [])
    .filter((edge) => edge.from === nodeId && edge.type === 'handoff')
    .map((edge) => edge.to);
}

export function handoffEdge(manifest, from, to) {
  return (manifest.projectDag?.edges || [])
    .find((edge) => edge.from === from && edge.to === to && edge.type === 'handoff');
}

export function edgeIdentity(edge) {
  return edge.from + '->' + edge.to + ':' + edge.type;
}

export function collectDependencyIds(manifest, nodeId) {
  const ordered = [];
  const visited = new Set();

  function visit(currentId) {
    for (const dependencyId of dependencyIds(manifest, currentId)) {
      if (visited.has(dependencyId)) continue;
      visited.add(dependencyId);
      visit(dependencyId);
      ordered.push(dependencyId);
    }
  }

  visit(nodeId);
  return ordered;
}

export function collectDependencyClosureIds(manifest, nodeId) {
  return [...collectDependencyIds(manifest, nodeId), nodeId];
}

export function collectDependencyArtifactIds(manifest, nodeId) {
  const scopes = new Map((manifest.scopes || []).map((scope) => [scope.id, scope]));
  return [...new Set(collectDependencyClosureIds(manifest, nodeId).flatMap((scopeId) => {
    const selector = scopes.get(scopeId)?.selector;
    return selector?.type === 'artifact' ? selector.artifacts || [] : [];
  }))];
}
