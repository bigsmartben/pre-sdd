import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import {
  isLegacyVisualInput,
  sha256,
  stableJson,
  validateWithSchema,
} from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { hashDirectory } from './hash-uihtml.mjs';
import { productionSourceGraph } from './lib/source-graph.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = repositoryRootFrom(import.meta.dirname);
const phase = argument('phase', 'review');
const blockers = [];
const stale = new Set();

function ownerValidation(script, code) {
  const result = spawnSync(process.execPath, [resolve(root, script)], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PSP_REPOSITORY_ROOT: root },
  });
  if (result.status !== 0) blockers.push({
    code,
    message: result.stdout || result.stderr,
  });
}

async function artifact(project, stage, id, schema) {
  const path = artifactPaths(project, id, stage)?.authorityPath;
  if (!path) throw Object.assign(new Error(`Registry 未绑定 ${stage}.${id}`), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const bytes = await readFile(repositoryFile(root, path));
  const data = JSON.parse(bytes);
  if (isLegacyVisualInput(data, path)) {
    throw Object.assign(new Error(`旧视觉产物禁止进入 Lit：${path}`), { code: 'LEGACY_VISUAL_WORKFLOW_FORBIDDEN' });
  }
  blockers.push(...await validateWithSchema(root, schema, data));
  return { path, bytes, digest: sha256(bytes), data };
}

try {
  const project = await loadProject(root);
  if (process.argv.includes('--scaffold')) {
    for (const schema of [
      '.agents/skills/lit-ui/schemas/lit-visual-coverage.schema.json',
      '.agents/skills/lit-ui/schemas/user-path-coverage.schema.json',
      '.agents/skills/lit-ui/schemas/delivery-manifest.schema.json',
      '.agents/skills/lit-ui/schemas/review-findings.schema.json',
      '.agents/skills/lit-ui/schemas/uihtml-production.schema.json',
    ]) {
      JSON.parse(await readFile(repositoryFile(root, schema), 'utf8'));
    }
  } else {
    const checklist = await artifact(project, 'visual-spec', 'checklist', '.agents/skills/visual-spec/schemas/visual-spec-checklist.schema.json');
    const authorization = await artifact(project, 'visual-spec', 'ready-authorization', '.agents/skills/visual-spec/schemas/ready-authorization.schema.json');
    const figmaCoverage = await artifact(project, 'figma-workflow', 'figma-coverage', '.agents/skills/figma-workflow/schemas/figma-coverage.schema.json');
    const figmaEvidence = await artifact(project, 'figma-workflow', 'figma-evidence', '.agents/skills/figma-workflow/schemas/figma-evidence.schema.json');
    const l1 = await artifact(project, 'lit-ui', 'lit-visual-coverage', '.agents/skills/lit-ui/schemas/lit-visual-coverage.schema.json');
    ownerValidation('.agents/skills/visual-spec/scripts/validate.mjs', 'LVC_SOURCE_NOT_READY');
    ownerValidation('.agents/skills/figma-workflow/scripts/validate.mjs', 'LVC_SOURCE_NOT_READY');
    if (
      checklist.data.metadata?.status !== 'ready'
      || authorization.data.status !== 'ready'
      || figmaCoverage.data.metadata?.status !== 'ready'
      || figmaEvidence.data.metadata?.status !== 'ready'
      || l1.data.metadata?.status !== 'ready'
      || (checklist.data.gaps ?? []).length
      || (figmaCoverage.data.gaps ?? []).length
      || (figmaEvidence.data.gaps ?? []).length
    ) blockers.push({ code: 'LVC_SOURCE_NOT_READY', message: 'L1 只接受 Ready 且无 Gap 的 Checklist、Authorization 与 Figma 证据。' });
    blockers.push(...(await productionSourceGraph(root)).blockers);
    const actualSrcUiDigest = await hashDirectory(repositoryFile(root, 'src/ui'));
    if (l1.data.litSource?.srcUiDigest !== actualSrcUiDigest) {
      blockers.push({ code: 'LVC_LIT_SOURCE_DIGEST_INVALID', message: 'L1 Coverage 未绑定实际 src/ui 字节。' });
    }
    const needsL2 = (checklist.data.items ?? []).some((item) => item.requiredDeliveryLevel === 'USER_PATH');
    let l2 = null;
    let plan = null;
    let mock = null;
    if (needsL2) {
      plan = await artifact(project, 'user-path-cases', 'user-path-plan', '.agents/skills/user-path-cases/schemas/user-path-plan.schema.json');
      mock = await artifact(project, 'mockcase', 'mock-scenario-suite', '.agents/skills/mockcase/schemas/mock-scenario-suite.schema.json');
      l2 = await artifact(project, 'lit-ui', 'user-path-coverage', '.agents/skills/lit-ui/schemas/user-path-coverage.schema.json');
      ownerValidation('.agents/skills/user-path-cases/scripts/validate.mjs', 'UPC_SOURCE_NOT_READY');
      ownerValidation('.agents/skills/mockcase/scripts/workflow.mjs', 'UPC_SOURCE_NOT_READY');
    }
    const sourceMap = new Map([
      ['VISUAL-SPEC-READY-AUTHORIZATION', authorization],
      ['FIGMA-COVERAGE', figmaCoverage],
      ['FIGMA-EVIDENCE', figmaEvidence],
    ]);
    if (
      new Set((l1.data.sourceLocks ?? []).map((lock) => lock.artifactId)).size !== 3
      || [...sourceMap.keys()].some((id) => !(l1.data.sourceLocks ?? []).some((lock) => lock.artifactId === id))
    ) blockers.push({ code: 'LVC_SOURCE_LOCK_INVALID', message: 'L1 Source Lock 集合不完整或重复。' });
    if (
      authorization.data.checklist?.path !== checklist.path
      || authorization.data.checklist?.revision !== checklist.data.metadata.revision
      || authorization.data.checklist?.digest !== checklist.digest
      || authorization.data.figmaCoverage?.path !== figmaCoverage.path
      || authorization.data.figmaCoverage?.revision !== figmaCoverage.data.metadata.revision
      || authorization.data.figmaCoverage?.digest !== figmaCoverage.digest
      || authorization.data.figmaEvidence?.path !== figmaEvidence.path
      || authorization.data.figmaEvidence?.revision !== figmaEvidence.data.metadata.revision
      || authorization.data.figmaEvidence?.digest !== figmaEvidence.digest
    ) blockers.push({ code: 'LVC_READY_AUTHORIZATION_STALE', message: 'Ready Authorization 未绑定当前 Checklist/Figma 证据。' });
    for (const lock of l1.data.sourceLocks ?? []) {
      const source = sourceMap.get(lock.artifactId);
      if (!source || lock.path !== source.path) blockers.push({ code: 'LVC_SOURCE_LOCK_INVALID', message: `${lock.artifactId} Source Lock 非正式路径。` });
      else if (lock.revision !== (source.data.metadata?.revision ?? source.data.revision) || lock.digest !== source.digest) {
        for (const item of l1.data.items ?? []) stale.add(item.itemId);
      }
    }
    const checklistIds = new Set((checklist.data.items ?? []).map((item) => item.itemId));
    const l1ById = new Map((l1.data.items ?? []).map((item) => [item.itemId, item]));
    if (l1ById.size !== (l1.data.items ?? []).length) {
      blockers.push({ code: 'LVC_ITEM_SCOPE_INVALID', message: 'L1 Coverage 包含重复 itemId。' });
    }
    for (const itemId of l1ById.keys()) {
      if (!checklistIds.has(itemId)) blockers.push({
        code: 'LVC_ITEM_SCOPE_INVALID',
        message: `L1 Coverage 擅自扩大 Checklist：${itemId}`,
      });
    }
    for (const item of checklist.data.items ?? []) {
      const coverage = l1ById.get(item.itemId);
      if (!coverage || coverage.status !== 'accepted') blockers.push({
        code: 'LVC_ITEM_NOT_ACCEPTED',
        message: `L1 未 accepted：${item.itemId}`,
      });
      if (coverage) {
        for (const [requiredKey, actualKey] of [
          ['viewports', 'viewports'],
          ['states', 'states'],
          ['variants', 'variants'],
          ['contentCases', 'contentCases'],
          ['tokens', 'tokenRefs'],
          ['assets', 'assetRefs'],
          ['motions', 'motionRefs'],
        ]) {
          const actual = new Set(coverage[actualKey] ?? []);
          for (const value of item.dimensions?.[requiredKey] ?? []) {
            if (!actual.has(value)) blockers.push({ code: 'LVC_DIMENSION_MISSING', message: `${item.itemId} 缺少 ${requiredKey}:${value}` });
          }
        }
      }
    }
    if (needsL2) {
      if (
        plan.data.metadata?.status !== 'ready'
        || mock.data.metadata?.status !== 'ready'
        || l2.data.metadata?.status !== 'ready'
        || (plan.data.gaps ?? []).length
        || (mock.data.gaps ?? []).length
      ) blockers.push({ code: 'UPC_SOURCE_NOT_READY', message: 'L2 只接受 Ready 且无 Gap 的 Path Plan 与 Mock Suite。' });
      if (l2.data.litSource?.srcUiDigest !== l1.data.litSource?.srcUiDigest || l2.data.litSource?.commit !== l1.data.litSource?.commit) {
        blockers.push({ code: 'UPC_LIT_SOURCE_MISMATCH', message: 'L2 与 L1 未绑定同一份 src/ui。' });
      }
      const l2Sources = new Map([
        ['USER-PATH-PLAN', plan],
        ['LIT-VISUAL-COVERAGE', l1],
        ['MOCK-SCENARIO-SUITE', mock],
      ]);
      if (
        new Set((l2.data.sourceLocks ?? []).map((lock) => lock.artifactId)).size !== 3
        || [...l2Sources.keys()].some((id) => !(l2.data.sourceLocks ?? []).some((lock) => lock.artifactId === id))
      ) blockers.push({ code: 'UPC_SOURCE_LOCK_INVALID', message: 'L2 Source Lock 集合不完整或重复。' });
      for (const lock of l2.data.sourceLocks ?? []) {
        const source = l2Sources.get(lock.artifactId);
        if (
          !source
          || lock.path !== source.path
          || lock.revision !== source.data.metadata.revision
          || lock.digest !== source.digest
        ) blockers.push({ code: 'UPC_SOURCE_LOCK_INVALID', message: `${lock.artifactId} 未绑定当前 L2 来源。` });
      }
      const planById = new Map((plan.data.paths ?? []).map((item) => [item.pathId, item]));
      const scenarios = new Map((mock.data.scenarios ?? []).map((item) => [item.scenarioId, item]));
      const l2ById = new Map((l2.data.paths ?? []).map((item) => [item.pathId, item]));
      if (planById.size !== (plan.data.paths ?? []).length || l2ById.size !== (l2.data.paths ?? []).length) {
        blockers.push({ code: 'UPC_PATH_REF_INVALID', message: 'Path Plan 或 L2 Coverage 包含重复 pathId。' });
      }
      for (const planned of plan.data.paths ?? []) {
        if (!l2ById.has(planned.pathId)) blockers.push({
          code: 'UPC_PATH_NOT_ACCEPTED',
          message: `L2 遗漏 Path Plan 路径：${planned.pathId}`,
        });
      }
      for (const path of l2.data.paths ?? []) {
        const planned = planById.get(path.pathId);
        if (
          !planned
          || planned.testCaseRef !== path.testCaseRef
          || JSON.stringify([...planned.checklistItemRefs].sort()) !== JSON.stringify([...path.checklistItemRefs].sort())
        ) {
          blockers.push({ code: 'UPC_PATH_REF_INVALID', message: `L2 未绑定正式 Path Plan：${path.pathId}` });
        }
        if (path.status !== 'accepted' || path.steps.some((step) => step.passed !== true)) {
          blockers.push({ code: 'UPC_PATH_NOT_ACCEPTED', message: `L2 路径未 accepted：${path.pathId}` });
        }
        const plannedSteps = new Map((planned?.steps ?? []).map((step) => [step.pathStepId, step]));
        const l1Targets = new Set(
          (path.checklistItemRefs ?? [])
            .map((itemId) => l1ById.get(itemId))
            .filter(Boolean)
            .map((item) => `${item.route ?? ''}\u0000${item.component}`),
        );
        if (
          plannedSteps.size !== (path.steps ?? []).length
          || (planned?.steps ?? []).length !== (path.steps ?? []).length
        ) blockers.push({ code: 'UPC_PATH_STEP_INVALID', message: `${path.pathId} 的步骤集合与 Path Plan 不一致。` });
        for (const step of path.steps ?? []) {
          const plannedStep = plannedSteps.get(step.pathStepId);
          if (
            !plannedStep
            || plannedStep.checkpoint !== step.checkpoint
            || plannedStep.assertion !== step.assertion
            || !(planned?.scenarioSlots ?? []).includes(step.scenarioSlot)
          ) blockers.push({ code: 'UPC_PATH_STEP_INVALID', message: `${path.pathId} 的步骤未闭合到 Path Plan：${step.pathStepId}` });
          if (!l1Targets.has(`${step.route}\u0000${step.component}`)) {
            blockers.push({
              code: 'UPC_L1_REQUIRED',
              message: `${path.pathId} 的步骤未运行关联 L1 route/component：${step.pathStepId}`,
            });
          }
          if (!scenarios.has(step.scenarioSlot) || scenarios.get(step.scenarioSlot).status !== 'ready') {
            blockers.push({ code: 'UPC_MOCK_SCENARIO_NOT_READY', message: `${path.pathId} 缺少 Ready Mock：${step.scenarioSlot}` });
          }
        }
        for (const itemId of path.checklistItemRefs ?? []) {
          if (l1ById.get(itemId)?.status !== 'accepted') blockers.push({ code: 'UPC_L1_REQUIRED', message: `${path.pathId} 绕过 L1：${itemId}` });
        }
        const expectedTraceDigest = sha256(Buffer.from(stableJson({
          pathId: path.pathId,
          testCaseRef: path.testCaseRef,
          checklistItemRefs: [...path.checklistItemRefs].sort(),
          steps: path.steps,
        })));
        if (path.traceDigest !== expectedTraceDigest) blockers.push({
          code: 'UPC_TRACE_DIGEST_INVALID',
          message: `${path.pathId} traceDigest 不是实际路径步骤的摘要。`,
        });
      }
    }
    if ((l1.data.gaps ?? []).length || (l2?.data.gaps ?? []).length) blockers.push({ code: 'LVC_GAP_OPEN', message: 'Lit Coverage 仍有 Gap。' });

    if (phase === 'delivery' || phase === 'product') {
      const delivery = await artifact(project, 'lit-ui', 'delivery-manifest', '.agents/skills/lit-ui/schemas/delivery-manifest.schema.json');
      const findings = await artifact(project, 'lit-ui', 'review-findings', '.agents/skills/lit-ui/schemas/review-findings.schema.json');
      if (delivery.data.litSource?.srcUiDigest !== l1.data.litSource?.srcUiDigest || delivery.data.litSource?.commit !== l1.data.litSource?.commit) {
        blockers.push({ code: 'VSD_LIT_SOURCE_MISMATCH', message: 'Delivery 与 L1 未绑定同一份 src/ui。' });
      }
      if (delivery.data.reviewBuild?.digest !== await hashDirectory(repositoryFile(root, delivery.data.reviewBuild?.path ?? '.psp/review-dist'))) {
        blockers.push({ code: 'VSD_REVIEW_BUILD_STALE', message: 'Delivery 未绑定当前真实 Lit Review Build。' });
      }
      const deliverySources = new Map([
        ['VISUAL-SPEC-CHECKLIST', checklist],
        ['FIGMA-COVERAGE', figmaCoverage],
        ['FIGMA-EVIDENCE', figmaEvidence],
        ['LIT-VISUAL-COVERAGE', l1],
        ...(l2 ? [['USER-PATH-COVERAGE', l2]] : []),
      ]);
      if (
        new Set((delivery.data.sourceLocks ?? []).map((lock) => lock.artifactId)).size !== deliverySources.size
        || [...deliverySources.keys()].some((id) => !(delivery.data.sourceLocks ?? []).some((lock) => lock.artifactId === id))
      ) blockers.push({ code: 'VSD_SOURCE_LOCK_INVALID', message: 'Delivery Source Lock 集合不完整或重复。' });
      for (const lock of delivery.data.sourceLocks ?? []) {
        const source = deliverySources.get(lock.artifactId);
        if (
          !source
          || lock.path !== source.path
          || lock.revision !== source.data.metadata.revision
          || lock.digest !== source.digest
        ) blockers.push({ code: 'VSD_SOURCE_LOCK_INVALID', message: `${lock.artifactId} 未绑定当前交付来源。` });
      }
      const deliveredItems = new Map((delivery.data.items ?? []).map((item) => [item.itemId, item]));
      if (deliveredItems.size !== (delivery.data.items ?? []).length) {
        blockers.push({ code: 'VSD_ITEM_SCOPE_INVALID', message: 'Delivery 包含重复 itemId。' });
      }
      for (const itemId of deliveredItems.keys()) {
        if (!checklistIds.has(itemId)) blockers.push({
          code: 'VSD_ITEM_SCOPE_INVALID',
          message: `Delivery 擅自扩大 Checklist：${itemId}`,
        });
      }
      for (const item of checklist.data.items ?? []) {
        if (deliveredItems.get(item.itemId)?.deliveryLevel !== item.requiredDeliveryLevel) {
          blockers.push({ code: 'VSD_ITEM_MISSING', message: `Delivery 缺少 Checklist item：${item.itemId}` });
        }
      }
      if (
        findings.data.deliveryLock?.revision !== delivery.data.metadata.revision
        || findings.data.deliveryLock?.digest !== delivery.digest
      ) {
        blockers.push({ code: 'RVW_DELIVERY_STALE', message: 'Finding 未绑定当前 Delivery。' });
      }
      const findingsById = new Set((findings.data.findings ?? []).map((finding) => finding.findingId));
      if (findingsById.size !== (findings.data.findings ?? []).length) {
        blockers.push({ code: 'RVW_CONTEXT_INVALID', message: 'Review Findings 包含重复 findingId。' });
      }
      const validFigmaEvidenceRefs = new Set([
        ...(figmaCoverage.data.items ?? []).flatMap((item) => (item.anchors ?? []).map((anchor) => anchor.nodeId)),
        ...(figmaEvidence.data.assets ?? []).map((item) => item.assetId),
        ...(figmaEvidence.data.tokens ?? []).map((item) => item.tokenId),
        ...(figmaEvidence.data.motions ?? []).map((item) => item.motionId),
      ]);
      for (const finding of findings.data.findings ?? []) {
        const deliveredItem = deliveredItems.get(finding.itemId);
        const currentObservation = ['open', 'triaged', 'repairing'].includes(finding.status);
        if (
          currentObservation
          && (
            !deliveredItem
            || deliveredItem.route !== finding.route
            || deliveredItem.component !== finding.component
            || finding.litSource?.commit !== delivery.data.litSource?.commit
            || finding.litSource?.srcUiDigest !== delivery.data.litSource?.srcUiDigest
            || finding.litSource?.reviewBuildDigest !== delivery.data.reviewBuild?.digest
            || (finding.figmaEvidenceRefs ?? []).some((ref) => !validFigmaEvidenceRefs.has(ref))
          )
        ) blockers.push({ code: 'RVW_CONTEXT_INVALID', message: `${finding.findingId} 未闭合到当前 Delivery/Figma/Lit。` });
        if (finding.level === 'L2' && currentObservation) {
          const path = (l2?.data.paths ?? []).find((entry) => (
            entry.testCaseRef === finding.testCaseId
            && entry.checklistItemRefs?.includes(finding.itemId)
            && entry.steps?.some((step) => step.pathStepId === finding.pathStepId)
          ));
          if (!path) blockers.push({ code: 'RVW_CONTEXT_INVALID', message: `${finding.findingId} 的 L2 Test Case/Step 无效。` });
        }
        if (finding.status === 'closed' && (!finding.rootCause || !finding.repair || !finding.verification)) {
          blockers.push({ code: 'RVW_CLOSE_FORBIDDEN', message: `${finding.findingId} 未闭合根因、修复与人工复验。` });
        }
        const repairVerification = process.argv.includes('--allow-resolved-findings')
          && ['resolved', 'verified'].includes(finding.status);
        if (
          finding.status !== 'closed'
          && !repairVerification
          && !process.argv.includes('--allow-open-findings')
        ) {
          blockers.push({ code: 'RVW_FINDING_OPEN', message: `${finding.findingId} 尚未关闭。` });
        }
        try {
          const screenshot = await readFile(repositoryFile(root, finding.screenshot.path));
          if (sha256(screenshot) !== finding.screenshot.digest) blockers.push({ code: 'RVW_SCREENSHOT_STALE', message: `${finding.findingId} 截图摘要不匹配。` });
        } catch {
          blockers.push({ code: 'RVW_SCREENSHOT_MISSING', message: `${finding.findingId} 截图不可读。` });
        }
      }
      if (phase === 'product' && delivery.data.metadata.status !== 'accepted') {
        blockers.push({ code: 'VSD_DELIVERY_NOT_ACCEPTED', message: '生产 UIHTML 要求 Delivery 已人工 accepted。' });
      }
    }
  }
} catch (error) {
  blockers.unshift({ code: error.code || 'LVC_VALIDATION_FAILED', message: error.message });
}

const status = blockers.length ? 'BLOCKED' : stale.size ? 'STALE' : 'PASS';
console.log(JSON.stringify({ status, phase, blockers, staleItems: [...stale].sort() }));
if (status !== 'PASS') process.exitCode = 1;
