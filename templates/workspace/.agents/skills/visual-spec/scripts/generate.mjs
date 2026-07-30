import { readFile } from 'node:fs/promises';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import {
  blocker,
  isLegacyVisualInput,
  loadSourceSet,
  sourceLock,
  sourceReadiness,
  stableChecklistItems,
  stableJson,
  validateReferences,
  validateWithSchema,
} from './lib/visual-spec.mjs';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let checklist = null;
let outputPath = '.psp/visual-spec/checklist.json';
let transactionId = null;

try {
  const inputPath = argument('input');
  if (inputPath) {
    let input = null;
    try { input = JSON.parse(await readFile(inputPath, 'utf8')); } catch { /* legacy HTML/text */ }
    if (isLegacyVisualInput(input, inputPath)) {
      throw Object.assign(new Error('旧视觉产物禁止作为 Checklist 输入。'), { code: 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN' });
    }
    throw Object.assign(new Error('Checklist Compiler 不接受合并输入；只读取 Registry 中的正式上游。'), {
      code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID',
    });
  }

  const initial = await loadSourceSet(root, false);
  const baselineRecord = initial.records.find((item) => item.artifactId === 'functional-delivery-baseline');
  const needsTestCases = (baselineRecord.data.items ?? []).some((item) => (
    item.classification === 'visual' && item.deliveryLevel === 'USER_PATH'
  ));
  const { project, records } = needsTestCases ? await loadSourceSet(root, true) : initial;
  for (const record of records) blockers.push(...sourceReadiness(record));
  const useCases = records.find((item) => item.artifactId === 'capabilities');
  const baseline = records.find((item) => item.artifactId === 'functional-delivery-baseline');
  const testCases = records.find((item) => item.artifactId === 'test-case-catalog');
  blockers.push(...await validateWithSchema(root, useCases.definition.schema, useCases.data));
  blockers.push(...await validateWithSchema(root, baseline.definition.schema, baseline.data));
  if (testCases) blockers.push(...await validateWithSchema(root, testCases.definition.schema, testCases.data));
  blockers.push(...validateReferences(useCases.data, baseline.data, testCases?.data));
  if (blockers.length) throw Object.assign(new Error('上游未满足 Checklist 编译条件。'), { code: null });

  const paths = artifactPaths(project, 'checklist', 'visual-spec');
  if (!paths?.authorityPath) {
    throw Object.assign(new Error('Registry 未绑定 visual-spec.artifacts.checklist。'), {
      code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID',
    });
  }
  outputPath = paths.authorityPath;
  const base = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    metadata: { artifactId: 'VISUAL-SPEC-CHECKLIST', revision: 1, status: 'ready' },
    sourceLocks: records.map(sourceLock),
    items: stableChecklistItems(baseline.data, useCases.data, testCases?.data),
    gaps: [],
  };
  let previous = null;
  try { previous = JSON.parse(await readFile(repositoryFile(root, outputPath), 'utf8')); } catch { /* first generation */ }
  if (isLegacyVisualInput(previous, outputPath)) {
    throw Object.assign(new Error('正式 Checklist 路径包含旧视觉产物。'), { code: 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN' });
  }
  if (previous) {
    for (const current of base.sourceLocks) {
      const old = (previous.sourceLocks ?? []).find((item) => item.artifactId === current.artifactId);
      if (old && old.revision === current.revision && old.digest !== current.digest) {
        blockers.push(blocker(
          'VISUAL_SPEC_SOURCE_REVISION_REUSED',
          `${current.artifactId} 在 revision ${current.revision} 复用了不同字节。`,
        ));
      }
    }
    const comparablePrevious = structuredClone(previous);
    comparablePrevious.metadata.revision = 1;
    const comparableBase = structuredClone(base);
    comparableBase.metadata.revision = 1;
    base.metadata.revision = stableJson(comparablePrevious) === stableJson(comparableBase)
      ? previous.metadata.revision
      : previous.metadata.revision + 1;
  }
  if (blockers.length) throw Object.assign(new Error('检测到 revision 重用。'), { code: null });
  checklist = base;
  const schemaErrors = await validateWithSchema(
    root,
    '.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json',
    checklist,
  );
  blockers.push(...schemaErrors);
  if (blockers.length) throw Object.assign(new Error('生成的 Checklist 不符合新 Schema。'), { code: null });
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'visual-spec-checklist',
    writes: [{ target: outputPath, content: stableJson(checklist) }],
  });
} catch (error) {
  if (error.code) blockers.unshift(blocker(error.code, error.message));
  else if (!blockers.length) blockers.push(blocker('VISUAL_SPEC_SOURCE_NOT_READY', error.message));
}

const result = {
  status: blockers.length ? 'BLOCKED' : 'PASS',
  artifact: blockers.length ? null : outputPath,
  revision: checklist?.metadata?.revision ?? null,
  transactionId,
  blockers,
};
console.log(JSON.stringify(result, null, process.argv.includes('--json') ? 0 : 2));
if (blockers.length) process.exitCode = 1;
