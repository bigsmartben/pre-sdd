import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifactCollectionMembers, artifactPaths, readJson, repositoryFile } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

export async function canonicalExpectedOutputs(root, project, manifest) {
  const registry = manifest.artifactRegistry.find((item) => item.id === 'canonical-ui-prototype');
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  if (!registry || !paths) return [];
  const schema = await readJson(root, registry.schema);
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  const members = paths.authorityKind === 'area-set'
    ? await artifactCollectionMembers(root, paths)
    : [{ actor: null, authorityPath: paths.authorityPath }];
  const outputs = [];
  for (const member of members) {
    const model = await extractCanonicalUi(root, member.authorityPath);
    if (member.actor && model.actor !== member.actor) {
      const error = new Error('Canonical UI 目录参与者与 actor 不一致：' + member.actor + ' / ' + model.actor);
      error.code = 'AIH_ARTIFACT_SCHEMA_FAILED';
      throw error;
    }
    if (!validate(model)) {
      const error = new Error('Canonical UI Prototype Schema 校验失败：' + validate.errors.map((item) => item.instancePath + ' ' + item.message).join('; '));
      error.code = 'AIH_ARTIFACT_SCHEMA_FAILED';
      throw error;
    }
    const bindings = paths.authorityKind === 'area-set' ? paths.memberOutputs : paths.outputs;
    for (const output of bindings) {
      const target = paths.authorityKind === 'area-set'
        ? output.root + '/' + member.actor + '/' + output.member
        : output.path;
      outputs.push({
        artifact: registry.id,
        actor: member.actor,
        authorityPath: member.authorityPath,
        output: target,
        role: output.role,
        content: JSON.stringify(model, null, 2) + '\n',
      });
    }
  }
  return outputs;
}

export async function canonicalOutputDrift(root, project, manifest) {
  const drift = [];
  for (const output of await canonicalExpectedOutputs(root, project, manifest)) {
    let actual = null;
    try { actual = await readFile(repositoryFile(root, output.output), 'utf8'); } catch { /* Missing is drift. */ }
    if (actual !== output.content) drift.push(output);
  }
  return drift;
}
