import { readFile } from 'node:fs/promises';
import {
  artifactDefinition,
  artifactPaths,
  loadProject,
  readStructured,
  repositoryFile,
  repositoryRootFrom,
} from '../../../runtime/project.mjs';
import { sha256, validateWithSchema } from '../../visual-spec/scripts/lib/visual-spec.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
const stalePaths = [];
try {
  const project = await loadProject(root);
  const checklistOnlyPath = artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath;
  if (!checklistOnlyPath) throw Object.assign(new Error('Visual Spec Checklist Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const checklistOnly = JSON.parse(await readFile(repositoryFile(root, checklistOnlyPath), 'utf8'));
  if (!(checklistOnly.items ?? []).some((item) => item.requiredDeliveryLevel === 'USER_PATH')) {
    console.log(JSON.stringify({ status: 'PASS', required: false, blockers: [], stalePaths: [] }));
    process.exit(0);
  }
  const catalogDefinition = artifactDefinition(project, 'test-case-catalog', 'user-path-cases');
  const catalogPaths = artifactPaths(project, 'test-case-catalog', 'user-path-cases');
  const checklistPaths = artifactPaths(project, 'checklist', 'visual-spec');
  const planPaths = artifactPaths(project, 'user-path-plan', 'user-path-cases');
  if (!catalogDefinition || !catalogPaths || !checklistPaths || !planPaths) {
    throw Object.assign(new Error('User Path Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const catalogBytes = await readFile(repositoryFile(root, catalogPaths.authorityPath));
  const checklistBytes = await readFile(repositoryFile(root, checklistPaths.authorityPath));
  const plan = JSON.parse(await readFile(repositoryFile(root, planPaths.authorityPath), 'utf8'));
  const catalog = await readStructured(root, catalogPaths.authorityPath, catalogDefinition.format);
  const checklist = JSON.parse(checklistBytes);
  blockers.push(...await validateWithSchema(root, catalogDefinition.schema, catalog));
  blockers.push(...await validateWithSchema(
    root,
    '.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json',
    checklist,
  ));
  blockers.push(...await validateWithSchema(root, '.agents/skills/user-path-cases/schemas/user-path-plan.schema.json', plan));
  if (
    catalog.metadata?.status !== 'ready'
    || checklist.metadata?.status !== 'ready'
    || plan.metadata?.status !== 'ready'
    || (catalog.gaps ?? []).length
    || (checklist.gaps ?? []).length
    || (plan.gaps ?? []).length
  ) blockers.push({ code: 'VISUAL_SPEC_SOURCE_NOT_READY', message: 'Catalog、Checklist 或 Path Plan 未 ready 或仍有 Gap。' });
  const expected = new Map([
    ['TEST-CASE-CATALOG', {
      path: catalogPaths.authorityPath,
      revision: catalog.metadata.revision,
      digest: sha256(catalogBytes),
    }],
    ['VISUAL-SPEC-CHECKLIST', {
      path: checklistPaths.authorityPath,
      revision: checklist.metadata.revision,
      digest: sha256(checklistBytes),
    }],
  ]);
  if (
    new Set((plan.sourceLocks ?? []).map((lock) => lock.artifactId)).size !== expected.size
    || (plan.sourceLocks ?? []).length !== expected.size
    || [...expected.keys()].some((artifactId) => !(plan.sourceLocks ?? []).some((lock) => lock.artifactId === artifactId))
  ) blockers.push({ code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID', message: 'Path Plan Source Lock 集合不完整或重复。' });
  for (const lock of plan.sourceLocks ?? []) {
    const current = expected.get(lock.artifactId);
    if (!current || current.path !== lock.path) {
      blockers.push({ code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID', message: `${lock.artifactId} Source Lock 非正式路径。` });
      continue;
    }
    if (current.revision === lock.revision && current.digest !== lock.digest) {
      blockers.push({ code: 'VISUAL_SPEC_SOURCE_REVISION_REUSED', message: `${lock.artifactId} 相同 revision 对应不同摘要。` });
    }
    if (current.revision !== lock.revision || current.digest !== lock.digest) {
      stalePaths.push(...(plan.paths ?? []).map((item) => item.pathId));
    }
  }
  const expectedItemsByCase = new Map();
  for (const item of checklist.items ?? []) {
    if (item.requiredDeliveryLevel !== 'USER_PATH') continue;
    for (const testCaseRef of item.testCaseRefs ?? []) {
      const refs = expectedItemsByCase.get(testCaseRef) ?? [];
      refs.push(item.itemId);
      expectedItemsByCase.set(testCaseRef, refs);
    }
  }
  const catalogById = new Map((catalog.testCases ?? []).map((item) => [item.testCaseId, item]));
  const planById = new Map((plan.paths ?? []).map((item) => [item.pathId, item]));
  if (planById.size !== (plan.paths ?? []).length) {
    blockers.push({ code: 'UPC_PATH_REF_INVALID', message: 'Path Plan 包含重复 pathId。' });
  }
  for (const [testCaseRef, itemRefs] of expectedItemsByCase) {
    const pathId = `UP-${testCaseRef}`;
    const path = planById.get(pathId);
    const testCase = catalogById.get(testCaseRef);
    if (!path || !testCase || path.testCaseRef !== testCaseRef) {
      blockers.push({ code: 'UPC_PATH_REF_INVALID', message: `缺少 USER_PATH：${pathId}` });
      continue;
    }
    if (JSON.stringify([...path.checklistItemRefs].sort()) !== JSON.stringify([...itemRefs].sort())) {
      blockers.push({ code: 'UPC_PATH_REF_INVALID', message: `${pathId} 的 Checklist 引用不闭合。` });
    }
    const expectedSteps = testCase.steps ?? [];
    if (
      path.steps.length !== expectedSteps.length
      || path.steps.some((step, index) => (
        step.pathStepId !== `${pathId}-STEP-${String(index + 1).padStart(2, '0')}`
        || step.testCaseStepRef !== expectedSteps[index]?.stepId
      ))
    ) blockers.push({ code: 'UPC_PATH_STEP_INVALID', message: `${pathId} 的 Test Case Step 闭包无效。` });
    if (!(path.scenarioSlots ?? []).length) {
      blockers.push({ code: 'UPC_SCENARIO_SLOT_REQUIRED', message: `${pathId} 缺少场景槽位。` });
    }
  }
  for (const path of plan.paths ?? []) {
    if (!expectedItemsByCase.has(path.testCaseRef)) {
      blockers.push({ code: 'UPC_PATH_REF_INVALID', message: `Path Plan 擅自扩大范围：${path.pathId}` });
    }
  }
} catch (error) {
  blockers.unshift({ code: error.code || 'UPC_VALIDATION_FAILED', message: error.message });
}
const status = blockers.length ? 'BLOCKED' : stalePaths.length ? 'STALE' : 'PASS';
console.log(JSON.stringify({ status, blockers, stalePaths: [...new Set(stalePaths)].sort() }));
if (status !== 'PASS') process.exitCode = 1;
