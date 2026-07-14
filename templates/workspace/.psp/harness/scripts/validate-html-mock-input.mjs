import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { inspectDesignSourceEvidence } from './lib/html-mock-evidence.mjs';
import {
  artifactPaths,
  loadProjectAndManifest,
  repositoryFile,
  repositoryRootFrom,
} from './lib/repository.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const json = process.argv.includes('--json');
const blockers = [];
const warnings = [];

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

async function readModel(project, artifactId) {
  const paths = artifactPaths(project, artifactId, 'product-design');
  if (!paths) throw new Error('项目未绑定 artifact：' + artifactId);
  return parseYaml(await readFile(repositoryFile(root, paths.internalModel), 'utf8'));
}

let project;
let manifest;
try {
  ({ project, manifest } = await loadProjectAndManifest(root));
  const stage = project.stages?.['product-design'];
  if (!stage) block('AIH_PROJECT_BINDING_INVALID', '项目未绑定 product-design 阶段。', 'stages.product-design');
  else if (stage.status === 'uninitialized') block('AIH_STAGE_UNINITIALIZED', '产品设计阶段尚未初始化。', 'stages.product-design.status');
  else if (stage.status !== 'active') block('AIH_PROJECT_BINDING_INVALID', '产品设计阶段不可作为 HTML Mock 输入：' + stage.status, 'stages.product-design.status');

  if (blockers.length === 0) {
    const models = new Map();
    for (const artifactId of ['product-package', 'capabilities', 'interactions', 'ui-spec']) {
      models.set(artifactId, await readModel(project, artifactId));
    }
    for (const artifactId of ['product-package', 'capabilities', 'interactions']) {
      const model = models.get(artifactId);
      if (model.metadata?.status !== 'ready') {
        block('AIH_UPSTREAM_NOT_READY', artifactId + ' status 不是 ready。', artifactId + '.metadata.status');
      }
      if (model.gaps?.length > 0) {
        block('AIH_UPSTREAM_NOT_READY', artifactId + ' 仍存在显式 gap。', artifactId + '.gaps');
      }
      for (const gate of model.gates || []) {
        if (!gate.checked) block('AIH_UPSTREAM_NOT_READY', '上游门禁未完成：' + gate.label, artifactId + '.gates.' + gate.id);
      }
    }
    const capabilities = models.get('capabilities');
    const interactions = models.get('interactions');
    const uiSpec = models.get('ui-spec');
    for (const [location, values] of [
      ['capabilities.useCases', capabilities.useCases],
      ['interactions.wireflows', interactions.wireflows],
      ['interactions.screens', interactions.screens],
      ['interactions.interactionStates', interactions.interactionStates],
      ['ui-spec.designSources', uiSpec.designSources],
    ]) {
      if (!values?.length) block('AIH_UPSTREAM_NOT_READY', 'HTML Mock 输入要求至少一个正式条目。', location);
    }
    for (const source of uiSpec.designSources || []) {
      if (source.status !== 'available') {
        block('AIH_UPSTREAM_NOT_READY', '设计来源尚未完整可用：' + source.id, 'ui-spec.designSources.' + source.id + '.status');
      }
    }
    for (const issue of await inspectDesignSourceEvidence(root, stage, uiSpec.designSources)) {
      block(issue.code, issue.message, issue.location);
    }
  }
} catch (error) {
  block(error.code || 'AIH_PROJECT_BINDING_INVALID', error.message);
}

const result = {
  status: blockers.length === 0 ? 'PASS' : 'BLOCKED',
  gate: 'html-mock-input',
  sourceCount: project && blockers.length === 0
    ? (await readModel(project, 'ui-spec')).designSources.length
    : 0,
  blockerCount: blockers.length,
  blockers,
  warnings,
};

if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] HTML Mock 上游输入门禁通过。');
else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);

if (result.status !== 'PASS') process.exitCode = 1;
