import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { commitManagedWrites } from '../../../runtime/artifact-transaction.mjs';
import {
  artifactDefinitions,
  artifactPaths,
  loadProject,
  readStructured,
  repositoryFile,
  repositoryRootFrom,
  stringifyStructured,
} from '../../../runtime/project.mjs';
import { preparedArtifactOutputs } from './lib/rendering.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const stageId = 'architecture-design';
const json = process.argv.includes('--json');
let result;

try {
  const project = await loadProject(root);
  const stage = project.stages?.[stageId];
  if (!stage || stage.status !== 'uninitialized') {
    throw Object.assign(new Error('Architecture Design 只能从 uninitialized 状态独立开始。'), {
      code: 'AIH_STAGE_ALREADY_INITIALIZED',
    });
  }

  const writes = [];
  const definitions = artifactDefinitions(project, stageId)
    .filter((item) => item.authorityKind === 'internal-model');
  for (const definition of definitions) {
    const paths = artifactPaths(project, definition.id, stageId);
    if (!definition.template || !definition.schema || !paths?.authorityPath) {
      throw Object.assign(new Error('Architecture Design 产物绑定不完整：' + definition.id), {
        code: 'AIH_PROJECT_BINDING_INVALID',
      });
    }
    const data = await readStructured(root, definition.template, definition.format);
    writes.push({
      target: paths.authorityPath,
      content: stringifyStructured(data, definition.format),
    });
    if (paths.inputRoot) writes.push({ target: paths.inputRoot + '/.gitkeep', content: '' });
    for (const output of preparedArtifactOutputs(project, stageId, definition.id, data)) {
      writes.push({ target: output.output, content: output.content });
    }
    if (definition.areaTemplate) {
      const templateRoot = repositoryFile(root, definition.areaTemplate);
      const files = await readdir(templateRoot, { recursive: true, withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) continue;
        const source = resolve(file.parentPath, file.name);
        const path = relative(templateRoot, source).replaceAll('\\', '/');
        writes.push({
          target: stage.root + '/' + stage.areas['technical-validation'].root + '/' + path,
          content: await readFile(source),
        });
      }
    }
  }

  const nextProject = structuredClone(project);
  nextProject.stages[stageId].status = 'active';
  writes.push({ target: 'psp.project.yaml', content: stringifyYaml(nextProject) });
  const transactionId = await commitManagedWrites({
    root,
    ownerId: 'architecture-design-initialize',
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
    outputs: writes
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
    blockers: [{ code: error.code || 'AIH_ARCHITECTURE_INITIALIZATION_FAILED', message: error.message }],
  };
}

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') {
  console.log('[PASS] Architecture Design 初始产物已建立。');
  for (const path of result.files) console.log('  ' + path);
} else {
  for (const blocker of result.blockers) console.error('[' + blocker.code + '] ' + blocker.message);
}
if (result.status !== 'PASS') process.exitCode = 1;
