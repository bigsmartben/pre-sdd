import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryRootFrom } from '../../../runtime/project.mjs';
import { argument, isIsoDateTime, lockFor, readArtifact, report, sha256, stableJson, validateSchema, ARTIFACTS } from './lib/core.mjs';
import { validateWorkspace } from './validate.mjs';

const root = repositoryRootFrom(import.meta.dirname);
try {
  const acceptedBy = argument('accepted-by');
  const acceptedAt = argument('accepted-at');
  if (!acceptedBy || !isIsoDateTime(acceptedAt)) throw Object.assign(new Error('必须记录 accepted-by 与 RFC 3339 accepted-at。'), { code: 'FLUTTER_HUMAN_ACCEPTANCE_REQUIRED' });
  const blockers = await validateWorkspace(root, 'preview');
  if (blockers.length) throw Object.assign(new Error(JSON.stringify(blockers)), { code: blockers[0].code });
  const project = await loadProject(root);
  const previewPath = artifactPaths(project, ARTIFACTS.preview.id, 'flutter-ui').authorityPath;
  const preview = await readArtifact(root, previewPath);
  const findingsPath = artifactPaths(project, ARTIFACTS.findings.id, 'flutter-ui').authorityPath;
  const findings = await readArtifact(root, findingsPath);
  if (!['built', 'reviewing'].includes(preview.data.metadata.status)) throw Object.assign(new Error('只有当前 built/reviewing Preview 可接受。'), { code: 'FLUTTER_ACCEPTANCE_TRANSITION_INVALID' });
  preview.data.metadata.status = 'accepted'; preview.data.metadata.revision += 1;
  Object.assign(preview.data.preview, { acceptanceStatus: 'accepted', acceptedBy, acceptedAt });
  const previewContent = stableJson(preview.data);
  findings.data.previewLock = lockFor('FLUTTER-UI-PREVIEW', { path: previewPath, data: preview.data, digest: sha256(Buffer.from(previewContent)) });
  findings.data.metadata.revision += 1;
  findings.data.metadata.status = findings.data.findings.every((entry) => entry.status === 'closed') ? 'clear' : 'active';
  const schemaBlockers = [
    ...await validateSchema(root, ARTIFACTS.preview.schema, preview.data),
    ...await validateSchema(root, ARTIFACTS.findings.schema, findings.data),
  ];
  if (schemaBlockers.length) throw Object.assign(new Error(JSON.stringify(schemaBlockers)), { code: 'FLUTTER_ARTIFACT_SCHEMA_INVALID' });
  await commitManagedWrites({ root, ownerId: 'flutter-ui-preview-acceptance', writes: [{ target: previewPath, content: previewContent }, { target: findingsPath, content: stableJson(findings.data) }] });
  report([], { target: preview.data.preview.target, revision: preview.data.metadata.revision });
} catch (error) { report([{ code: error.code || 'FLUTTER_ACCEPTANCE_FAILED', message: error.message }]); }
