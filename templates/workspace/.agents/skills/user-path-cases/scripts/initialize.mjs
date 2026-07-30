import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import {
  artifactDefinition,
  artifactPaths,
  loadProject,
  readStructured,
  repositoryRootFrom,
  stringifyStructured,
} from '../../../runtime/project.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const blockers = [];
let transactionId = null;
try {
  const project = await loadProject(root);
  const definition = artifactDefinition(project, 'test-case-catalog', 'user-path-cases');
  const paths = artifactPaths(project, 'test-case-catalog', 'user-path-cases');
  if (!definition?.template || !paths?.authorityPath) {
    throw Object.assign(new Error('Registry 未绑定 Test Case Catalog。'), { code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID' });
  }
  const data = await readStructured(root, definition.template, definition.format);
  transactionId = await commitManagedWrites({
    root,
    ownerId: 'test-case-catalog-initialize',
    writes: [{ target: paths.authorityPath, content: stringifyStructured(data, definition.format) }],
  });
} catch (error) {
  blockers.push({ code: error.code || 'VISUAL_SPEC_SOURCE_NOT_READY', message: error.message });
}
console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', transactionId, blockers }));
if (blockers.length) process.exitCode = 1;
