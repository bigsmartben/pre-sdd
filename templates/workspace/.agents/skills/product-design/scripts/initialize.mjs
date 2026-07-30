import { stringify as stringifyYaml } from 'yaml';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import {
  artifactDefinition,
  artifactPaths,
  loadProject,
  readStructured,
  repositoryRootFrom,
  stringifyStructured,
} from '../../../runtime/project.mjs';
import { preparedArtifactOutputs } from './lib/rendering.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const stageId = 'product-design';
const json = process.argv.includes('--json');
let result;

try {
  const project = await loadProject(root);
  const stage = project.stages?.[stageId];
  if (!stage || stage.status !== 'uninitialized') {
    throw Object.assign(new Error('Product Design 只能从 uninitialized 状态开始。'), {
      code: 'AIH_STAGE_ALREADY_INITIALIZED',
    });
  }

  const writes = [];
  for (const artifactId of ['capabilities', 'visual-spec']) {
    const definition = artifactDefinition(project, artifactId, stageId);
    const paths = artifactPaths(project, artifactId, stageId);
    if (!definition?.template || !definition.schema || !paths?.authorityPath) {
      throw Object.assign(new Error('Product Design 产物绑定不完整：' + artifactId), {
        code: 'AIH_PROJECT_BINDING_INVALID',
      });
    }
    const data = await readStructured(root, definition.template, definition.format);
    writes.push({
      target: paths.authorityPath,
      content: stringifyStructured(data, definition.format),
    });
    for (const output of await preparedArtifactOutputs(root, project, stageId, artifactId, data)) {
      writes.push({ target: output.output, content: output.content });
    }
  }

  const nextProject = structuredClone(project);
  nextProject.stages[stageId].status = 'active';
  writes.push({ target: 'psp.project.yaml', content: stringifyYaml(nextProject) });
  const transactionId = await commitManagedWrites({
    root,
    ownerId: 'product-design-initialize',
    writes,
  });
  result = {
    status: 'PASS',
    stage: stageId,
    transactionId,
    files: writes
      .map((item) => item.target)
      .filter((path) => path !== 'psp.project.yaml')
      .sort(),
    blockers: [],
  };
} catch (error) {
  result = {
    status: 'BLOCKED',
    stage: stageId,
    files: [],
    blockers: [{ code: error.code || 'AIH_PRODUCT_INITIALIZATION_FAILED', message: error.message }],
  };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') {
  console.log('[PASS] Product Design 初始产物已建立。');
  for (const path of result.files) console.log('  ' + path);
} else {
  for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
}
if (result.status !== 'PASS') process.exitCode = 1;
