import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifactCollectionMembers, artifactPaths, loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { canonicalLocks, inputLocks, reviewEvidenceDirectory, sha256 } from './integrity.mjs';
import { extractCanonicalUi } from './extract.mjs';

const defaultRoot = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const recordPath = '.psp/reviews/product-design-visual-acceptance.json';

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readReview(root) {
  const path = resolve(reviewEvidenceDirectory(root), 'review-evidence.json');
  return { path, raw: await readFile(path), data: JSON.parse(await readFile(path, 'utf8')) };
}

async function acceptanceModels(root, project) {
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const result = [];
  for (const member of await artifactCollectionMembers(root, paths)) {
    result.push({ actor: member.actor, model: await extractCanonicalUi(root, member.authorityPath) });
  }
  return result;
}

async function snapshot(root, project, manifest) {
  const [actors, inputs, models, review] = await Promise.all([
    canonicalLocks(root, project),
    inputLocks(root, project, manifest),
    acceptanceModels(root, project),
    readReview(root),
  ]);
  if (review.data.status !== 'PASS' || review.data.validation.some((item) => item.status !== 'PASS')) {
    throw Object.assign(new Error('Human Visual Acceptance 只能基于全部机器门禁通过的 Review Evidence。'), { code: 'AIH_HUMAN_VISUAL_ACCEPTANCE_REQUIRED' });
  }
  const reviewActors = new Map(review.data.actors.map((item) => [item.actor, item]));
  for (const actor of actors) {
    const reviewed = reviewActors.get(actor.actor);
    if (!reviewed || reviewed.implementationHash !== actor.implementationHash || reviewed.buildInputHash !== actor.buildInputs.contentHash || reviewed.draftVersion !== actor.draftVersion) {
      throw Object.assign(new Error('Review Evidence 与当前 UI HTML 实现不一致：' + actor.actor), { code: 'AIH_HUMAN_VISUAL_ACCEPTANCE_STALE' });
    }
  }
  const sourceVersion = sha256(JSON.stringify({
    inputs,
    actors: models.map(({ actor, model }) => ({
      actor,
      designSources: model.designSources.map((item) => ({ id: item.id, capturedAt: item.capturedAt, evidenceHash: item.evidence?.sha256 || null })),
      assets: model.assets.map((item) => ({ id: item.id, sourceVersion: item.sourceVersion, sha256: item.sha256 })),
    })),
  }));
  const implementationHash = sha256(JSON.stringify(actors.map((item) => ({ actor: item.actor, implementationHash: item.implementationHash }))));
  const scopeHash = sha256(JSON.stringify(models.map(({ actor, model }) => ({
    actor,
    visualPolicy: model.visualPolicy,
    routes: model.routes,
    screens: model.screens,
    componentContracts: model.componentContracts,
    stateAxes: model.stateAxes,
    stateMatrix: model.stateMatrix,
    mockCases: model.mockCases,
  }))));
  const validation = review.data.validation.map((item) => ({ id: item.id, status: item.status }));
  const coverage = models.filter(({ model }) => model.visualPolicy.mode === 'exact').map(({ actor, model }) => ({
    actor,
    reviewAddress: reviewActors.get(actor).reviewAddress,
    screenIds: model.screens.map((item) => item.id),
    stateGalleryPath: '/__review/components',
    mockCaseIds: model.mockCases.map((item) => item.id),
    validation,
  }));
  return { sourceVersion, implementationHash, scopeHash, reviewEvidenceHash: sha256(review.raw), coverage };
}

