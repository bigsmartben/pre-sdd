import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import {
  artifactDefinition,
  artifactPaths,
  loadProject,
  readStructured,
  repositoryFile,
  repositoryRootFrom,
} from '../../../runtime/project.mjs';
import {
  sha256,
  stableJson,
  validateWithSchema,
} from '../../visual-spec/scripts/lib/visual-spec.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let plan = null;
let transactionId = null;

try {
  const visualValidation = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, '../../visual-spec/scripts/validate.mjs'), '--json'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
    },
  );
  if (visualValidation.status !== 0) {
    throw Object.assign(new Error(visualValidation.stdout || visualValidation.stderr), {
      code: 'VISUAL_SPEC_SOURCE_NOT_READY',
    });
  }
  const project = await loadProject(root);
  const catalogDefinition = artifactDefinition(project, 'test-case-catalog', 'user-path-cases');
  const catalogPaths = artifactPaths(project, 'test-case-catalog', 'user-path-cases');
  const checklistPaths = artifactPaths(project, 'checklist', 'visual-spec');
  const planPaths = artifactPaths(project, 'user-path-plan', 'user-path-cases');
  if (!catalogDefinition || !catalogPaths?.authorityPath || !checklistPaths?.authorityPath || !planPaths?.authorityPath) {
    throw Object.assign(new Error('Test Case、Checklist 或 Path Plan Registry 不完整。'), {
      code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID',
    });
  }
  const catalogBytes = await readFile(repositoryFile(root, catalogPaths.authorityPath));
  const checklistBytes = await readFile(repositoryFile(root, checklistPaths.authorityPath));
  const catalog = await readStructured(root, catalogPaths.authorityPath, catalogDefinition.format);
  const checklist = JSON.parse(checklistBytes);
  blockers.push(...await validateWithSchema(root, catalogDefinition.schema, catalog));
  blockers.push(...await validateWithSchema(
    root,
    '.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json',
    checklist,
  ));
  if (catalog.metadata?.status !== 'ready' || (catalog.gaps ?? []).length) {
    blockers.push({ code: 'VISUAL_SPEC_SOURCE_NOT_READY', message: 'Test Case Catalog 未 ready 或仍有 gap。' });
  }
  if (checklist.metadata?.status !== 'ready' || (checklist.gaps ?? []).length) {
    blockers.push({ code: 'VISUAL_SPEC_SOURCE_NOT_READY', message: 'Visual Spec Checklist 未 ready 或仍有 gap。' });
  }
  if (blockers.length) throw new Error('上游未就绪。');

  const itemRefsByCase = new Map();
  for (const item of checklist.items ?? []) {
    if (item.requiredDeliveryLevel !== 'USER_PATH') continue;
    for (const testCaseRef of item.testCaseRefs ?? []) {
      const refs = itemRefsByCase.get(testCaseRef) ?? [];
      refs.push(item.itemId);
      itemRefsByCase.set(testCaseRef, refs);
    }
  }
  const catalogById = new Map((catalog.testCases ?? []).map((item) => [item.testCaseId, item]));
  for (const testCaseRef of itemRefsByCase.keys()) {
    if (!catalogById.has(testCaseRef)) blockers.push({
      code: 'VISUAL_SPEC_TEST_CASE_REF_INVALID',
      message: `Checklist 引用未知 Test Case：${testCaseRef}`,
    });
  }
  if (blockers.length) throw new Error('Test Case 引用不闭合。');

  const paths = [...itemRefsByCase.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([testCaseRef, checklistItemRefs]) => {
    const testCase = catalogById.get(testCaseRef);
    return {
      pathId: `UP-${testCaseRef}`,
      checklistItemRefs: [...checklistItemRefs].sort(),
      testCaseRef,
      steps: (testCase.steps ?? []).map((step, index) => ({
        pathStepId: `UP-${testCaseRef}-STEP-${String(index + 1).padStart(2, '0')}`,
        testCaseStepRef: step.stepId,
        action: step.action,
        expectedOutcome: step.expectedOutcome,
        checkpoint: step.expectedOutcome,
        assertion: `observe:${step.stepId}`,
      })),
      scenarioSlots: [`case-${testCaseRef.toLowerCase()}`],
    };
  });
  const candidate = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'USER-PATH-PLAN', revision: 1, status: 'ready' },
    sourceLocks: [
      {
        artifactId: 'TEST-CASE-CATALOG',
        path: catalogPaths.authorityPath,
        revision: catalog.metadata.revision,
        digest: sha256(catalogBytes),
      },
      {
        artifactId: 'VISUAL-SPEC-CHECKLIST',
        path: checklistPaths.authorityPath,
        revision: checklist.metadata.revision,
        digest: sha256(checklistBytes),
      },
    ],
    paths,
    gaps: [],
  };
  let previous = null;
  try { previous = JSON.parse(await readFile(repositoryFile(root, planPaths.authorityPath), 'utf8')); } catch { /* first generation */ }
  if (previous) {
    for (const lock of candidate.sourceLocks) {
      const old = (previous.sourceLocks ?? []).find((item) => item.artifactId === lock.artifactId);
      if (old && old.revision === lock.revision && old.digest !== lock.digest) {
        blockers.push({
          code: 'VISUAL_SPEC_SOURCE_REVISION_REUSED',
          message: `${lock.artifactId} 在相同 revision 下改变了字节。`,
        });
      }
    }
    const left = structuredClone(previous);
    const right = structuredClone(candidate);
    left.metadata.revision = 1;
    right.metadata.revision = 1;
    candidate.metadata.revision = stableJson(left) === stableJson(right)
      ? previous.metadata.revision
      : previous.metadata.revision + 1;
  }
  blockers.push(...await validateWithSchema(
    root,
    '.agents/skills/user-path-cases/schemas/user-path-plan.schema.json',
    candidate,
  ));
  if (blockers.length) throw new Error('Path Plan 无法生成。');
  plan = candidate;
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'user-path-plan',
    writes: [{ target: planPaths.authorityPath, content: stableJson(plan) }],
  });
} catch (error) {
  if (!blockers.length) blockers.push({ code: error.code || 'UPC_GENERATION_FAILED', message: error.message });
}

console.log(JSON.stringify({
  status: blockers.length ? 'BLOCKED' : 'PASS',
  artifact: plan ? '.psp/visual-spec/user-path-plan.json' : null,
  transactionId,
  blockers,
}));
if (blockers.length) process.exitCode = 1;
