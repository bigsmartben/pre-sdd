import { readFile } from 'node:fs/promises';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import { artifactPaths, loadProject, repositoryFile, repositoryRootFrom } from '../../../runtime/project.mjs';
import { ARTIFACTS, collectSourceClosure, lockFor, readArtifact, report, stableJson, validateSchema } from './lib/core.mjs';
import { validateWorkspace } from './validate.mjs';

const root = repositoryRootFrom(import.meta.dirname);
try {
  const blockers = await validateWorkspace(root, 'preview');
  if (blockers.length) throw Object.assign(new Error(JSON.stringify(blockers)), { code: blockers[0].code });
  const project = await loadProject(root);
  const path = (id) => artifactPaths(project, id, 'flutter-ui')?.authorityPath;
  const l1 = await readArtifact(root, path(ARTIFACTS.l1.id));
  const checklist = await readArtifact(root, artifactPaths(project, 'checklist', 'visual-spec')?.authorityPath);
  const needsL2 = checklist.data.items.some((item) => item.requiredDeliveryLevel === 'USER_PATH');
  let l2 = null;
  if (needsL2) l2 = await readArtifact(root, path(ARTIFACTS.l2.id));
  const preview = await readArtifact(root, path(ARTIFACTS.preview.id));
  const findings = await readArtifact(root, path(ARTIFACTS.findings.id));
  if (preview.data.metadata.status !== 'accepted' || preview.data.preview.acceptanceStatus !== 'accepted') throw Object.assign(new Error('所选 target Preview 尚未人工 accepted。'), { code: 'FLUTTER_PREVIEW_NOT_ACCEPTED' });
  if (findings.data.findings.some((entry) => ['Blocker', 'Major'].includes(entry.severity) && entry.status !== 'closed')) throw Object.assign(new Error('存在开放 Blocker/Major Finding。'), { code: 'FLUTTER_FINDING_OPEN' });
  const closure = await collectSourceClosure(root);
  const entries = l1.data.items;
  const index = (values) => [...new Map(values.map((entry) => [`${entry.id}\0${entry.path}`, entry])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const sourcePath = (item) => item.sourcePaths[0];
  const manifestPath = path(ARTIFACTS.manifest.id);
  let revision = 1;
  try { revision = JSON.parse(await readFile(repositoryFile(root, manifestPath), 'utf8')).metadata.revision + 1; } catch { /* first revision */ }
  const manifest = {
    schemaVersion: 'psp.dev/flutter-ui/v1', metadata: { artifactId: 'UI-SPEC-MANIFEST', revision, status: 'accepted' },
    source: { framework: 'flutter', language: 'dart', root: 'lib/ui', commit: preview.data.source.commit, digest: closure.digest, flutterConstraint: closure.flutterConstraint },
    artifactLocks: [lockFor('FLUTTER-VISUAL-COVERAGE', l1), ...(l2 ? [lockFor('FLUTTER-USER-PATH-COVERAGE', l2)] : []), lockFor('FLUTTER-UI-PREVIEW', preview), lockFor('REVIEW-FINDINGS', findings)],
    selectedPreview: { target: preview.data.preview.target, runtimeProfile: preview.data.preview.runtimeProfile, sourceDigest: preview.data.source.digest, buildDigest: preview.data.preview.buildDigest, acceptedBy: preview.data.preview.acceptedBy, acceptedAt: preview.data.preview.acceptedAt },
    indexes: {
      routes: index(entries.map((item) => ({ id: item.route, path: sourcePath(item) }))),
      pages: index(entries.map((item) => ({ id: item.page, path: sourcePath(item) }))),
      widgets: index(entries.map((item) => ({ id: item.widgetId, path: sourcePath(item) }))),
      states: index(entries.flatMap((item) => item.states.map((id) => ({ id, path: sourcePath(item) })))),
      events: index((l2?.data.paths ?? []).flatMap((pathCoverage) => pathCoverage.steps.map((step) => ({ id: step.event, path: step.sourcePaths[0] })))),
    },
    closure: closure.files,
    completeness: { sourceCoverage: 100, specCoverage: 100, undeclaredInference: 0, openBlockerMajor: 0, staleArtifacts: 0 },
  };
  const schemaBlockers = await validateSchema(root, ARTIFACTS.manifest.schema, manifest);
  if (schemaBlockers.length) throw Object.assign(new Error(JSON.stringify(schemaBlockers)), { code: 'FLUTTER_MANIFEST_INCOMPLETE' });
  await commitManagedWrites({ root, ownerId: 'flutter-ui-spec-manifest', writes: [{ target: manifestPath, content: stableJson(manifest) }] });
  report([], { revision, target: manifest.selectedPreview.target });
} catch (error) { report([{ code: error.code || 'FLUTTER_MANIFEST_INCOMPLETE', message: error.message }]); }
