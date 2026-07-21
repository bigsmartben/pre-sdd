export function dagNodes(manifest) {
  return new Map((manifest.projectDag?.nodes || []).map((node) => [node.id, node]));
}

export function incomingDagEdges(manifest, nodeId) {
  return (manifest.projectDag?.edges || []).filter((edge) => edge.to === nodeId);
}

export function dependencyIds(manifest, nodeId) {
  return incomingDagEdges(manifest, nodeId).map((edge) => edge.from);
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