async function validateRecord(root, record) {
  const schema = JSON.parse(await readFile(repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/visual-acceptance.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(schema);
  if (!validate(record)) throw Object.assign(new Error('Visual Acceptance 不符合 Schema：' + JSON.stringify(validate.errors)), { code: 'AIH_HUMAN_VISUAL_ACCEPTANCE_INVALID' });
}

async function atomicWrite(path, record) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.' + randomUUID() + '.new';
  await writeFile(temporary, JSON.stringify(record, null, 2) + '\n', 'utf8');
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

export function visualAcceptanceRecordPath(root) {
  return repositoryFile(root, recordPath);
}

export async function verifyVisualAcceptance(root, project, manifest, options = {}) {
  const models = await acceptanceModels(root, project);
  if (!models.some(({ model }) => model.visualPolicy.mode === 'exact')) return [];
  const path = visualAcceptanceRecordPath(root);
  try {
    if (!await exists(path)) throw Object.assign(new Error('exact 模式缺少 Human Visual Acceptance。'), { code: 'AIH_HUMAN_VISUAL_ACCEPTANCE_REQUIRED' });
    const record = JSON.parse(await readFile(path, 'utf8'));
    await validateRecord(root, record);
    const current = await snapshot(root, project, manifest);
    const stale = record.status !== 'accepted' || ['sourceVersion', 'implementationHash', 'scopeHash', 'reviewEvidenceHash'].some((key) => record[key] !== current[key]);
    if (stale) {
      if (options.markStale && record.status !== 'stale') {
        const staleRecord = { ...record, status: 'stale' };
        await validateRecord(root, staleRecord);
        await atomicWrite(path, staleRecord);
      }
      throw Object.assign(new Error('Human Visual Acceptance 已因来源、实现、Asset、范围、Component Contract、State Matrix 或 Review 变化而失效。'), { code: 'AIH_HUMAN_VISUAL_ACCEPTANCE_STALE' });
    }
    return [];
  } catch (error) {
    if (options.markStale && await exists(path)) {
      try {
        const record = JSON.parse(await readFile(path, 'utf8'));
        if (record.status !== 'stale') {
          const staleRecord = { ...record, status: 'stale' };
          await validateRecord(root, staleRecord);
          await atomicWrite(path, staleRecord);
        }
      } catch { /* Preserve the original deterministic blocker. */ }
    }
    return [{ code: error.code || 'AIH_HUMAN_VISUAL_ACCEPTANCE_INVALID', message: error.message }];
  }
}

async function accept(root) {
  const { project, manifest } = await loadProjectAndManifest(root);
  if (project.stages?.['product-design']?.status !== 'active') throw Object.assign(new Error('只有 active Product Design 可记录视觉接受。'), { code: 'AIH_STAGE_LOCKED' });
  const acceptedBy = argument('accepted-by');
  const confirmation = argument('confirm');
  if (!acceptedBy?.startsWith('user:') || confirmation !== 'HUMAN_VISUAL_ACCEPTED') {
    throw Object.assign(new Error('必须由用户显式提供 --accepted-by user:<identity> --confirm HUMAN_VISUAL_ACCEPTED；Agent 不得代填。'), { code: 'AIH_HUMAN_VISUAL_ACCEPTANCE_REQUIRED' });
  }
  const current = await snapshot(root, project, manifest);
  if (current.coverage.length === 0) return { status: 'PASS', mode: 'not-required', acceptance: 'NOT_REQUIRED' };
  const record = {
    version: '1.0.0',
    method: 'human-visual-review',
    status: 'accepted',
    ...current,
    acceptedBy,
    acceptedAt: new Date().toISOString(),
  };
  await validateRecord(root, record);
  const path = visualAcceptanceRecordPath(root);
  await atomicWrite(path, record);
  return { status: 'PASS', mode: 'accept', acceptance: 'accepted', visualAcceptance: path, coverage: record.coverage };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = await accept(defaultRoot); }
  catch (error) { result = { status: 'BLOCKED', blockers: [{ code: error.code || 'AIH_HUMAN_VISUAL_ACCEPTANCE_INVALID', message: error.message }] }; }
  if (process.argv.includes('--json') || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
  else console.log('[PASS] Human Visual Acceptance 已由用户受控记录。');
  if (result.status !== 'PASS') process.exitCode = 1;
}
