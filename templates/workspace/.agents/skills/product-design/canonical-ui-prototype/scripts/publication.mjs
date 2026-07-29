import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { stringify as stringifyYaml } from 'yaml';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../../runtime/project.mjs';
import { canonicalLocks, inputLocks, reviewEvidenceDirectory, sha256 } from './integrity.mjs';
import { extractCanonicalUi } from './extract.mjs';
import { verifyVisualAcceptance, visualAcceptanceRecordPath } from './visual-acceptance.mjs';

const defaultRoot = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const PUBLICATION_ACTIONS = {
  'publish-product-design': {
    kind: 'publish',
    stage: 'product-design',
    fromState: 'active',
    toState: 'published',
  },
  'reopen-product-design': {
    kind: 'reopen',
    stage: 'product-design',
    fromState: 'published',
    toState: 'active',
  },
};

function argument(name) {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readLedger(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: '3.0.0', stage: 'product-design', current: null, history: [] }; throw error; }
}

function publicationCore(inputLocksValue, actors, reviewVersion, visualAcceptance) {
  return { inputLocks: inputLocksValue, actors, reviewVersion, visualAcceptance };
}

function publicationCredential(publication) {
  const { credential, reopenedAt, ...core } = publication;
  return sha256(JSON.stringify(core));
}

