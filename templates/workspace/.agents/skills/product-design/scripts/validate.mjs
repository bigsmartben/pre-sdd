import { readFile } from 'node:fs/promises';
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
const requested = argument('step', 'all');
const selected = requested === 'all'
  ? ['capabilities', 'functional-delivery-baseline']
  : [requested === 'use-cases' ? 'capabilities' : requested];
const strict = process.argv.includes('--strict');
const blockers = [];
const warnings = [];
const block = (code, message, location) => blockers.push({ code, message, ...(location ? { location } : {}) });

try {
  const project = await loadProject(root);
  const stage = project.stages?.['product-design'];
  if (!stage) block('AIH_PROJECT_BINDING_INVALID', '缺少 Product Design 阶段绑定。', 'psp.project.yaml');
  else if (stage.status === 'uninitialized') warnings.push({ code: 'AIH_STAGE_UNINITIALIZED', message: 'Product Design 尚未初始化。' });
  else {
    const models = new Map();
    for (const artifactId of selected) {
      if (!['capabilities', 'functional-delivery-baseline'].includes(artifactId)) {
        block('AIH_COMMAND_INVALID', '未知 Product Design 检查：' + artifactId);
        continue;
      }
      const definition = artifactDefinition(project, artifactId, 'product-design');
      const paths = artifactPaths(project, artifactId, 'product-design');
      if (!definition?.schema || !paths?.authorityPath) {
        block('AIH_PROJECT_BINDING_INVALID', '产物绑定不完整：' + artifactId);
        continue;
      }
      try {
        const model = await readStructured(root, paths.authorityPath, definition.format);
        const schema = JSON.parse(await readFile(repositoryFile(root, definition.schema), 'utf8'));
        const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
        if (!validate(model)) {
          for (const error of validate.errors ?? []) {
            block('AIH_SCHEMA_INVALID', error.message ?? 'Schema 校验失败。', artifactId + (error.instancePath || ''));
          }
        }
        if (strict && (model?.metadata?.status !== 'ready' || (model?.gaps ?? []).length > 0)) {
          block('AIH_ARTIFACT_INCOMPLETE', artifactId + ' 尚未 ready 或仍有 gap。', paths.authorityPath);
        }
        models.set(artifactId, model);
      } catch (error) {
        block(error.code === 'ENOENT' ? 'AIH_ARTIFACT_MISSING' : 'AIH_ARTIFACT_INVALID', error.message, paths.authorityPath);
      }
    }
    const useCases = models.get('capabilities');
    const baseline = models.get('functional-delivery-baseline');
    if (useCases && baseline) {
      const ids = new Set([
        ...(useCases.useCases ?? []).flatMap((item) => [
          item.id,
          ...(item.mainScenario ?? []).map((step) => step.id),
          ...(item.alternateScenarios ?? []).flatMap((scenario) => [scenario.id, ...(scenario.steps ?? []).map((step) => step.id)]),
        ]),
        ...(useCases.interactionStates ?? []).map((item) => item.id),
        ...(useCases.lowFiUiBlueprints ?? []).flatMap((blueprint) => [
          blueprint.screen?.id,
          ...(blueprint.screen?.regions ?? []).flatMap((region) => [region.id, ...(region.controls ?? []).map((control) => control.id)]),
        ]),
      ].filter(Boolean));
      for (const [index, item] of (baseline.items ?? []).entries()) {
        for (const ref of item.targetRefs ?? []) {
          if (!ids.has(ref)) block('VISUAL_SPEC_BASELINE_REF_INVALID', 'Baseline 引用未知产品身份：' + ref, `items[${index}].targetRefs`);
        }
      }
    }
    for (const drift of await outputDrift(root, project, 'product-design', selected)) {
      block('AIH_GENERATED_DRIFT', 'UC.md 与机器权威不一致。', drift.output);
    }
  }
} catch (error) {
  block(error.code || 'AIH_PRODUCT_VALIDATION_FAILED', error.message);
}

const result = { status: blockers.length ? 'BLOCKED' : 'PASS', step: requested, strict, blockers, warnings };
if (process.argv.includes('--json')) console.log(JSON.stringify(result));
else if (result.status === 'PASS') console.log('[PASS] Product Design 检查通过。');
else for (const item of blockers) console.error(`[${item.code}] ${item.message}`);
if (result.status !== 'PASS') process.exitCode = 1;
