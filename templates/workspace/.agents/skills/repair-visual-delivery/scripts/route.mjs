import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { repositoryRootFrom } from '../../../runtime/project.mjs';
import { stableJson } from '../../visual-spec/scripts/lib/visual-spec.mjs';
import {
  argument,
  assertAuthority,
  bindFindingsToDelivery,
  context,
  findingById,
  loadOptional,
  staleArtifact,
} from './lib/findings.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
try {
  const state = await context(root);
  const finding = findingById(state.findings, argument('finding'));
  if (finding.status !== 'open') throw Object.assign(new Error('只有 open Finding 可确认根因。'), { code: 'RVW_TRANSITION_INVALID' });
  const category = argument('category');
  const authorityPath = argument('authority');
  const confirmedBy = argument('confirmed-by');
  if (!confirmedBy) throw Object.assign(new Error('根因确认必须记录 confirmed-by。'), { code: 'RVW_ROOT_CAUSE_INVALID' });
  assertAuthority(category, authorityPath);
  finding.rootCause = { category, authorityPath, confirmedBy };
  finding.status = 'triaged';
  state.findings.metadata.revision += 1;
  state.findings.metadata.status = 'active';

  const chains = {
    SCHEMA: [
      state.paths.checklist, state.paths.figmaCoverage, state.paths.figmaEvidence,
      state.paths.authorization, state.paths.plan, state.paths.mock, state.paths.l1,
      state.paths.l2, state.paths.delivery, state.paths.uihtml,
    ],
    CHECKLIST_BASELINE: [
      state.paths.checklist, state.paths.figmaCoverage, state.paths.figmaEvidence,
      state.paths.authorization, state.paths.plan, state.paths.mock, state.paths.l1,
      state.paths.l2, state.paths.delivery, state.paths.uihtml,
    ],
    FIGMA_SOURCE: [
      state.paths.figmaCoverage, state.paths.figmaEvidence, state.paths.authorization,
      state.paths.l1, state.paths.l2, state.paths.delivery, state.paths.uihtml,
    ],
    FIGMA_BINDING: [
      state.paths.figmaCoverage, state.paths.figmaEvidence, state.paths.authorization,
      state.paths.l1, state.paths.l2, state.paths.delivery, state.paths.uihtml,
    ],
    LIT_L1: [state.paths.l1, state.paths.l2, state.paths.delivery, state.paths.uihtml],
    MOCK_ADAPTER: [state.paths.mock, state.paths.l2, state.paths.delivery, state.paths.uihtml],
    LIT_L2: [state.paths.l2, state.paths.delivery, state.paths.uihtml],
    REVIEW_TOOL: [state.paths.delivery],
  };
  const records = [];
  const selectedPaths = chains[category] ?? [];
  for (const path of selectedPaths) records.push(await loadOptional(root, path));
  const plan = await loadOptional(root, state.paths.plan);
  const scenarioIds = new Set(
    (plan?.data?.paths ?? [])
      .filter((path) => path.checklistItemRefs?.includes(finding.itemId))
      .flatMap((path) => path.scenarioSlots ?? []),
  );
  const writes = records.map((record) => staleArtifact(record, finding.itemId, scenarioIds)).filter(Boolean);
  const deliveryWrite = writes.find((write) => write.target === state.paths.delivery);
  await bindFindingsToDelivery(root, state.findings, deliveryWrite, state.paths.delivery);
  writes.push({ target: state.paths.findings, content: stableJson(state.findings) });
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'repair-visual-delivery-route',
    writes,
  });
} catch (error) {
  blockers.push({ code: error.code || 'RVW_ROUTE_FAILED', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
