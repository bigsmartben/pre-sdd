import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { sha256, stableJson, validateWithSchema } from './lib/visual-spec.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
let authorization = null;
const freshnessIndex = process.argv.indexOf('--figma-freshness');
const freshnessPath = (freshnessIndex >= 0 ? process.argv[freshnessIndex + 1] : null) || process.env.PSP_FIGMA_FRESHNESS_PATH || null;
try {
  for (const validator of [
    resolve(import.meta.dirname, 'validate.mjs'),
    resolve(import.meta.dirname, '../../figma-evidence/scripts/validate.mjs'),
  ]) {
    const validatorArgs = [validator, '--json'];
    if (validator.includes('figma-evidence') && freshnessPath) validatorArgs.push('--figma-freshness', freshnessPath);
    const result = spawnSync(process.execPath, validatorArgs, {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
    });
    if (result.status !== 0) {
      blockers.push({
        code: validator.includes('figma-evidence') ? 'FGC_SOURCE_NOT_READY' : 'VISUAL_SPEC_SOURCE_NOT_READY',
        message: result.stdout || result.stderr,
      });
    }
  }
  if (blockers.length) throw new Error('分布式 Validator 未通过。');
  const project = await loadProject(root);
  const paths = {
    checklist: artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath,
    coverage: artifactPaths(project, 'figma-coverage', 'figma-evidence')?.authorityPath,
    evidence: artifactPaths(project, 'figma-evidence', 'figma-evidence')?.authorityPath,
    authorization: artifactPaths(project, 'ready-authorization', 'visual-spec')?.authorityPath,
  };
  if (Object.values(paths).some((value) => !value)) {
    throw Object.assign(new Error('Ready Authorization Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const load = async (path) => {
    const bytes = await readFile(repositoryFile(root, path));
    return { bytes, digest: sha256(bytes), data: JSON.parse(bytes) };
  };
  const checklist = await load(paths.checklist);
  const coverage = await load(paths.coverage);
  const evidence = await load(paths.evidence);
  blockers.push(...await validateWithSchema(root, '.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json', checklist.data));
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-evidence/schemas/figma-coverage.schema.json', coverage.data));
  blockers.push(...await validateWithSchema(root, '.agents/skills/figma-evidence/schemas/figma-evidence.schema.json', evidence.data));
  if (
    checklist.data.metadata?.status !== 'ready'
    || coverage.data.metadata?.status !== 'ready'
    || evidence.data.metadata?.status !== 'ready'
    || checklist.data.gaps?.length
    || coverage.data.gaps?.length
    || evidence.data.gaps?.length
  ) blockers.push({ code: 'VISUAL_SPEC_SOURCE_NOT_READY', message: 'Checklist 或 Figma Coverage/Evidence 未 ready。' });
  if (
    coverage.data.checklistLock?.path !== paths.checklist
    || coverage.data.checklistLock?.revision !== checklist.data.metadata.revision
    || coverage.data.checklistLock?.digest !== checklist.digest
  ) blockers.push({ code: 'FGC_SOURCE_STALE', message: 'Figma Coverage 未绑定当前 Checklist。' });
  if (
    evidence.data.coverageLock?.path !== paths.coverage
    || evidence.data.coverageLock?.revision !== coverage.data.metadata.revision
    || evidence.data.coverageLock?.digest !== coverage.digest
  ) blockers.push({ code: 'FGC_SOURCE_STALE', message: 'Figma Evidence 未绑定当前 Coverage。' });
  if (blockers.length) throw new Error('机器就绪条件未闭合。');
  const candidate = {
    schemaVersion: 'psp.dev/visual-spec/v1',
    artifactId: 'VISUAL-SPEC-READY-AUTHORIZATION',
    revision: 1,
    status: 'ready',
    checklist: {
      path: paths.checklist,
      revision: checklist.data.metadata.revision,
      digest: checklist.digest,
    },
    sourceLocks: checklist.data.sourceLocks,
    figmaCoverage: {
      path: paths.coverage,
      revision: coverage.data.metadata.revision,
      digest: coverage.digest,
    },
    figmaEvidence: {
      path: paths.evidence,
      revision: evidence.data.metadata.revision,
      digest: evidence.digest,
    },
  };
  let previous = null;
  try { previous = JSON.parse(await readFile(repositoryFile(root, paths.authorization), 'utf8')); } catch { /* first authorization */ }
  if (previous) {
    const left = structuredClone(previous);
    const right = structuredClone(candidate);
    left.revision = 1;
    right.revision = 1;
    candidate.revision = stableJson(left) === stableJson(right) ? previous.revision : previous.revision + 1;
  }
  blockers.push(...await validateWithSchema(root, '.agents/skills/visual-spec/schemas/ready-authorization.schema.json', candidate));
  if (blockers.length) throw new Error('Ready Authorization Schema 无效。');
  authorization = candidate;
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'visual-spec-ready-authorization',
    writes: [{ target: paths.authorization, content: stableJson(candidate) }],
  });
} catch (error) {
  if (!blockers.length) blockers.push({ code: error.code || 'VISUAL_SPEC_SOURCE_NOT_READY', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, authorization, blockers }));
if (blockers.length) process.exitCode = 1;
