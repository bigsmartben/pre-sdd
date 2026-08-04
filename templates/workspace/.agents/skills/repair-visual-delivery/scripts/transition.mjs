import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { repositoryRootFrom } from '../../../runtime/project.mjs';
import { stableJson } from '../../visual-spec/scripts/lib/visual-spec.mjs';
import { isIsoDateTime } from '../../flutter-ui/scripts/lib/core.mjs';
import { argument, context, findingById, repairEvidence } from './lib/findings.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
try {
  const state = await context(root);
  const finding = findingById(state.findings, argument('finding'));
  const operation = argument('operation');
  const expected = {
    'start-repair': 'triaged',
    resolve: 'repairing',
    verify: 'resolved',
    close: 'verified',
  }[operation];
  if (!expected || finding.status !== expected) {
    throw Object.assign(new Error(`${operation} 不能从 ${finding.status} 执行。`), { code: 'RVW_TRANSITION_INVALID' });
  }
  if (operation === 'start-repair') finding.status = 'repairing';
  if (operation === 'resolve') {
    const authorityPath = argument('authority');
    if (authorityPath !== finding.rootCause?.authorityPath) throw Object.assign(new Error('resolve 必须绑定已确认的最早权威路径。'), { code: 'RVW_REPAIR_INVALID' });
    finding.repair = await repairEvidence(root, authorityPath, state.paths.figmaEvidence);
    finding.status = 'resolved';
  }
  if (operation === 'verify') {
    const humanVerifiedBy = argument('human-verified-by');
    const verifiedAt = argument('verified-at');
    if (!humanVerifiedBy || !isIsoDateTime(verifiedAt)) {
      throw Object.assign(new Error('verify 要求 selected-target Flutter Preview 人工复验身份与 RFC 3339 时间。'), { code: 'RVW_VERIFICATION_REQUIRED' });
    }
    const validation = spawnSync(
      process.execPath,
      [resolve(import.meta.dirname, '../../flutter-ui/scripts/validate.mjs'), '--phase', 'preview', '--allow-resolved-findings'],
      {
        cwd: root,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, PSP_REPOSITORY_ROOT: root },
      },
    );
    if (validation.status !== 0) {
      throw Object.assign(new Error('机器回归未通过：' + (validation.stdout || validation.stderr)), {
        code: 'RVW_MACHINE_REGRESSION_FAILED',
      });
    }
    finding.verification = { machinePassed: true, humanVerifiedBy, verifiedAt };
    finding.status = 'verified';
  }
  if (operation === 'close') finding.status = 'closed';
  state.findings.metadata.revision += 1;
  state.findings.metadata.status = state.findings.findings.every((item) => item.status === 'closed') ? 'clear' : 'active';
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'repair-visual-delivery-finding',
    writes: [{ target: state.paths.findings, content: stableJson(state.findings) }],
  });
} catch (error) {
  blockers.push({ code: error.code || 'RVW_TRANSITION_FAILED', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
