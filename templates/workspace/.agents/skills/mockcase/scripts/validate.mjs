import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  artifactPaths,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from '../../../../.psp/harness/scripts/lib/repository.mjs';
import {
  argument,
  compileSchemas,
  failure,
  jsonText,
  sha256,
  validateSuiteData,
  workspaceContext,
} from './lib.mjs';

async function readJsonIfPresent(root, path) {
  try {
    return { exists: true, text: await readFile(repositoryFile(root, path), 'utf8') };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, text: null };
    throw error;
  }
}

function sameIds(actual, expected) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function evidenceFactsMatch(mode, evidence, runtime) {
  const byKind = (kind) => evidence.facts.filter((item) => item.kind === kind);
  const descriptors = byKind('descriptor');
  if (
    descriptors.length !== 1
    || descriptors[0].descriptor.apiVersion !== runtime.hostApiVersion
    || evidence.hostApiVersion !== runtime.hostApiVersion
  ) return false;
  if (mode === 'verify') {
    const expectedCaseIds = runtime.cases.map((item) => item.id);
    const actualCaseIds = byKind('case').map((item) => item.caseId);
    const routeCount = new Set(runtime.cases.map((item) => item.routeId)).size;
    return evidence.lifecycle === 'VERIFIED'
      && sameIds(actualCaseIds, expectedCaseIds)
      && byKind('dispose').length === routeCount
      && byKind('review-host').length === 0
      && byKind('review-decision').length === 0;
  }
  return evidence.lifecycle === 'READY'
    && byKind('review-host').length === 1
    && byKind('case').length === 0
    && byKind('dispose').length === 0
    && byKind('review-decision').length === 1
    && byKind('review-decision')[0].decision === 'complete';
}

async function lifecycleFor(context) {
  const schemas = await compileSchemas(context.root);
  const runtimeFile = await readJsonIfPresent(context.root, context.files.runtime);
  const evidenceFiles = await Promise.all(['verify', 'review'].map(async (mode) => ({
    mode,
    ...await readJsonIfPresent(context.root, `.psp/evidence/mockcase/${context.actor}/${mode}.json`),
  })));
  if (!runtimeFile.exists) return evidenceFiles.some((item) => item.exists) ? 'STALE' : 'MAPPED';
  let runtime;
  try {
    runtime = JSON.parse(runtimeFile.text);
  } catch {
    return 'STALE';
  }
  if (
    !schemas.runtime(runtime)
    || runtime.sourceDigests.suite !== sha256(jsonText(context.suite))
    || runtime.sourceDigests.mockdata !== context.suite.files['mockdata.json']
    || runtime.sourceDigests.mockcases !== context.suite.files['mockcases.json']
    || runtime.sourceDigests.capabilities !== context.upstream.capabilitiesDigest
    || runtime.sourceDigests.canonicalUi !== context.upstream.canonicalUiDigest
  ) return 'STALE';
  const runtimeDigest = sha256(runtimeFile.text);
  let hasStaleEvidence = false;
  for (const item of evidenceFiles) {
    if (!item.exists) continue;
    let evidence;
    try {
      evidence = JSON.parse(item.text);
    } catch {
      hasStaleEvidence = true;
      continue;
    }
    if (
      !schemas.evidence(evidence)
      || evidence.actor !== context.actor
      || evidence.suiteDigest !== context.suiteDigest
      || evidence.runtimeDigest !== runtimeDigest
      || !evidenceFactsMatch(item.mode, evidence, runtime)
    ) {
      hasStaleEvidence = true;
      continue;
    }
    if (item.mode === 'verify') return 'VERIFIED';
    if (item.mode === 'review') return 'READY';
  }
  return hasStaleEvidence ? 'STALE' : 'MAPPED';
}

let result;
try {
  const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
  const { project } = await loadProjectAndManifest(root);
  const stage = project.stages?.mockcase;
  if (!stage) throw Object.assign(new Error('项目未绑定 mockcase Stage。'), { code: 'AIH_PROJECT_BINDING_INVALID' });
  const requestedActor = argument('--actor');
  if (requestedActor && !/^ACTOR-[0-9]{3}$/.test(requestedActor)) {
    throw Object.assign(new Error('--actor 必须是 ACTOR-NNN。'), { code: 'AIH_SCOPE_UNRESOLVED' });
  }
  if (stage.status === 'uninitialized') {
    result = { status: 'PASS', operation: 'validate-mockcase', lifecycle: 'UNINITIALIZED', actors: [], blockers: [] };
  } else {
    const paths = artifactPaths(project, 'mockcase-suite', 'mockcase');
    let actorIds = requestedActor ? [requestedActor] : [];
    if (!requestedActor) {
      const entries = await readdir(repositoryFile(root, paths.authorityRoot), { withFileTypes: true });
      actorIds = entries.filter((item) => item.isDirectory() && /^ACTOR-[0-9]{3}$/.test(item.name)).map((item) => item.name).sort();
    }
    if (actorIds.length === 0) throw Object.assign(new Error('active Stage 缺少 Actor Suite。'), { code: 'AIH_ARTIFACT_INCOMPLETE' });
    const actors = [];
    for (const actor of actorIds) {
      const context = await workspaceContext(actor, { allowMissingSuite: false });
      await validateSuiteData(context);
      actors.push({ actor, suiteDigest: context.suiteDigest, lifecycle: await lifecycleFor(context) });
    }
    const lifecycles = new Set(actors.map((item) => item.lifecycle));
    const lifecycle = lifecycles.size === 1 ? actors[0].lifecycle : 'STALE';
    result = { status: 'PASS', operation: 'validate-mockcase', lifecycle, actors, blockers: [] };
  }
} catch (error) {
  result = failure(error, 'validate-mockcase');
  if (result.blockers.some((item) => item.code === 'AIH_MOCKCASE_CANDIDATE_STALE')) result.lifecycle = 'STALE';
}
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
