import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { stringify as stringifyYaml } from 'yaml';
import { executeRegisteredCommand } from '../../../../../.psp/harness/scripts/lib/execute-command.mjs';
import { loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { canonicalLocks, inputLocks, reviewEvidenceDirectory, sha256 } from './integrity.mjs';

const defaultRoot = repositoryRootFrom(resolve(import.meta.dirname, '../..'));

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readLedger(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: '1.0.0', stage: 'product-design', current: null, history: [] }; throw error; }
}

function publicationCore(inputLocksValue, actors, reviewVersion) {
  return { inputLocks: inputLocksValue, actors, reviewVersion };
}

function publicationCredential(publication) {
  const { credential, reopenedAt, ...core } = publication;
  return sha256(JSON.stringify(core));
}

function stageIdentity(inputLocksValue, actors, reviewVersion) {
  return sha256(JSON.stringify(publicationCore(inputLocksValue, actors, reviewVersion)));
}

function versionIsGreater(next, previous) {
  const left = next.split('.').map(Number);
  const right = previous.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

async function validateLedger(root, ledger) {
  const schemaPath = '.agents/skills/product-design/canonical-ui-prototype/publication-receipt.schema.json';
  const schema = JSON.parse(await readFile(repositoryFile(root, schemaPath), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(schema);
  if (!validate(ledger)) throw Object.assign(new Error('Publication Receipt 不符合 Schema：' + JSON.stringify(validate.errors)), { code: 'AIH_PUBLISH_RECEIPT_INVALID' });
}

async function atomicLifecycleWrite(root, project, receiptPath, ledger) {
  const transactionId = randomUUID();
  const projectPath = repositoryFile(root, 'psp.project.yaml');
  const receipt = repositoryFile(root, receiptPath);
  await mkdir(dirname(receipt), { recursive: true });
  const entries = [
    { target: receipt, content: JSON.stringify(ledger, null, 2) + '\n' },
    { target: projectPath, content: stringifyYaml(project) },
  ];
  const replaced = [];
  try {
    for (const entry of entries) await writeFile(entry.target + '.' + transactionId + '.new', entry.content, 'utf8');
    for (const entry of entries) {
      const backup = entry.target + '.' + transactionId + '.bak';
      if (await exists(entry.target)) {
        await rename(entry.target, backup);
        replaced.push({ ...entry, backup, existed: true });
      } else replaced.push({ ...entry, backup, existed: false });
      await rename(entry.target + '.' + transactionId + '.new', entry.target);
    }
    await Promise.all(replaced.map((entry) => rm(entry.backup, { force: true })));
  } catch (error) {
    for (const entry of [...replaced].reverse()) {
      await rm(entry.target, { force: true });
      if (entry.existed && await exists(entry.backup)) await rename(entry.backup, entry.target);
    }
    throw error;
  } finally {
    await Promise.all(entries.map((entry) => rm(entry.target + '.' + transactionId + '.new', { force: true })));
  }
}

function runProfile(root, manifest, profileId) {
  const profile = manifest.validationProfiles.find((item) => item.id === profileId);
  if (!profile) throw Object.assign(new Error('Publish 引用未知 Profile：' + profileId), { code: 'AIH_PROFILE_INVALID' });
  const selected = new Set(profile.commands);
  const validation = [];
  let failed = false;
  for (const command of manifest.commands.filter((item) => selected.has(item.id))) {
    if (failed) { validation.push({ id: command.id, status: 'NOT_RUN', blockers: [] }); continue; }
    const result = executeRegisteredCommand(root, command, { arguments: command.executor.kind === 'module' ? ['--json'] : [], timeout: 240_000 });
    validation.push({ id: command.id, status: result.status, blockers: result.blockers || [] });
    if (result.status !== 'PASS') failed = true;
  }
  if (failed) throw Object.assign(new Error('Publish Profile 未通过。'), { code: validation.flatMap((item) => item.blockers)[0] || 'AIH_PUBLISH_VALIDATION_FAILED', validation });
  return validation;
}

export async function verifyPublishedProduct(root, project, manifest) {
  const stage = project.stages?.['product-design'];
  if (stage?.status !== 'published') return [];
  const blockers = [];
  try {
    const receiptPath = stage.publication?.receipt;
    const ledger = await readLedger(repositoryFile(root, receiptPath));
    await validateLedger(root, ledger);
    if (!ledger.current) throw Object.assign(new Error('published 阶段缺少当前发布凭证。'), { code: 'AIH_PUBLISH_RECEIPT_INVALID' });
    const currentInputs = await inputLocks(root, project, manifest);
    const currentActors = await canonicalLocks(root, project);
    if (currentActors.length !== ledger.current.actors.length) throw Object.assign(new Error('已锁定 UI HTML Actor 集合发生漂移。'), { code: 'AIH_PUBLISH_CREDENTIAL_STALE' });
    const lockedActors = ledger.current.actors.map((locked) => {
      const current = currentActors.find((item) => item.actor === locked.actor);
      if (!current) throw Object.assign(new Error('已锁定 UI HTML Actor 缺失：' + locked.actor), { code: 'AIH_PUBLISH_CREDENTIAL_STALE' });
      return { ...current, review: locked.review };
    });
    const identity = stageIdentity(currentInputs, lockedActors, ledger.current.reviewVersion);
    if (identity !== ledger.current.stageIdentityHash || publicationCredential(ledger.current) !== ledger.current.credential) {
      throw Object.assign(new Error('已锁定 UC、Visual Spec、Asset、UI HTML 或 Review 身份发生漂移。'), { code: 'AIH_PUBLISH_CREDENTIAL_STALE' });
    }
  } catch (error) {
    blockers.push({ code: error.code || 'AIH_PUBLISH_RECEIPT_INVALID', message: error.message });
  }
  return blockers;
}

async function publish(root, project, manifest, operation) {
  const stage = project.stages?.[operation.stage];
  if (stage?.status !== operation.fromState) throw Object.assign(new Error('当前状态不允许 Publish：' + stage?.status), { code: stage?.status === 'published' ? 'AIH_STAGE_LOCKED' : 'AIH_STAGE_UNINITIALIZED' });
  const validation = runProfile(root, manifest, operation.profile);
  const reviewPath = resolve(reviewEvidenceDirectory(root), 'review-evidence.json');
  const reviewRaw = await readFile(reviewPath);
  const review = JSON.parse(reviewRaw.toString('utf8'));
  const reviewSchema = JSON.parse(await readFile(repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/review-evidence.schema.json'), 'utf8'));
  const validateReview = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(reviewSchema);
  if (!validateReview(review)) throw Object.assign(new Error('缺少结构有效的 UI HTML Review Evidence：' + JSON.stringify(validateReview.errors)), { code: 'AIH_CANONICAL_UI_REVIEW_REQUIRED' });
  const inputs = await inputLocks(root, project, manifest);
  const actors = await canonicalLocks(root, project);
  const reviewActors = new Map(review.actors.map((item) => [item.actor, item]));
  const lockedActors = actors.map((actor) => {
    const reviewed = reviewActors.get(actor.actor);
    if (!reviewed || reviewed.draftVersion !== actor.draftVersion || reviewed.implementationHash !== actor.implementationHash || reviewed.buildInputHash !== actor.buildInputs.contentHash) {
      throw Object.assign(new Error('Review 证据与当前冻结 UI HTML 版本不一致：' + actor.actor), { code: 'AIH_CANONICAL_UI_REVIEW_STALE' });
    }
    if (new URL(reviewed.reviewAddress).searchParams.get('review') !== actor.implementationHash.slice('sha256:'.length)) {
      throw Object.assign(new Error('Review 地址未绑定当前冻结 UI HTML 版本：' + actor.actor), { code: 'AIH_CANONICAL_UI_REVIEW_STALE' });
    }
    if (actor.inputs.useCases.version !== inputs.useCases.version || actor.inputs.useCases.contentHash !== inputs.useCases.contentHash || actor.inputs.visualSpec.version !== inputs.visualSpec.version || actor.inputs.visualSpec.contentHash !== inputs.visualSpec.contentHash) {
      throw Object.assign(new Error('UI HTML Draft 上游输入绑定已经漂移：' + actor.actor), { code: 'AIH_CANONICAL_UI_INPUT_DRIFT' });
    }
    return { ...actor, review: { version: review.version, reviewId: review.reviewId, evidenceHash: sha256(reviewRaw), reviewAddress: reviewed.reviewAddress } };
  });
  const receiptPath = repositoryFile(root, operation.receipt);
  const ledger = await readLedger(receiptPath);
  const previous = ledger.history.at(-1);
  if (previous) for (const actor of lockedActors) {
    const old = previous.actors.find((item) => item.actor === actor.actor);
    if (old && !versionIsGreater(actor.draftVersion, old.draftVersion)) throw Object.assign(new Error('Reopen 后必须提升 UI HTML Draft 版本：' + actor.actor), { code: 'AIH_PUBLISH_VERSION_NOT_ADVANCED' });
  }
  const publishedAt = new Date().toISOString();
  const identity = stageIdentity(inputs, lockedActors, review.version);
  const publication = {
    publicationId: 'publish-' + identity.slice('sha256:'.length),
    publishedAt,
    inputLocks: inputs,
    actors: lockedActors,
    reviewVersion: review.version,
    stageIdentityHash: identity,
    credential: '',
  };
  publication.credential = publicationCredential(publication);
  ledger.current = publication;
  project.stages[operation.stage].status = operation.toState;
  await validateLedger(root, ledger);
  await atomicLifecycleWrite(root, project, operation.receipt, ledger);
  return { status: 'PASS', mode: 'publish', stage: operation.stage, publicationId: publication.publicationId, credential: publication.credential, validation, downstreamAction: 'NOT_RUN' };
}

async function reopen(root, project, manifest, operation) {
  const stage = project.stages?.[operation.stage];
  if (stage?.status !== operation.fromState) throw Object.assign(new Error('当前状态不允许 Reopen：' + stage?.status), { code: 'AIH_PROJECT_BINDING_INVALID' });
  const ledger = await readLedger(repositoryFile(root, operation.receipt));
  await validateLedger(root, ledger);
  if (!ledger.current) throw Object.assign(new Error('Reopen 缺少当前发布凭证。'), { code: 'AIH_PUBLISH_RECEIPT_INVALID' });
  ledger.history.push({ ...ledger.current, reopenedAt: new Date().toISOString() });
  ledger.current = null;
  project.stages[operation.stage].status = operation.toState;
  await validateLedger(root, ledger);
  await atomicLifecycleWrite(root, project, operation.receipt, ledger);
  return { status: 'PASS', mode: 'reopen', stage: operation.stage, previousPublicationId: ledger.history.at(-1).publicationId, downstreamAction: 'NOT_RUN' };
}

async function main(root) {
  const { project, manifest } = await loadProjectAndManifest(root);
  const operationId = argument('operation');
  const operation = manifest.operations.find((item) => item.id === operationId && ['publish', 'reopen'].includes(item.kind));
  if (!operation) throw Object.assign(new Error('Manifest 未声明 UI HTML Publish/Reopen operation：' + operationId), { code: 'AIH_CONTRACT_INVALID' });
  return operation.kind === 'publish' ? publish(root, project, manifest, operation) : reopen(root, project, manifest, operation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = await main(defaultRoot); }
  catch (error) { result = { status: 'BLOCKED', blockers: [{ code: error.code || 'AIH_PUBLISH_VALIDATION_FAILED', message: error.message }], ...(error.validation ? { validation: error.validation } : {}) }; }
  if (process.argv.includes('--json') || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
  else console.log('[PASS] UI HTML ' + result.mode + ' 生命周期操作完成。');
  if (result.status !== 'PASS') process.exitCode = 1;
}
