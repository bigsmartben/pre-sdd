import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import {
  ARTIFACTS, argument, collectSourceClosure, readArtifact, report, sameLock, sha256, validateSchema,
} from './lib/core.mjs';

const previewProfiles = {
  android: { runtimeProfile: 'android-emulator-fixed', buildPath: 'build/app/outputs/flutter-apk/app-debug.apk' },
  ios: { runtimeProfile: 'ios-simulator-fixed', buildPath: 'build/ios/iphonesimulator/Runner.app' },
  web: { runtimeProfile: 'web-chrome-fixed', buildPath: 'build/web' },
};

export async function validateWorkspace(root, phase = 'coverage', scaffold = false, allowResolvedFindings = false, allowOpenFindings = false) {
  const blockers = [];
  if (scaffold) {
    for (const item of Object.values(ARTIFACTS)) JSON.parse(await readFile(repositoryFile(root, item.schema), 'utf8'));
    return blockers;
  }
  const figmaValidator = resolve(import.meta.dirname, '../../figma-evidence/scripts/validate.mjs');
  const freshnessPath = process.env.PSP_FIGMA_FRESHNESS_PATH;
  const figmaArgs = [figmaValidator, '--json'];
  if (freshnessPath) figmaArgs.push('--figma-freshness', freshnessPath);
  const figmaResult = spawnSync(process.execPath, figmaArgs, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PSP_REPOSITORY_ROOT: root },
  });
  if (figmaResult.status !== 0) blockers.push({
    code: 'FLUTTER_FIGMA_SOURCE_STALE',
    message: figmaResult.stdout || figmaResult.stderr || '当前 Figma freshness 未通过。',
  });
  const project = await loadProject(root);
  const path = (stage, id) => artifactPaths(project, id, stage)?.authorityPath;
  const load = async (stage, definition, required = true) => {
    const authorityPath = path(stage, definition.id);
    if (!authorityPath) {
      if (required) blockers.push({ code: 'FLUTTER_REGISTRY_INVALID', message: `${stage}.${definition.id} 未注册正式路径。` });
      return null;
    }
    try {
      const artifact = await readArtifact(root, authorityPath);
      blockers.push(...await validateSchema(root, definition.schema, artifact.data));
      return artifact;
    } catch (error) {
      if (required || error.code !== 'ENOENT') blockers.push({ code: error.code || 'FLUTTER_ARTIFACT_MISSING', message: error.message });
      return null;
    }
  };

  const checklist = await readArtifact(root, path('visual-spec', 'checklist'));
  const authorization = await readArtifact(root, path('visual-spec', 'ready-authorization'));
  const figmaCoverage = await readArtifact(root, path('figma-evidence', 'figma-coverage'));
  const figmaEvidence = await readArtifact(root, path('figma-evidence', 'figma-evidence'));
  const l1 = await load('flutter-ui', ARTIFACTS.l1);
  let closure = null;
  try { closure = await collectSourceClosure(root); } catch (error) { blockers.push({ code: error.code, message: error.message }); }
  if (!l1) return blockers;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const currentCommit = head.status === 0 ? head.stdout.trim() : null;
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=all', '--', 'lib/ui', 'lib/adapters/contracts', 'lib/adapters/real', 'lib/main.dart', 'pubspec.yaml', 'pubspec.lock', 'android', 'ios', 'web'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (dirty.status !== 0 || dirty.stdout.trim()) blockers.push({ code: 'FLUTTER_SOURCE_COMMIT_MISMATCH', message: 'Flutter Source Closure 存在未提交或未跟踪输入。' });
  if (!currentCommit || !currentCommit.startsWith(l1.data.source?.commit ?? '')) blockers.push({ code: 'FLUTTER_SOURCE_COMMIT_MISMATCH', message: 'L1 source.commit 不是当前 Git HEAD。' });
  if (l1.data.metadata?.status !== 'ready') blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: 'L1 Coverage metadata 必须 ready。' });
  if ([checklist.data.metadata?.status, figmaCoverage.data.metadata?.status, figmaEvidence.data.metadata?.status].some((status) => status !== 'ready') || authorization.data.status !== 'ready') {
    blockers.push({ code: 'FLUTTER_SOURCE_NOT_READY', message: 'Checklist、Ready Authorization 与 Figma Evidence 必须 ready。' });
  }
  if ((checklist.data.gaps ?? []).length || (figmaCoverage.data.gaps ?? []).length || (figmaEvidence.data.gaps ?? []).length) {
    blockers.push({ code: 'FLUTTER_SOURCE_NOT_READY', message: '上游仍有 Gap。' });
  }
  const expectedL1Locks = new Map([
    ['VISUAL-SPEC-READY-AUTHORIZATION', authorization], ['FIGMA-COVERAGE', figmaCoverage], ['FIGMA-EVIDENCE', figmaEvidence],
  ]);
  for (const [id, artifact] of expectedL1Locks) {
    const lock = l1.data.sourceLocks?.find((entry) => entry.artifactId === id);
    if (!sameLock(lock, artifact)) blockers.push({ code: 'FLUTTER_SOURCE_DIGEST_STALE', message: `L1 未锁定当前 ${id}。` });
  }
  if (closure && l1.data.source?.digest !== closure.digest) blockers.push({ code: 'FLUTTER_SOURCE_DIGEST_STALE', message: 'L1 未锁定当前 Flutter Source Closure。' });
  const closurePaths = new Set(closure?.files.map((entry) => entry.path));
  const closureByPath = new Map((closure?.files ?? []).map((entry) => [entry.path, entry]));
  const checklistById = new Map((checklist.data.items ?? []).map((item) => [item.itemId, item]));
  const l1ById = new Map((l1.data.items ?? []).map((item) => [item.itemId, item]));
  if (l1ById.size !== (l1.data.items ?? []).length || l1ById.size !== checklistById.size) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: 'L1 与 Checklist 项集合不一致或重复。' });
  for (const [itemId, expected] of checklistById) {
    const actual = l1ById.get(itemId);
    if (!actual || actual.status !== 'accepted') {
      blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: `L1 未 accepted：${itemId}` });
      continue;
    }
    for (const sourcePath of actual.sourcePaths) if (!closurePaths.has(sourcePath)) blockers.push({ code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE', message: `${itemId} 源码未进入闭包：${sourcePath}` });
    for (const [required, covered] of [['viewports', 'viewports'], ['states', 'states'], ['variants', 'variants'], ['contentCases', 'contentCases'], ['tokens', 'tokenRefs'], ['assets', 'assetRefs'], ['motions', 'motionRefs']]) {
      for (const value of expected.dimensions?.[required] ?? []) if (!actual[covered]?.includes(value)) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: `${itemId} 缺少 ${required}:${value}` });
    }
  }
  const requiredDependencies = new Map();
  for (const item of checklist.data.items ?? []) {
    for (const ref of item.dimensions?.tokens ?? []) requiredDependencies.set(ref, new Set([...(requiredDependencies.get(ref) ?? []), 'token']));
    for (const ref of item.dimensions?.assets ?? []) requiredDependencies.set(ref, new Set([...(requiredDependencies.get(ref) ?? []), 'asset', 'font']));
    for (const ref of item.dimensions?.motions ?? []) requiredDependencies.set(ref, new Set([...(requiredDependencies.get(ref) ?? []), 'motion']));
  }
  const dependencies = new Map((l1.data.dependencies ?? []).map((entry) => [entry.ref, entry]));
  if (dependencies.size !== (l1.data.dependencies ?? []).length) blockers.push({ code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE', message: 'L1 Dependency ref 重复。' });
  for (const [ref, allowedKinds] of requiredDependencies) {
    const dependency = dependencies.get(ref);
    const file = dependency ? closureByPath.get(dependency.path) : null;
    if (!dependency || !allowedKinds.has(dependency.kind) || !file || file.digest !== dependency.digest || file.role !== dependency.kind) blockers.push({ code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE', message: `Asset/Font/Token/Motion 未闭合：${ref}` });
  }
  for (const ref of dependencies.keys()) if (!requiredDependencies.has(ref)) blockers.push({ code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE', message: `L1 声明了未被 Checklist 使用的依赖：${ref}` });
  if ((l1.data.gaps ?? []).length) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: 'L1 Coverage 仍有 Gap。' });

  const needsL2 = [...checklistById.values()].some((item) => item.requiredDeliveryLevel === 'USER_PATH');
  const l2 = await load('flutter-ui', ARTIFACTS.l2, needsL2);
  if (needsL2 && l2) {
    const plan = await readArtifact(root, path('user-path-cases', 'user-path-plan'));
    const mock = await readArtifact(root, path('mockcase', 'mock-scenario-suite'));
    const expected = new Map([['USER-PATH-PLAN', plan], ['FLUTTER-VISUAL-COVERAGE', l1], ['MOCK-SCENARIO-SUITE', mock]]);
    if (l2.data.metadata?.status !== 'ready') blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: 'L2 Coverage metadata 必须 ready。' });
    if (l2.data.source?.commit !== l1.data.source?.commit) blockers.push({ code: 'FLUTTER_SOURCE_COMMIT_MISMATCH', message: 'L2 与 L1 source.commit 不一致。' });
    for (const [id, artifact] of expected) if (!sameLock(l2.data.sourceLocks?.find((entry) => entry.artifactId === id), artifact)) blockers.push({ code: 'FLUTTER_SOURCE_DIGEST_STALE', message: `L2 未锁定当前 ${id}。` });
    if (l2.data.source?.digest !== l1.data.source?.digest || l2.data.source?.digest !== closure?.digest) blockers.push({ code: 'FLUTTER_SOURCE_DIGEST_STALE', message: 'L2、L1 与源码闭包不一致。' });
    const planned = new Map((plan.data.paths ?? []).map((entry) => [entry.pathId, entry]));
    const actual = new Map((l2.data.paths ?? []).map((entry) => [entry.pathId, entry]));
    const scenarios = new Map((mock.data.scenarios ?? []).map((entry) => [entry.scenarioId, entry]));
    if (actual.size !== (l2.data.paths ?? []).length || actual.size !== planned.size) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: 'L2 与 User Path Plan 路径集合不一致或重复。' });
    for (const [id, pathPlan] of planned) {
      const coverage = actual.get(id);
      if (!coverage || coverage.status !== 'accepted' || coverage.steps.some((step) => !step.passed)) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: `L2 未 accepted：${id}` });
      if (coverage && (pathPlan.steps.length !== coverage.steps.length || coverage.testCaseRef !== pathPlan.testCaseRef || JSON.stringify([...coverage.checklistItemRefs].sort()) !== JSON.stringify([...pathPlan.checklistItemRefs].sort()))) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: `L2 路径身份不完整：${id}` });
      const plannedSteps = new Map(pathPlan.steps.map((entry) => [entry.pathStepId, entry]));
      for (const step of coverage?.steps ?? []) {
        const expectedStep = plannedSteps.get(step.pathStepId);
        const scenario = scenarios.get(step.scenario);
        const fixtureIds = new Set((scenario?.fixtures ?? []).map((fixture) => fixture.fixtureId));
        if (!expectedStep || step.action !== expectedStep.action || step.checkpoint !== expectedStep.checkpoint || step.assertion !== expectedStep.assertion || !pathPlan.scenarioSlots.includes(step.scenario)) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: `L2 Step 未闭合到 Path Plan：${step.pathStepId}` });
        if (!scenario || scenario.status !== 'ready' || step.fixtureRefs.some((ref) => !fixtureIds.has(ref))) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: `L2 Step 未闭合到 Ready Mock：${step.pathStepId}` });
        for (const sourcePath of step.sourcePaths) if (!sourcePath.startsWith('lib/ui/') || !closurePaths.has(sourcePath)) blockers.push({ code: 'FLUTTER_SOURCE_CLOSURE_INCOMPLETE', message: `L2 Step 未引用真实 lib/ui/**：${step.pathStepId}` });
      }
    }
    if ((l2.data.gaps ?? []).length) blockers.push({ code: 'FLUTTER_COVERAGE_INCOMPLETE', message: 'L2 Coverage 仍有 Gap。' });
  }

  if (['preview', 'manifest'].includes(phase)) {
    const preview = await load('flutter-ui', ARTIFACTS.preview);
    const findings = await load('flutter-ui', ARTIFACTS.findings);
    if (preview) {
      if (!['built', 'reviewing', 'accepted'].includes(preview.data.metadata?.status) || preview.data.preview?.acceptanceStatus === 'stale') blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: 'Preview 状态已 stale 或不可用于当前阶段。' });
      if (preview.data.source?.commit !== l1.data.source?.commit || !currentCommit?.startsWith(preview.data.source?.commit ?? '')) blockers.push({ code: 'FLUTTER_SOURCE_COMMIT_MISMATCH', message: 'Preview source.commit 未绑定当前 L1/Git HEAD。' });
      if (preview.data.source?.digest !== closure?.digest) blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: 'Preview 未锁定当前源码。' });
      const expectedProfile = previewProfiles[preview.data.preview?.target];
      if (!expectedProfile || preview.data.preview.runtimeProfile !== expectedProfile.runtimeProfile || preview.data.preview.buildPath !== expectedProfile.buildPath) blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: 'Preview target、runtimeProfile 与 buildPath 不一致。' });
      const expectedCoverage = new Map([['FLUTTER-VISUAL-COVERAGE', l1], ...(needsL2 && l2 ? [['FLUTTER-USER-PATH-COVERAGE', l2]] : [])]);
      for (const [id, artifact] of expectedCoverage) if (!sameLock(preview.data.coverageLocks?.find((entry) => entry.artifactId === id), artifact)) blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: `Preview 未锁定当前 ${id}。` });
      if (new Set(preview.data.coverageLocks?.map((entry) => entry.artifactId)).size !== expectedCoverage.size || preview.data.coverageLocks?.length !== expectedCoverage.size) blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: 'Preview Coverage Lock 集合包含重复、遗漏或额外输入。' });
      try {
        const { hashPath } = await import('./lib/core.mjs');
        if (await hashPath(root, preview.data.preview.buildPath) !== preview.data.preview.buildDigest) blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: 'Preview Build digest 已漂移。' });
        if (await hashPath(root, 'lib/review') !== preview.data.preview.reviewAdapterDigest) blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: 'Review Adapter digest 已漂移。' });
      } catch (error) { blockers.push({ code: error.code || 'FLUTTER_PREVIEW_STALE', message: error.message }); }
    }
    if (preview && findings && !sameLock(findings.data.previewLock, preview)) blockers.push({ code: 'FLUTTER_PREVIEW_STALE', message: 'Finding Context 未锁定当前 Preview。' });
    if (preview && findings) {
      const expectedFindingStatus = findings.data.findings.every((entry) => entry.status === 'closed') ? 'clear' : 'active';
      if (findings.data.metadata?.status !== expectedFindingStatus) blockers.push({ code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE', message: 'REVIEW-FINDINGS metadata 状态与 Finding 集合不一致。' });
      const figmaRefs = new Set([
        ...(figmaCoverage.data.items ?? []).flatMap((item) => (item.anchors ?? []).map((anchor) => anchor.nodeId)),
        ...(figmaEvidence.data.assets ?? []).map((item) => item.assetId),
        ...(figmaEvidence.data.tokens ?? []).map((item) => item.tokenId),
        ...(figmaEvidence.data.motions ?? []).map((item) => item.motionId),
      ]);
      for (const finding of findings.data.findings ?? []) {
        if (!['open', 'triaged', 'repairing'].includes(finding.status)) continue;
        const item = l1ById.get(finding.itemId);
        if (!item || item.route !== finding.route || item.page !== finding.page || item.widgetId !== finding.widgetId || !item.states.includes(finding.state) || !item.viewports.includes(finding.viewport)) blockers.push({ code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE', message: `${finding.findingId} 未闭合到当前 L1 Widget/State/Viewport。` });
        if (finding.source.commit !== preview.data.source.commit || finding.source.digest !== preview.data.source.digest || finding.preview.target !== preview.data.preview.target || finding.preview.runtimeProfile !== preview.data.preview.runtimeProfile || finding.preview.buildDigest !== preview.data.preview.buildDigest) blockers.push({ code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE', message: `${finding.findingId} 未闭合到当前 Flutter Source/Preview。` });
        if (finding.figmaEvidenceRefs.some((ref) => !figmaRefs.has(ref))) blockers.push({ code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE', message: `${finding.findingId} 引用未知 Figma Evidence。` });
        if (finding.level === 'L2' && !(l2?.data.paths ?? []).some((entry) => entry.testCaseRef === finding.testCaseId && entry.checklistItemRefs.includes(finding.itemId) && entry.steps.some((step) => step.pathStepId === finding.pathStepId))) blockers.push({ code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE', message: `${finding.findingId} 未闭合到当前 L2 Test Case/Step。` });
        try {
          if (sha256(await readFile(repositoryFile(root, finding.evidence.path))) !== finding.evidence.digest) blockers.push({ code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE', message: `${finding.findingId} 复现证据 digest 已漂移。` });
        } catch (error) { blockers.push({ code: 'FLUTTER_FINDING_CONTEXT_INCOMPLETE', message: `${finding.findingId} 复现证据不可读：${error.message}` }); }
      }
    }
    if (!allowOpenFindings && findings?.data.findings?.some((entry) => ['Blocker', 'Major'].includes(entry.severity) && entry.status !== 'closed' && !(allowResolvedFindings && ['resolved', 'verified'].includes(entry.status)))) blockers.push({ code: 'FLUTTER_FINDING_OPEN', message: '存在开放的 Blocker/Major Finding。' });
    if (phase === 'manifest') {
      if (preview?.data.metadata?.status !== 'accepted' || preview?.data.preview?.acceptanceStatus !== 'accepted') blockers.push({ code: 'FLUTTER_PREVIEW_NOT_ACCEPTED', message: '所选 target Preview 未人工 accepted。' });
      const manifest = await load('flutter-ui', ARTIFACTS.manifest);
      if (manifest) {
        if (manifest.data.metadata?.status !== 'accepted') blockers.push({ code: 'FLUTTER_MANIFEST_INCOMPLETE', message: 'Manifest 状态不是 accepted。' });
        if (manifest.data.source?.commit !== preview.data.source?.commit) blockers.push({ code: 'FLUTTER_SOURCE_COMMIT_MISMATCH', message: 'Manifest source.commit 未绑定当前 Preview。' });
        if (manifest.data.source?.digest !== closure?.digest) blockers.push({ code: 'FLUTTER_SOURCE_DIGEST_STALE', message: 'Manifest 源码摘要已 stale。' });
        const byPath = new Map(manifest.data.closure.map((entry) => [entry.path, entry]));
        if (byPath.size !== manifest.data.closure.length || byPath.size !== closure?.files.length) blockers.push({ code: 'FLUTTER_MANIFEST_INCOMPLETE', message: 'Manifest 闭包存在重复、遗漏或未声明文件。' });
        for (const file of closure?.files ?? []) if (byPath.get(file.path)?.digest !== file.digest) blockers.push({ code: 'FLUTTER_MANIFEST_INCOMPLETE', message: `Manifest 闭包缺少或漂移：${file.path}` });
        const expectedArtifacts = new Map([['FLUTTER-VISUAL-COVERAGE', l1], ...(needsL2 && l2 ? [['FLUTTER-USER-PATH-COVERAGE', l2]] : []), ['FLUTTER-UI-PREVIEW', preview], ['REVIEW-FINDINGS', findings]]);
        for (const [id, artifact] of expectedArtifacts) if (!sameLock(manifest.data.artifactLocks.find((entry) => entry.artifactId === id), artifact)) blockers.push({ code: 'FLUTTER_MANIFEST_INCOMPLETE', message: `Manifest 未锁定当前 ${id}。` });
        if (manifest.data.artifactLocks.length !== expectedArtifacts.size) blockers.push({ code: 'FLUTTER_MANIFEST_INCOMPLETE', message: 'Manifest Artifact Lock 集合不完整或包含额外输入。' });
        const selected = manifest.data.selectedPreview;
        if (selected.target !== preview.data.preview.target || selected.runtimeProfile !== preview.data.preview.runtimeProfile || selected.sourceDigest !== preview.data.source.digest || selected.buildDigest !== preview.data.preview.buildDigest || selected.acceptedBy !== preview.data.preview.acceptedBy || selected.acceptedAt !== preview.data.preview.acceptedAt) blockers.push({ code: 'FLUTTER_MANIFEST_INCOMPLETE', message: 'Manifest selectedPreview 未绑定当前人工验收。' });
      }
    }
  }
  return blockers;
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const root = repositoryRootFrom(import.meta.dirname);
  try {
    const blockers = await validateWorkspace(root, argument('phase', 'coverage'), process.argv.includes('--scaffold'), process.argv.includes('--allow-resolved-findings'), process.argv.includes('--allow-open-findings'));
    report(blockers);
  } catch (error) {
    report([{ code: error.code || 'FLUTTER_VALIDATION_FAILED', message: error.message }]);
  }
}
