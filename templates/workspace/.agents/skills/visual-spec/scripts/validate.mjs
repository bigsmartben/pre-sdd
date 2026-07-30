import { readFile } from 'node:fs/promises';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import {
  blocker,
  isLegacyVisualInput,
  loadSourceSet,
  sourceLock,
  sourceReadiness,
  stableChecklistItems,
  validateReferences,
  validateWithSchema,
} from './lib/visual-spec.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
const staleItems = new Set();
const staleSources = new Set();

try {
  const project = await loadProject(root);
  const checklistPath = artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath;
  if (!checklistPath) throw Object.assign(new Error('Registry 未绑定 Visual Spec Checklist。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const bytes = await readFile(repositoryFile(root, checklistPath));
  const checklist = JSON.parse(bytes);
  if (isLegacyVisualInput(checklist, checklistPath)) {
    throw Object.assign(new Error('旧视觉产物禁止进入 Validator。'), { code: 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN' });
  }
  blockers.push(...await validateWithSchema(
    root,
    '.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json',
    checklist,
  ));
  const needsTestCases = (checklist.items ?? []).some((item) => item.requiredDeliveryLevel === 'USER_PATH');
  const loaded = await loadSourceSet(root, needsTestCases);
  for (const record of loaded.records) {
    blockers.push(...sourceReadiness(record));
    blockers.push(...await validateWithSchema(root, record.definition.schema, record.data));
  }
  const useCases = loaded.records.find((item) => item.artifactId === 'capabilities');
  const baseline = loaded.records.find((item) => item.artifactId === 'functional-delivery-baseline');
  const testCases = loaded.records.find((item) => item.artifactId === 'test-case-catalog');
  blockers.push(...validateReferences(useCases.data, baseline.data, testCases?.data));

  const expectedLocks = new Map(loaded.records.map((record) => [record.declaredArtifactId, sourceLock(record)]));
  const actualLocks = new Map((checklist.sourceLocks ?? []).map((lock) => [lock.artifactId, lock]));
  if (
    expectedLocks.size !== actualLocks.size
    || [...expectedLocks.keys()].some((id) => !actualLocks.has(id))
    || actualLocks.size !== (checklist.sourceLocks ?? []).length
  ) {
    blockers.push(blocker('VISUAL_SPEC_SOURCE_LOCK_INVALID', 'Source Lock 集合与正式 Registry 不一致。'));
  }
  for (const [artifactId, expected] of expectedLocks) {
    const actual = actualLocks.get(artifactId);
    if (!actual) continue;
    if (actual.path !== expected.path) {
      blockers.push(blocker('VISUAL_SPEC_SOURCE_LOCK_INVALID', `${artifactId} 正式路径不一致。`));
    }
    if (actual.revision === expected.revision && actual.digest !== expected.digest) {
      blockers.push(blocker('VISUAL_SPEC_SOURCE_REVISION_REUSED', `${artifactId} 相同 revision 对应不同字节摘要。`));
    }
    if (actual.revision !== expected.revision || actual.digest !== expected.digest) staleSources.add(artifactId);
    // Item-local dependency digests below decide which entries are stale.
  }
  const expectedItems = stableChecklistItems(baseline.data, useCases.data, testCases?.data);
  const expectedIds = expectedItems.map((item) => item.itemId);
  const actualIds = (checklist.items ?? []).map((item) => item.itemId);
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    blockers.push(blocker('VISUAL_SPEC_CHECKLIST_ID_UNSTABLE', 'Checklist itemId 或排序不符合确定性编译规则。'));
  }
  const expectedById = new Map(expectedItems.map((item) => [item.itemId, item]));
  for (const item of checklist.items ?? []) {
    if (expectedById.get(item.itemId)?.dependencyDigest !== item.dependencyDigest) staleItems.add(item.itemId);
  }
  if ((checklist.gaps ?? []).length) blockers.push(blocker('VSC_GAP_OPEN', 'Checklist 仍有结构化 Gap。'));
  if (checklist.metadata?.status !== 'ready' && staleItems.size === 0 && staleSources.size === 0) {
    blockers.push(blocker('VISUAL_SPEC_SOURCE_NOT_READY', 'Checklist 状态不是 ready。'));
  }
} catch (error) {
  blockers.unshift(blocker(error.code || 'VISUAL_SPEC_SOURCE_NOT_READY', error.message));
}

const status = blockers.length ? 'BLOCKED' : (staleItems.size || staleSources.size) ? 'STALE' : 'PASS';
console.log(JSON.stringify({
  status,
  blockers,
  staleItems: [...staleItems].sort(),
  staleSources: [...staleSources].sort(),
  checklistReady: status === 'PASS',
}, null, process.argv.includes('--json') ? 0 : 2));
if (status !== 'PASS') process.exitCode = 1;
