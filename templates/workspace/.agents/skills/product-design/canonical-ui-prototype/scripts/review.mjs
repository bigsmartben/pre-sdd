import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeRegisteredCommand } from '../../../../../.psp/harness/scripts/lib/execute-command.mjs';
import { loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { canonicalLocks, reviewEvidenceDirectory, sha256 } from './integrity.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const markerIndex = process.argv.indexOf('--markers');
const markerPath = markerIndex >= 0 ? process.argv[markerIndex + 1] : null;

function parseJsonOutput(value) {
  try { return JSON.parse(value || '{}'); } catch { return null; }
}

function expectedRoute(category) {
  return { behavior: 'use-cases', 'visual-input': 'visual-spec', implementation: 'canonical-ui-prototype' }[category];
}

async function main() {
  const { project, manifest } = await loadProjectAndManifest(root);
  const operation = manifest.operations.find((item) => item.id === 'canonical-ui-review' && item.kind === 'review');
  const stage = project.stages?.[operation?.stage];
  if (!operation) throw Object.assign(new Error('Manifest 未声明 canonical-ui-review operation。'), { code: 'AIH_CONTRACT_INVALID' });
  if (stage?.status === 'published') throw Object.assign(new Error('已发布 UI HTML 只能查看冻结凭证；新 Review 前必须 Reopen。'), { code: 'AIH_STAGE_LOCKED' });
  if (stage?.status !== 'active') throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  const profile = manifest.validationProfiles.find((item) => item.id === operation.profile);
  if (!profile) throw Object.assign(new Error('Review 引用未知 Profile：' + operation.profile), { code: 'AIH_PROFILE_INVALID' });
  const selected = new Set(profile.commands);
  const commands = manifest.commands.filter((item) => selected.has(item.id));
  const validation = [];
  let failed = false;
  let runtime = null;
  for (const command of commands) {
    if (failed) {
      validation.push({ id: command.id, status: 'NOT_RUN', blockers: [] });
      continue;
    }
    const result = executeRegisteredCommand(root, command, { arguments: command.executor.kind === 'module' ? ['--json'] : [], timeout: 240_000 });
    validation.push({ id: command.id, status: result.status, blockers: result.blockers || [] });
    if (command.id === 'canonical-ui-runtime') runtime = parseJsonOutput(result.stdout);
    if (result.status !== 'PASS') failed = true;
  }
  if (failed) {
    return { status: 'BLOCKED', blockers: validation.flatMap((item) => item.blockers).map((code) => ({ code })), validation };
  }
  const locks = await canonicalLocks(root, project);
  const runtimeActors = new Map((runtime?.reviewAddresses || []).map((item) => [item.actor, item.address]));
  const screenshotsByActor = new Map();
  for (const item of runtime?.evidence || []) {
    if (!item.screenshot) continue;
    const screenshots = screenshotsByActor.get(item.actor) || [];
    screenshots.push(item.screenshot);
    screenshotsByActor.set(item.actor, screenshots);
  }
  const actors = locks.map((item) => {
    const address = runtimeActors.get(item.actor);
    const screenshots = screenshotsByActor.get(item.actor) || [];
    if (!address || screenshots.length === 0) throw Object.assign(new Error('Review 未获得真实运行地址或截图：' + item.actor), { code: 'AIH_CANONICAL_UI_REVIEW_FAILED' });
    const reviewAddress = new URL(address);
    reviewAddress.searchParams.set('review', item.implementationHash.slice('sha256:'.length));
    return {
      actor: item.actor,
      draftVersion: item.draftVersion,
      implementationHash: item.implementationHash,
      buildInputHash: item.buildInputs.contentHash,
      reviewAddress: reviewAddress.href,
      screenshots,
    };
  });
  const markers = markerPath ? JSON.parse(await readFile(resolve(markerPath), 'utf8')) : [];
  for (const marker of markers) if (marker.routedTo !== expectedRoute(marker.category)) {
    throw Object.assign(new Error('Review 反馈路由不一致：' + marker.category + ' → ' + marker.routedTo), { code: 'AIH_CANONICAL_UI_FEEDBACK_ROUTE_INVALID' });
  }
  const identity = sha256(JSON.stringify({ version: operation.evidenceVersion, actors, markers }));
  const evidence = {
    version: operation.evidenceVersion,
    status: 'PASS',
    reviewId: 'review-' + identity.slice('sha256:'.length),
    createdAt: new Date().toISOString(),
    stage: operation.stage,
    actors,
    validation,
    markers,
  };
  const schema = JSON.parse(await readFile(repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/review-evidence.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(schema);
  if (!validate(evidence)) throw Object.assign(new Error('Review Evidence 不符合 Schema：' + JSON.stringify(validate.errors)), { code: 'AIH_CANONICAL_UI_REVIEW_FAILED' });
  const directory = reviewEvidenceDirectory(root);
  await mkdir(directory, { recursive: true });
  const evidencePath = resolve(directory, 'review-evidence.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return { status: 'PASS', reviewId: evidence.reviewId, reviewEvidence: evidencePath, actors: evidence.actors };
}

let result;
try { result = await main(); }
catch (error) { result = { status: 'BLOCKED', blockers: [{ code: error.code || 'AIH_CANONICAL_UI_REVIEW_FAILED', message: error.message }] }; }
if (json || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
else console.log('[PASS] UI HTML Review 完成；证据位于操作系统临时目录。');
if (result.status !== 'PASS') process.exitCode = 1;
