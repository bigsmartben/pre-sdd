import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifactCollectionMembers, artifactPaths, readJson, repositoryFile } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

function markdown(model, authorityPath) {
  const rows = (items) => items.length === 0
    ? '| — | — |\n'
    : items.map((item) => '| ' + item.id + ' | ' + (item.title || item.name || item.label || item.path || item.description || '—') + ' |').join('\n') + '\n';
  const mappingRows = model.componentMappings.length === 0
    ? '| — | — | — |\n'
    : model.componentMappings.map((item) => '| ' + item.id + ' | ' + item.figmaComponentNodeId + ' | `' + item.litTagName + '` |').join('\n') + '\n';
  const coverageRows = model.componentVariantCoverage.length === 0
    ? '| — | — | — |\n'
    : model.componentVariantCoverage.map((item) => '| ' + item.id + ' | ' + item.mappingId + ' | ' + item.instanceNodeIds.length + ' |').join('\n') + '\n';
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
    '- 参与者：' + model.actor,
    '- 路由：' + model.routes.length,
    '- 页面：' + model.screens.length,
    '- 组件：' + model.components.length,
    '- 组件抽象决策：' + model.componentInventory.length,
    '- Figma ↔ Lit 映射：' + model.componentMappings.length,
    '- Variant 覆盖行：' + model.componentVariantCoverage.length,
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
    '## Component Mapping（组件映射）',
    '',
    '| 标识 | Figma 节点 | Lit 元素 |',
    '|---|---|---|',
    mappingRows.trimEnd(),
    '',
    '## Variant Coverage（变体覆盖）',
    '',
    '| 标识 | 映射 | 实例数 |',
    '|---|---|---|',
    coverageRows.trimEnd(),
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
        content: target.endsWith('.json')
          ? JSON.stringify(model, null, 2) + '\n'
          : markdown(model, member.authorityPath),
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
