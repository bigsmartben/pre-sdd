import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactDefinition,
  artifactPaths,
  loadProject,
  readStructured,
  repositoryFile,
  repositoryRootFrom,
} from '../../../runtime/project.mjs';
import { outputDrift } from './lib/rendering.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const root = repositoryRootFrom(import.meta.dirname);
const strict = process.argv.includes('--strict');
const requested = argument('step', 'all');
const selected = requested === 'all' ? ['capabilities', 'visual-spec'] : [
  requested === 'use-cases' ? 'capabilities' : requested,
];
const blockers = [];
const warnings = [];

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

try {
  const project = await loadProject(root);
  const stage = project.stages?.['product-design'];
  if (!stage) block('AIH_PROJECT_BINDING_INVALID', '缺少 Product Design 阶段绑定。', 'psp.project.yaml');
  else if (stage.status === 'uninitialized') {
    warnings.push({ code: 'AIH_STAGE_UNINITIALIZED', message: 'Product Design 尚未初始化。' });
  } else {
    const models = new Map();
    for (const artifactId of selected) {
      if (!['capabilities', 'visual-spec'].includes(artifactId)) {
        block('AIH_COMMAND_INVALID', `未知 Product Design 检查：${artifactId}`);
        continue;
      }
      const definition = artifactDefinition(project, artifactId, 'product-design');
      const paths = artifactPaths(project, artifactId, 'product-design');
      if (!definition?.schema || !paths?.authorityPath) {
        block('AIH_PROJECT_BINDING_INVALID', `产物绑定不完整：${artifactId}`);
        continue;
      }
      try {
        const model = await readStructured(root, paths.authorityPath, definition.format);
        const schema = JSON.parse(await readFile(repositoryFile(root, definition.schema), 'utf8'));
        const validator = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
        if (!validator(model)) {
          for (const error of validator.errors ?? []) {
            block('AIH_SCHEMA_INVALID', error.message ?? 'Schema 校验失败。', `${artifactId}${error.instancePath}`);
          }
        }
        if (strict && (model?.metadata?.status !== 'ready' || (model?.gaps ?? []).length > 0)) {
          block('AIH_ARTIFACT_INCOMPLETE', `${artifactId} 尚未 ready 或仍有 gap。`, paths.authorityPath);
        }
        models.set(artifactId, model);
      } catch (error) {
        block(error?.code === 'ENOENT' ? 'AIH_ARTIFACT_MISSING' : 'AIH_ARTIFACT_INVALID', error.message, paths.authorityPath);
      }
    }

    const useCases = models.get('capabilities');
    const visual = models.get('visual-spec');
    if (useCases && visual) {
      const useCaseIds = new Set((useCases.useCases ?? []).map((item) => item.id));
      const stateIds = new Set((useCases.interactionStates ?? []).map((item) => item.id));
      for (const [location, refs] of [
        ['visual-spec.pages', (visual.pages ?? []).flatMap((item) => item.useCaseRefs ?? [])],
        ['visual-spec.components', (visual.components ?? []).flatMap((item) => item.useCaseRefs ?? [])],
      ]) {
        for (const id of refs) if (!useCaseIds.has(id)) block('AIH_REFERENCE_UNRESOLVED', `Visual Spec 引用未知 Use Case：${id}`, location);
      }
      for (const [location, refs] of [
        ['visual-spec.renderings', (visual.renderings ?? []).flatMap((item) => item.interactionStateRefs ?? [])],
        ['visual-spec.components', (visual.components ?? []).flatMap((item) => item.interactionStateRefs ?? [])],
      ]) {
        for (const id of refs) if (!stateIds.has(id)) block('AIH_REFERENCE_UNRESOLVED', `Visual Spec 引用未知 Interaction State：${id}`, location);
      }
    }

    for (const drift of await outputDrift(root, project, 'product-design', selected)) {
      block('AIH_GENERATED_DRIFT', '人类视图与机器权威不一致。', drift.output);
    }
  }
} catch (error) {
  block(error.code || 'AIH_PRODUCT_VALIDATION_FAILED', error.message);
}

const status = blockers.length ? 'BLOCKED' : 'PASS';
const result = { status, step: requested, strict, blockers, warnings };
if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else if (status === 'PASS') console.log('[PASS] Product Design 检查通过。');
else for (const item of blockers) console.error(`[${item.code}] ${item.message}`);
process.exitCode = status === 'PASS' ? 0 : 1;
