import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifactPaths, readJson, repositoryFile } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

function markdown(model, authorityPath) {
  const rows = (items) => items.length === 0
    ? '| — | — |\n'
    : items.map((item) => '| ' + item.id + ' | ' + (item.title || item.name || item.label || item.path || item.description || '—') + ' |').join('\n') + '\n';
  return [
    '# Canonical UI Prototype',
    '',
    '<!-- GENERATED REVIEW PROJECTION. DO NOT EDIT. Authority: ' + authorityPath + ' -->',
    '',
    '> 本目录中的可执行界面及 `src/spec/canonical-ui.ts` 语义入口共同构成正式界面规格；本文件是面向人的评审投影。',
    '',
    '## 规格摘要',
    '',
    '- 版本：' + model.version,
    '- 路由：' + model.routes.length,
    '- 页面：' + model.screens.length,
    '- 组件：' + model.components.length,
    '- 场景：' + model.scenarios.length,
    '- 未决缺口：' + model.gaps.length,
    '',
    '## Screens（页面）',
    '',
    '| 标识 | 名称 |',
    '|---|---|',
    rows(model.screens).trimEnd(),
    '',
    '## Components（组件）',
    '',
    '| 标识 | 名称 |',
    '|---|---|',
    rows(model.components).trimEnd(),
    '',
    '## Scenarios（场景）',
    '',
    '| 标识 | Use Case |',
    '|---|---|',
    rows(model.scenarios.map((item) => ({ id: item.id, name: item.useCaseId }))).trimEnd(),
    '',
    '## Gaps（缺口）',
    '',
    model.gaps.length === 0 ? '- 无。' : model.gaps.map((gap) => '- ' + gap.id + '：' + gap.description + '（' + gap.owner + '）').join('\n'),
    '',
  ].join('\n');
}

export async function canonicalExpectedOutputs(root, project, manifest) {
  const registry = manifest.artifactRegistry.find((item) => item.id === 'canonical-ui-prototype');
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  if (!registry || !paths) return [];
  const model = await extractCanonicalUi(root, paths.authorityPath);
  const schema = await readJson(root, registry.schema);
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (!validate(model)) {
    const error = new Error('Canonical UI Prototype Schema 校验失败：' + validate.errors.map((item) => item.instancePath + ' ' + item.message).join('; '));
    error.code = 'AIH_ARTIFACT_SCHEMA_FAILED';
    throw error;
  }
  return paths.outputs.map((output) => ({
    artifact: registry.id,
    authorityPath: paths.authorityPath,
    output: output.path,
    role: output.role,
    content: output.path.endsWith('.json')
      ? JSON.stringify(model, null, 2) + '\n'
      : markdown(model, paths.authorityPath),
  }));
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
