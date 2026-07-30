import { readFile } from 'node:fs/promises';
import {
  artifactDefinitions,
  artifactPaths,
  readStructured,
  repositoryFile,
} from '../../../../runtime/project.mjs';

function cell(value) {
  return String(value ?? '—').replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
}

function renderCapabilities(data) {
  const lines = [
    '# ' + (data.intent?.productName || 'Product Use Cases'),
    '',
    '> 此文档由 `PRODUCT-USE-CASES` 确定性生成；机器权威位于 `.psp/models/use-cases.yaml`。',
    '',
    '## 产品意图',
    '',
    data.intent?.productConcept || '—',
    '',
    '## 用例',
    '',
    '| ID | 名称 | Actor | 目标 |',
    '| --- | --- | --- | --- |',
  ];
  for (const useCase of data.useCases ?? []) {
    lines.push(`| ${cell(useCase.id)} | ${cell(useCase.name)} | ${cell(useCase.actor)} | ${cell(useCase.goal)} |`);
  }
  if (!(data.useCases ?? []).length) lines.push('| — | — | — | — |');
  lines.push('', '## 未决 Gap', '');
  for (const gap of data.gaps ?? []) lines.push(`- ${cell(gap.id)}：${cell(gap.reason)}`);
  if (!(data.gaps ?? []).length) lines.push('- 无');
  return lines.join('\n') + '\n';
}

export async function preparedArtifactOutputs(root, project, stageId, artifactId, data) {
  const paths = artifactPaths(project, artifactId, stageId);
  if (!paths) throw Object.assign(new Error('产物未注册：' + artifactId), { code: 'AIH_PROJECT_BINDING_INVALID' });
  if (artifactId !== 'capabilities') return [];
  return paths.outputs.map((output) => ({
    authorityPath: paths.authorityPath,
    output: output.path,
    role: output.role,
    content: renderCapabilities(data),
  }));
}

export async function writeExpectedOutputs(root, project, stageId) {
  const results = [];
  for (const definition of artifactDefinitions(project, stageId)) {
    const paths = artifactPaths(project, definition.id, stageId);
    if (!paths?.authorityPath) continue;
    const data = await readStructured(root, paths.authorityPath, definition.format);
    results.push(...await preparedArtifactOutputs(root, project, stageId, definition.id, data));
  }
  return results;
}

export async function outputDrift(root, project, stageId, selected = null) {
  const ids = selected ? new Set(selected) : null;
  const expected = await writeExpectedOutputs(root, project, stageId);
  const drift = [];
  for (const item of expected) {
    if (ids && !ids.has('capabilities')) continue;
    let actual = null;
    try { actual = await readFile(repositoryFile(root, item.output), 'utf8'); } catch { /* missing */ }
    if (actual !== item.content) drift.push({
      internalModel: item.authorityPath,
      output: item.output,
    });
  }
  return drift;
}
