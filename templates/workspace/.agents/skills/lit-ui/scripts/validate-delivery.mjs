import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function add(blockers, code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

try {
  const reportPath = resolve(argument('report', '.psp/evidence/uihtml-acceptance.json'));
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const blockers = [];
  if (report.schemaVersion !== 'psp.dev/uihtml-acceptance/v1') {
    add(blockers, 'UIHTML_RUNTIME_DEP_MISSING', 'UIHTML 验收报告版本无效。', 'schemaVersion');
  }
  if (!report.standalone?.opened || !report.standalone?.assetsResolved) {
    add(blockers, 'UIHTML_RUNTIME_DEP_MISSING', 'UIHTML 未证明可独立打开且资源完整。', 'standalone');
  }
  if (!Array.isArray(report.interactions) || !report.interactions.length || report.interactions.some((item) => !item.passed)) {
    add(blockers, 'UIHTML_INTERACTION_PARITY_FAILED', '已确认 Route/Event/State 分支未全部通过。', 'interactions');
  }
  if (
    !Array.isArray(report.motions)
    || report.motions.some((item) => !item.timingPassed || !item.interruptionPassed || !item.reducedMotionPassed)
  ) {
    add(blockers, 'UIHTML_MOTION_PARITY_FAILED', 'Motion 时序、打断或 reduced-motion 未通过。', 'motions');
  }
  if (
    !Array.isArray(report.visualComparisons)
    || !report.visualComparisons.length
    || report.visualComparisons.some((item) => (
      !item.figmaNodeId
      || !item.viewport
      || typeof item.differenceRatio !== 'number'
      || item.differenceRatio > item.threshold
    ))
  ) {
    add(blockers, 'UIHTML_VISUAL_PARITY_FAILED', '确认范围的 Figma 节点/Viewport 视觉差异超阈值或缺证据。', 'visualComparisons');
  }
  if (
    !/^sha256:[a-f0-9]{64}$/i.test(report.productHash ?? '')
    || report.productHash !== report.productHashAfterReviewCaseChange
  ) {
    add(blockers, 'UIHTML_HASH_BOUNDARY_INVALID', 'Review/Mock/Case 变化影响了 UIHTML 内容哈希。', 'productHash');
  }
  console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', blockers }));
  process.exitCode = blockers.length ? 1 : 0;
} catch (error) {
  console.log(JSON.stringify({
    status: 'BLOCKED',
    blockers: [{ code: 'UIHTML_RUNTIME_DEP_MISSING', message: error instanceof Error ? error.message : String(error) }],
  }));
  process.exitCode = 1;
}
