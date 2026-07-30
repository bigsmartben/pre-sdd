import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export async function fixtureProject(root) {
  return parseYaml(await readFile(resolve(root, 'psp.project.yaml'), 'utf8'));
}

export function markReady(data) {
  if (!data.metadata) data.metadata = {};
  data.metadata.status = 'ready';
  data.gaps = [];
  for (const gate of data.gates ?? []) gate.checked = true;
  return data;
}

export async function readArtifact(root, stage, binding) {
  const relativePath = binding.internalModel;
  if (!relativePath) throw new Error('Fixture artifact must bind internalModel.');
  const path = resolve(root, stage.root, relativePath);
  const format = binding.format ?? 'yaml';
  const source = await readFile(path, 'utf8');
  return {
    path,
    format,
    data: format === 'json' ? JSON.parse(source) : parseYaml(source),
  };
}

export async function writeArtifact(artifact) {
  const content = artifact.format === 'json'
    ? JSON.stringify(artifact.data, null, 2) + '\n'
    : stringifyYaml(artifact.data);
  await writeFile(artifact.path, content, 'utf8');
}
