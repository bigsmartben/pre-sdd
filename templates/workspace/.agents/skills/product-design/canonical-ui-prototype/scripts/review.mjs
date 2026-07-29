import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { executeRegisteredCommand } from '../../../../../.psp/harness/scripts/lib/execute-command.mjs';
import { loadProjectAndManifest, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { canonicalLocks, reviewEvidenceDirectory, sha256 } from './integrity.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');

function argumentValues(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === '--' + name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

function parseJsonOutput(value) {
  try { return JSON.parse(value || '{}'); } catch { return null; }
}

function expectedFeedback(issueType) {
  return {
    interaction: { category: 'behavior', routedTo: 'use-cases' },
    visual: { category: 'visual-input', routedTo: 'visual-spec' },
    'position-size': { category: 'implementation', routedTo: 'canonical-ui-prototype' },
    text: { category: 'implementation', routedTo: 'canonical-ui-prototype' },
  }[issueType];
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort(compareText).map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export async function loadReviewFeedback(root, operation, locks, paths = argumentValues('feedback')) {
  if (paths.length === 0) return { feedbackPackets: [], markers: [] };
  if (!operation.feedbackPacketSchema) {
    throw Object.assign(new Error('canonical-ui-review 未登记 Feedback Packet Schema。'), { code: 'AIH_CONTRACT_INVALID' });
  }
  const packetSchema = JSON.parse(await readFile(repositoryFile(root, operation.feedbackPacketSchema), 'utf8'));
  const validatePacket = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(packetSchema);
  const lockByActor = new Map(locks.map((item) => [item.actor, item]));
  const unique = new Map();
  for (const path of paths) {
    let raw;
    let packet;
    try {
      raw = await readFile(resolve(root, path));
      packet = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw Object.assign(new Error('无法读取 Review Feedback Packet：' + error.message), { code: 'AIH_CANONICAL_UI_FEEDBACK_PACKET_INVALID' });
    }
    if (!validatePacket(packet)) {
      const routeInvalid = validatePacket.errors?.some((item) => (
        item.instancePath.includes('/category') || item.instancePath.includes('/routedTo')
      ));
      throw Object.assign(
        new Error('Review Feedback Packet 不符合 Schema：' + JSON.stringify(validatePacket.errors)),
        { code: routeInvalid ? 'AIH_CANONICAL_UI_FEEDBACK_ROUTE_INVALID' : 'AIH_CANONICAL_UI_FEEDBACK_PACKET_INVALID' },
      );
    }
    const lock = lockByActor.get(packet.actor);
    if (!lock || lock.draftVersion !== packet.draftVersion) {
      throw Object.assign(new Error('Review Feedback Packet 不属于当前 Actor Draft：' + packet.actor + '@' + packet.draftVersion), { code: 'AIH_CANONICAL_UI_FEEDBACK_STALE' });
    }
    for (const marker of packet.markers) {
      const expected = expectedFeedback(marker.issueType);
      if (!expected || marker.category !== expected.category || marker.routedTo !== expected.routedTo) {
        throw Object.assign(new Error('Review 反馈路由不一致：' + marker.issueType + ' → ' + marker.category + '/' + marker.routedTo), { code: 'AIH_CANONICAL_UI_FEEDBACK_ROUTE_INVALID' });
      }
    }
    const contentHash = sha256(JSON.stringify(canonicalize(packet)));
    unique.set(contentHash, { contentHash, packet });
  }

  const normalized = [...unique.values()].sort((left, right) => compareText(left.contentHash, right.contentHash));
  const feedbackPackets = normalized.map(({ contentHash, packet }) => ({
    contentHash,
    actor: packet.actor,
    draftVersion: packet.draftVersion,
    createdAt: packet.createdAt,
    pageUrl: packet.pageUrl,
    pageKey: packet.pageKey,
    viewport: packet.viewport,
    markerCount: packet.markers.length,
  }));
  const markers = normalized.flatMap(({ contentHash, packet }) => packet.markers.map((marker) => ({
    packetHash: contentHash,
    markerId: marker.id,
    actor: packet.actor,
    pageUrl: packet.pageUrl,
    pageKey: packet.pageKey,
    viewport: packet.viewport,
    issueType: marker.issueType,
    category: marker.category,
    routedTo: marker.routedTo,
    description: marker.description,
    target: marker.target,
    rect: marker.rect,
  }))).sort((left, right) => compareText(left.packetHash, right.packetHash) || left.markerId - right.markerId);
  return { feedbackPackets, markers };
}

export function reviewIdentity(version, actors, feedback) {
  return sha256(JSON.stringify({
    version,
    actors,
    feedbackPackets: feedback.feedbackPackets,
    markers: feedback.markers,
  }));
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
  const locks = await canonicalLocks(root, project);
  const feedback = await loadReviewFeedback(root, operation, locks);
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
    const parsed = parseJsonOutput(result.stdout);
    validation.push({
      id: command.id,
      status: result.status,
      blockers: result.blockers || [],
      ...(result.status !== 'PASS' && parsed?.blockers ? { details: parsed.blockers } : {}),
    });
    if (command.id === 'canonical-ui-runtime') runtime = parseJsonOutput(result.stdout);
    if (result.status !== 'PASS') failed = true;
  }
  if (failed) {
    return { status: 'BLOCKED', blockers: validation.flatMap((item) => item.blockers).map((code) => ({ code })), validation };
  }
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
    reviewAddress.searchParams.set('review', '1');
    return {
      actor: item.actor,
      draftVersion: item.draftVersion,
      implementationHash: item.implementationHash,
      buildInputHash: item.buildInputs.contentHash,
      reviewAddress: reviewAddress.href,
      screenshots,
    };
  });
  const identity = reviewIdentity(operation.evidenceVersion, actors, feedback);
  const evidence = {
    version: operation.evidenceVersion,
    status: 'PASS',
    reviewId: 'review-' + identity.slice('sha256:'.length),
    createdAt: new Date().toISOString(),
    stage: operation.stage,
    actors,
    validation,
    feedbackPackets: feedback.feedbackPackets,
    markers: feedback.markers,
  };
  const schema = JSON.parse(await readFile(repositoryFile(root, '.agents/skills/product-design/canonical-ui-prototype/review-evidence.schema.json'), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false, formats: { 'date-time': true } }).compile(schema);
  if (!validate(evidence)) throw Object.assign(new Error('Review Evidence 不符合 Schema：' + JSON.stringify(validate.errors)), { code: 'AIH_CANONICAL_UI_REVIEW_FAILED' });
  const directory = reviewEvidenceDirectory(root);
  await mkdir(directory, { recursive: true });
  const evidencePath = resolve(directory, 'review-evidence.json');
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', 'utf8');
  return {
    status: 'PASS',
    reviewId: evidence.reviewId,
    reviewEvidence: evidencePath,
    feedbackPacketCount: evidence.feedbackPackets.length,
    actors: evidence.actors,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try { result = await main(); }
  catch (error) { result = { status: 'BLOCKED', blockers: [{ code: error.code || 'AIH_CANONICAL_UI_REVIEW_FAILED', message: error.message }] }; }
  if (json || result.status !== 'PASS') console.log(JSON.stringify(result, null, 2));
  else console.log('[PASS] UI HTML Review 完成；证据位于操作系统临时目录。');
  if (result.status !== 'PASS') process.exitCode = 1;
}
