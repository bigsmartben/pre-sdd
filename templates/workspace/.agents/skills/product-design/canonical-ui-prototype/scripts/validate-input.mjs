import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { artifactPaths, loadProjectAndManifest, readJson, readStructured, repositoryFile, repositoryRootFrom } from '../../../../../.psp/harness/scripts/lib/repository.mjs';
import { extractCanonicalUi } from './extract.mjs';

const root = repositoryRootFrom(resolve(import.meta.dirname, '../..'));
const json = process.argv.includes('--json');
const blockers = [];

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

async function sha256(path) {
  return 'sha256:' + createHash('sha256').update(await readFile(path)).digest('hex');
}

function sourceLocation(source) {
  return 'designSources.' + source.id;
}

function areaFile(areaDirectory, path) {
  if (typeof path !== 'string' || path.startsWith('/') || path.includes('\\') || path.split('/').includes('..')) {
    throw Object.assign(new Error('证据路径必须位于 Canonical UI Prototype Area 内：' + String(path)), { code: 'AIH_SOURCE_INTEGRITY_FAILED' });
  }
  const target = resolve(areaDirectory, ...path.split('/'));
  if (target !== areaDirectory && !target.startsWith(areaDirectory + sep)) {
    throw Object.assign(new Error('证据路径越出 Canonical UI Prototype Area：' + path), { code: 'AIH_SOURCE_INTEGRITY_FAILED' });
  }
  return target;
}

function figmaNodeId(location) {
  try {
    const url = new URL(location);
    if (!/^\/(?:design)\//.test(url.pathname)) return null;
    const raw = url.searchParams.get('node-id');
    return /^[0-9]+[-:][0-9]+$/.test(raw || '') ? raw.replace('-', ':') : null;
  } catch {
    return null;
  }
}

try {
  const { project, manifest } = await loadProjectAndManifest(root);
  const stage = project.stages?.['product-design'];
  if (stage?.status !== 'active') throw Object.assign(new Error('产品设计阶段尚未初始化。'), { code: 'AIH_STAGE_UNINITIALIZED' });
  for (const artifactId of ['product-package', 'capabilities', 'interactions']) {
    const registry = manifest.artifactRegistry.find((item) => item.id === artifactId);
    const paths = artifactPaths(project, artifactId, 'product-design');
    const model = await readStructured(root, paths.authorityPath, registry.format);
    if (model.metadata?.status !== 'ready' || model.gaps?.length > 0 || model.gates?.some((gate) => gate.checked !== true)) {
      block('AIH_UPSTREAM_NOT_READY', '上游产物未达到严格就绪：' + artifactId, paths.authorityPath);
    }
  }

  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const model = await extractCanonicalUi(root, paths.authorityPath);
  const areaPath = stage.root + '/' + stage.areas[paths.area].root;
  const areaDirectory = repositoryFile(root, areaPath);
  const evidenceSchema = await readJson(root, '.agents/skills/product-design/canonical-ui-prototype/design-source-evidence.schema.json');
  const validateEvidence = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(evidenceSchema);
  const evidenceAssets = new Map();

  if (model.designSources.length === 0) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Canonical UI Prototype 必须声明至少一个设计来源。', 'designSources');
  }

  for (const source of model.designSources) {
    const location = sourceLocation(source);
    if (source.status === 'blocked') {
      block('AIH_SOURCE_CAPTURE_BLOCKED', '设计来源无法采集：' + source.id, location);
      continue;
    }
    if (source.status === 'partial') {
      block('AIH_SOURCE_COVERAGE_FAILED', '设计来源仅覆盖部分声明范围：' + source.id, location);
    }
    const expectedNodeId = source.kind === 'figma' ? figmaNodeId(source.location) : null;
    if (source.kind === 'figma' && !expectedNodeId) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma 来源必须是带 node-id 的 /design/ 节点链接：' + source.id, location);
      continue;
    }
    if (!source.evidence?.path || !source.evidence?.sha256) {
      block('AIH_SOURCE_INTEGRITY_FAILED', '设计来源缺少证据清单或内容哈希：' + source.id, location);
      continue;
    }

    try {
      const manifestPath = areaFile(areaDirectory, source.evidence.path);
      const actualManifestHash = await sha256(manifestPath);
      if (actualManifestHash !== source.evidence.sha256) {
        block('AIH_SOURCE_INTEGRITY_FAILED', '设计来源证据清单内容哈希不匹配：' + source.id, location);
        continue;
      }

      const evidence = JSON.parse(await readFile(manifestPath, 'utf8'));
      if (!validateEvidence(evidence)) {
        for (const error of validateEvidence.errors || []) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '证据清单结构无效：' + (error.instancePath || '/') + ' ' + error.message, source.evidence.path);
        }
        continue;
      }
      for (const field of ['sourceId', 'kind', 'location', 'capturedAt']) {
        const expected = field === 'sourceId' ? source.id : source[field];
        if (evidence[field] !== expected) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '证据清单 ' + field + ' 与 Canonical UI 不一致。', source.evidence.path);
        }
      }
      if (source.kind === 'figma' && evidence.nodeId !== expectedNodeId) {
        block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma 证据清单 nodeId 与来源节点不一致。', source.evidence.path);
      }

      const evidenceIds = new Set();
      evidenceAssets.set(source.id, new Set());
      for (const item of evidence.items) {
        if (evidenceIds.has(item.id)) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '证据项标识重复：' + item.id, source.evidence.path);
          continue;
        }
        evidenceIds.add(item.id);
        if (item.role === 'asset') evidenceAssets.get(source.id).add(item.path);
        const itemPath = areaFile(areaDirectory, item.path);
        if (await sha256(itemPath) !== item.sha256) {
          block('AIH_SOURCE_INTEGRITY_FAILED', '设计来源证据文件内容哈希不匹配：' + item.id, item.path);
        }
      }
      for (const coverage of source.coverage) {
        for (const evidenceItemId of coverage.evidenceItemIds) {
          if (!evidenceIds.has(evidenceItemId)) {
            block('AIH_SOURCE_COVERAGE_FAILED', '覆盖范围引用未知证据项：' + evidenceItemId, location);
          }
        }
      }
    } catch (error) {
      block(error.code || 'AIH_SOURCE_INTEGRITY_FAILED', '无法读取设计来源证据：' + error.message, location);
    }
  }

  for (const asset of model.assets) {
    for (const sourceId of asset.sourceIds) {
      if (!evidenceAssets.get(sourceId)?.has(asset.path)) {
        block('AIH_SOURCE_INTEGRITY_FAILED', '资源未出现在对应设计来源的证据清单：' + asset.id + ' / ' + sourceId, asset.path);
      }
    }
  }
} catch (error) {
  block(error.code || 'AIH_PROJECT_BINDING_INVALID', error.message);
}

const result = { status: blockers.length === 0 ? 'PASS' : 'BLOCKED', blockers };
if (json) console.log(JSON.stringify(result, null, 2));
else if (result.status === 'PASS') console.log('[PASS] Canonical UI Prototype 输入门禁通过。');
else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
if (result.status !== 'PASS') process.exitCode = 1;
