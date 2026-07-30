import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { sha256, stableJson, validateWithSchema } from '../../visual-spec/scripts/lib/visual-spec.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
try {
  const acceptedBy = argument('accepted-by');
  const acceptedAt = argument('accepted-at');
  if (!acceptedBy || !acceptedAt || Number.isNaN(Date.parse(acceptedAt))) {
    throw Object.assign(new Error('真实 Lit 接受必须记录 accepted-by 与 ISO accepted-at。'), { code: 'VSD_HUMAN_ACCEPTANCE_REQUIRED' });
  }
  const preflight = spawnSync(
    process.execPath,
    [resolve(import.meta.dirname, 'validate.mjs'), '--phase', 'delivery'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PSP_REPOSITORY_ROOT: root },
    },
  );
  if (preflight.status !== 0) {
    throw Object.assign(new Error(preflight.stdout || preflight.stderr), { code: 'VSD_DELIVERY_NOT_READY' });
  }
  const project = await loadProject(root);
  const deliveryPath = artifactPaths(project, 'delivery-manifest', 'lit-ui')?.authorityPath;
  const findingsPath = artifactPaths(project, 'review-findings', 'lit-ui')?.authorityPath;
  if (!deliveryPath || !findingsPath) throw Object.assign(new Error('Delivery Registry 不完整。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  const delivery = JSON.parse(await readFile(repositoryFile(root, deliveryPath), 'utf8'));
  const findings = JSON.parse(await readFile(repositoryFile(root, findingsPath), 'utf8'));
  if (delivery.metadata?.status !== 'reviewing') throw Object.assign(new Error('只有 reviewing Delivery 可接受。'), { code: 'VSD_ACCEPTANCE_TRANSITION_INVALID' });
  if ((findings.findings ?? []).some((item) => item.status !== 'closed')) {
    throw Object.assign(new Error('仍有未关闭 Finding。'), { code: 'RVW_FINDING_OPEN' });
  }
  delivery.metadata.status = 'accepted';
  delivery.metadata.revision += 1;
  delivery.reviewAcceptance = { acceptedBy, acceptedAt };
  const deliveryContent = stableJson(delivery);
  findings.deliveryLock = {
    artifactId: 'VISUAL-SPEC-DELIVERY',
    path: deliveryPath,
    revision: delivery.metadata.revision,
    digest: sha256(Buffer.from(deliveryContent)),
  };
  findings.metadata.revision += 1;
  findings.metadata.status = 'clear';
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/delivery-manifest.schema.json', delivery));
  blockers.push(...await validateWithSchema(root, '.agents/skills/lit-ui/schemas/review-findings.schema.json', findings));
  if (blockers.length) throw new Error('接受后的 Delivery/Finding Schema 无效。');
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'visual-spec-delivery-acceptance',
    writes: [
      { target: deliveryPath, content: deliveryContent },
      { target: findingsPath, content: stableJson(findings) },
    ],
  });
} catch (error) {
  if (!blockers.length || error.code) blockers.unshift({ code: error.code || 'VSD_ACCEPTANCE_FAILED', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