function stageIdentity(inputLocksValue, actors, reviewVersion, visualAcceptance) {
  return sha256(JSON.stringify(publicationCore(inputLocksValue, actors, reviewVersion, visualAcceptance)));
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

function runPublicationChecks(root) {
  const checks = [
    ['product-structure', '.agents/skills/product-design/scripts/validate.mjs', ['--json']],
    ['canonical-ui-input', '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-input.mjs', ['--json']],
    ['canonical-ui-typecheck', '.agents/skills/product-design/canonical-ui-prototype/scripts/runtime.mjs', ['--capability', 'typecheck', '--json']],
    ['canonical-ui-build', '.agents/skills/product-design/canonical-ui-prototype/scripts/runtime.mjs', ['--capability', 'build', '--json']],
    ['canonical-ui-contract-tests', '.agents/skills/product-design/canonical-ui-prototype/scripts/test-components.mjs', ['--json']],
    ['canonical-ui-runtime', '.agents/skills/product-design/canonical-ui-prototype/scripts/validate-runtime.mjs', ['--json']],
    ['ui-case-verify', '.agents/skills/ui-case-mock/scripts/verify.mjs', ['--json']],
    ['product-strict', '.agents/skills/product-design/scripts/validate.mjs', ['--strict', '--json']],
  ];
  const validation = [];
  let failed = false;
  for (const [id, path, args] of checks) {
    if (failed) {
      validation.push({ id, status: 'NOT_RUN', blockers: [] });
      continue;
    }
    const execution = spawnSync(process.execPath, [repositoryFile(root, path), ...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
      timeout: 240_000,
      windowsHide: true,
    });
    const status = execution.status === 0 ? 'PASS' : 'FAIL';
    validation.push({
      id,
      status,
      blockers: status === 'PASS' ? [] : ['AIH_PUBLISH_VALIDATION_FAILED'],
    });
    if (status !== 'PASS') failed = true;
  }
  if (failed) throw Object.assign(new Error('Product Design 发布检查未通过。'), {
    code: 'AIH_PUBLISH_VALIDATION_FAILED',
    validation,
  });
  return validation;
}

export async function verifyPublishedProduct(root, project) {
  const stage = project.stages?.['product-design'];
  if (stage?.status !== 'published') return [];
  const blockers = [];
  try {
    const receiptPath = stage.publication?.receipt;
    const ledger = await readLedger(repositoryFile(root, receiptPath));
    await validateLedger(root, ledger);
    if (!ledger.current) throw Object.assign(new Error('published 阶段缺少当前发布凭证。'), { code: 'AIH_PUBLISH_RECEIPT_INVALID' });
    const currentInputs = await inputLocks(root, project);
    const currentActors = await canonicalLocks(root, project);
    if (currentActors.length !== ledger.current.actors.length) throw Object.assign(new Error('已锁定 UI HTML Actor 集合发生漂移。'), { code: 'AIH_PUBLISH_CREDENTIAL_STALE' });
    const lockedActors = ledger.current.actors.map((locked) => {
      const current = currentActors.find((item) => item.actor === locked.actor);
      if (!current) throw Object.assign(new Error('已锁定 UI HTML Actor 缺失：' + locked.actor), { code: 'AIH_PUBLISH_CREDENTIAL_STALE' });
      return { ...current, review: locked.review };
    });
    for (const item of await verifyVisualAcceptance(root, project, { markStale: true })) blockers.push(item);
    const identity = stageIdentity(currentInputs, lockedActors, ledger.current.reviewVersion, ledger.current.visualAcceptance);
    if (identity !== ledger.current.stageIdentityHash || publicationCredential(ledger.current) !== ledger.current.credential) {
      throw Object.assign(new Error('已锁定 UC、Visual Spec、Asset、UI HTML 或 Review 身份发生漂移。'), { code: 'AIH_PUBLISH_CREDENTIAL_STALE' });
    }
  } catch (error) {
    blockers.push({ code: error.code || 'AIH_PUBLISH_RECEIPT_INVALID', message: error.message });
  }
  return blockers;
}

async function publish(root, project, operation) {
  const stage = project.stages?.[operation.stage];
  if (stage?.status !== operation.fromState) throw Object.assign(new Error('当前状态不允许 Publish：' + stage?.status), { code: stage?.status === 'published' ? 'AIH_STAGE_LOCKED' : 'AIH_STAGE_UNINITIALIZED' });
  const validation = runPublicationChecks(root);
  const acceptanceBlockers = await verifyVisualAcceptance(root, project, { markStale: true });
  if (acceptanceBlockers.length > 0) throw Object.assign(new Error(acceptanceBlockers[0].message), { code: acceptanceBlockers[0].code, validation });
  const reviewPath = resolve(reviewEvidenceDirectory(root), 'review-evidence.json');
  const reviewRaw = await readFile(reviewPath);
  const review = JSON.parse(reviewRaw.toString('utf8'));
  const reviewSchema = JSON.parse(await readFile(repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/review-evidence.schema.json'), 'utf8'));
  const validateReview = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(reviewSchema);
  if (!validateReview(review)) throw Object.assign(new Error('缺少结构有效的 UI HTML Review Evidence：' + JSON.stringify(validateReview.errors)), { code: 'AIH_CANONICAL_UI_REVIEW_REQUIRED' });
  const inputs = await inputLocks(root, project);
  const actors = await canonicalLocks(root, project);
  const reviewActors = new Map(review.actors.map((item) => [item.actor, item]));
  const lockedActors = actors.map((actor) => {
    const reviewed = reviewActors.get(actor.actor);
    if (!reviewed || reviewed.draftVersion !== actor.draftVersion || reviewed.implementationHash !== actor.implementationHash || reviewed.buildInputHash !== actor.buildInputs.contentHash) {
      throw Object.assign(new Error('Review 证据与当前冻结 UI HTML 版本不一致：' + actor.actor), { code: 'AIH_CANONICAL_UI_REVIEW_STALE' });
    }
    if (new URL(reviewed.reviewAddress).searchParams.get('review') !== '1') {
      throw Object.assign(new Error('Review 地址未使用统一 review=1 开关：' + actor.actor), { code: 'AIH_CANONICAL_UI_REVIEW_STALE' });
    }
    if (actor.inputs.useCases.version !== inputs.useCases.version || actor.inputs.useCases.contentHash !== inputs.useCases.contentHash || actor.inputs.visualSpec.version !== inputs.visualSpec.version || actor.inputs.visualSpec.contentHash !== inputs.visualSpec.contentHash) {
      throw Object.assign(new Error('UI HTML Draft 上游输入绑定已经漂移：' + actor.actor), { code: 'AIH_CANONICAL_UI_INPUT_DRIFT' });
    }
    return { ...actor, review: { version: review.version, reviewId: review.reviewId, evidenceHash: sha256(reviewRaw), reviewAddress: reviewed.reviewAddress } };
  });
  const receiptPath = repositoryFile(root, project.stages[operation.stage].publication.receipt);
  const ledger = await readLedger(receiptPath);
  const previous = ledger.history.at(-1);
  if (previous) for (const actor of lockedActors) {
    const old = previous.actors.find((item) => item.actor === actor.actor);
    if (old && !versionIsGreater(actor.draftVersion, old.draftVersion)) throw Object.assign(new Error('Reopen 后必须提升 UI HTML Draft 版本：' + actor.actor), { code: 'AIH_PUBLISH_VERSION_NOT_ADVANCED' });
  }
  const publishedAt = new Date().toISOString();
  const exactRequired = (await Promise.all(actors.map(async (actor) => {
    const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
    return extractCanonicalUi(root, paths.authorityRoot + '/' + actor.actor + '/src/spec/canonical-ui.ts');
  }))).some((model) => model.visualPolicy.mode === 'exact');
  let visualAcceptance = null;
  if (exactRequired) {
    const acceptancePath = visualAcceptanceRecordPath(root);
    const acceptanceRaw = await readFile(acceptancePath);
    const acceptance = JSON.parse(acceptanceRaw.toString('utf8'));
    visualAcceptance = {
      path: '.psp/reviews/product-design-visual-acceptance.json',
      evidenceHash: sha256(acceptanceRaw),
      scopeHash: acceptance.scopeHash,
      acceptedBy: acceptance.acceptedBy,
      acceptedAt: acceptance.acceptedAt,
    };
  }
  const identity = stageIdentity(inputs, lockedActors, review.version, visualAcceptance);
  const publication = {
    publicationId: 'publish-' + identity.slice('sha256:'.length),
    publishedAt,
    inputLocks: inputs,
    actors: lockedActors,
    reviewVersion: review.version,
    visualAcceptance,
    stageIdentityHash: identity,
    credential: '',
  };
  publication.credential = publicationCredential(publication);
  ledger.current = publication;
  project.stages[operation.stage].status = operation.toState;
  await validateLedger(root, ledger);
  await atomicLifecycleWrite(root, project, project.stages[operation.stage].publication.receipt, ledger);
  return { status: 'PASS', mode: 'publish', stage: operation.stage, publicationId: publication.publicationId, credential: publication.credential, validation, downstreamAction: 'NOT_RUN' };
}

async function reopen(root, project, operation) {
  const stage = project.stages?.[operation.stage];
  if (stage?.status !== operation.fromState) throw Object.assign(new Error('当前状态不允许 Reopen：' + stage?.status), { code: 'AIH_PROJECT_BINDING_INVALID' });
  const receiptPath = project.stages[operation.stage].publication.receipt;
  const ledger = await readLedger(repositoryFile(root, receiptPath));
  await validateLedger(root, ledger);
  if (!ledger.current) throw Object.assign(new Error('Reopen 缺少当前发布凭证。'), { code: 'AIH_PUBLISH_RECEIPT_INVALID' });
  ledger.history.push({ ...ledger.current, reopenedAt: new Date().toISOString() });
  ledger.current = null;
  project.stages[operation.stage].status = operation.toState;
  await validateLedger(root, ledger);
  await atomicLifecycleWrite(root, project, receiptPath, ledger);
  return { status: 'PASS', mode: 'reopen', stage: operation.stage, previousPublicationId: ledger.history.at(-1).publicationId, downstreamAction: 'NOT_RUN' };
}

async function main(root) {
  const project = await loadProject(root);
  const operationId = argument('operation');
  const operation = PUBLICATION_ACTIONS[operationId];
  if (!operation) throw Object.assign(new Error('Product Design 不支持该发布动作：' + operationId), { code: 'AIH_CONTRACT_INVALID' });
  return operation.kind === 'publish' ? publish(root, project, operation) : reopen(root, project, operation);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = await main(defaultRoot); }
  catch (error) { result = { status: 'BLOCKED', blockers: [{ code: error.code || 'AIH_PUBLISH_VALIDATION_FAILED', message: error.message }], ...(error.validation ? { validation: error.validation } : {}) }; }
  if (process.argv.includes('--json') || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
  else console.log('[PASS] UI HTML ' + result.mode + ' 生命周期操作完成。');
  if (result.status !== 'PASS') process.exitCode = 1;
}
