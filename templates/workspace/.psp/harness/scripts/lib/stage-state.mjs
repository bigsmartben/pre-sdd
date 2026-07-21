export function stageIsReadable(stage) {
  return ['active', 'published'].includes(stage?.status);
}

export function stageIsMutable(stage) {
  return stage?.status === 'active';
}

export function stageIsInitialized(stage) {
  return stage && !['uninitialized', 'unavailable'].includes(stage.status);
}
