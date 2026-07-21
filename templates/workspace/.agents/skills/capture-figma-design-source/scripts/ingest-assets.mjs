#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactPaths,
  loadProjectAndManifest,
  readJson,
  repositoryFile,
  repositoryRootFrom,
} from '../../../../.psp/harness/scripts/lib/repository.mjs';
import { analyzePng } from './validate-png-assets.mjs';

const root = repositoryRootFrom(import.meta.dirname);
const json = process.argv.includes('--json');
const blockers = [];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function block(code, message, location) {
  blockers.push({ code, message, ...(location ? { location } : {}) });
}

function sha256(content) {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function within(directory, path) {
  const base = resolve(directory);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}

function packetFile(packetPath, relativePath) {
  const directory = dirname(packetPath);
  const target = resolve(directory, ...relativePath.split('/'));
  if (!within(directory, target)) {
    throw Object.assign(new Error('Acquisition Packet 文件越出会话临时目录：' + relativePath), { code: 'AIH_ASSET_MISSING' });
  }
  return target;
}

function areaFile(areaDirectory, relativePath) {
  const target = resolve(areaDirectory, ...relativePath.split('/'));
  if (!within(areaDirectory, target)) {
    throw Object.assign(new Error('Asset 目标越出 Canonical UI Area：' + relativePath), { code: 'AIH_ASSET_CLOSURE_FAILED' });
  }
  return target;
}

function expectedExportDimensions(assetExport) {
  return {
    width: Math.round(assetExport.cropBounds.width * assetExport.scale),
    height: Math.round(assetExport.cropBounds.height * assetExport.scale),
  };
}

function svgDimensions(content) {
  const source = content.toString('utf8');
  const tag = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!tag) throw new Error('SVG 缺少根 <svg> 元素');
  const number = (name) => {
    const value = tag.match(new RegExp('\\\\s' + name + '=["\\\']([0-9]+(?:\\\\.[0-9]+)?)(?:px)?["\\\']', 'i'))?.[1];
    return value ? Number(value) : null;
  };
  const width = number('width');
  const height = number('height');
  if (width && height) return { width: Math.round(width), height: Math.round(height) };
  const viewBox = tag.match(/\sviewBox=["']\s*[-+0-9.eE]+\s+[-+0-9.eE]+\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s*["']/i);
  if (!viewBox) throw new Error('SVG 缺少可验证的 width/height 或 viewBox');
  return { width: Math.round(Number(viewBox[1])), height: Math.round(Number(viewBox[2])) };
}

function pngPadding(analysis) {
  if (!analysis.contentBounds) return null;
  const [left, top, rightEdge, bottomEdge] = analysis.contentBounds;
  return {
    top,
    right: analysis.width - rightEdge - 1,
    bottom: analysis.height - bottomEdge - 1,
    left,
  };
}

async function validatePacket(schemaPath, value, label) {
  const schema = await readJson(root, schemaPath);
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (validate(value)) return true;
  for (const error of validate.errors || []) {
    block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', label + ' 结构无效：' + (error.instancePath || '/') + ' ' + error.message, schemaPath);
  }
  return false;
}

function sameStringSet(left, right) {
  return left.length === right.length && [...new Set(left)].every((item) => right.includes(item));
}

function validateConfirmedWorkflow(capturePlan) {
  const scope = capturePlan.scopeConfirmation;
  const impact = capturePlan.highImpactConfirmation;
  const boundary = capturePlan.writebackBoundary;
  const includedNodeIds = new Set(scope.includedNodes.map((item) => item.nodeId));
  const includedVisualNodeIds = new Set(scope.includedNodes.filter((item) => item.kind === 'visual').map((item) => item.nodeId));
  const includedComponentNodeIds = new Set(scope.includedNodes.filter((item) => item.kind === 'component').map((item) => item.nodeId));
  const includedKeys = new Set(scope.includedNodes.map((item) => item.kind + ':' + item.nodeId));

  if (scope.rootNodeId !== capturePlan.rootNodeId || !includedNodeIds.has(capturePlan.rootNodeId)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope Confirmation 的根节点必须与 Capture Plan 一致并位于包含范围。', 'scopeConfirmation.rootNodeId');
  }
  for (const item of scope.excludedNodes) {
    if (includedKeys.has(item.kind + ':' + item.nodeId)) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', '同一节点不能同时被范围确认包含和排除：' + item.nodeId, 'scopeConfirmation');
    }
  }
  const expectedCounts = {
    pages: scope.includedNodes.filter((item) => item.kind === 'page').length,
    components: scope.includedNodes.filter((item) => item.kind === 'component').length,
    visualNodes: scope.includedNodes.filter((item) => item.kind === 'visual').length,
    viewports: scope.viewportIds.length,
    scenarios: scope.scenarioIds.length,
    states: scope.stateIds.length,
  };
  if (!same(scope.counts, expectedCounts)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope Confirmation 的数量摘要与已确认包含项不一致。', 'scopeConfirmation.counts');
  }
  for (const candidate of capturePlan.candidateVisualNodes) {
    if (!includedVisualNodeIds.has(candidate.nodeId)) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', 'Capture Plan 自行扩大到未确认的视觉节点：' + candidate.nodeId, 'candidateVisualNodes');
    }
  }

  if (
    impact.scopeConfirmationId !== scope.id
    || boundary.scopeConfirmationId !== scope.id
    || boundary.highImpactConfirmationId !== impact.id
    || impact.id === scope.id
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '两个人工确认点与写回边界的身份引用不闭合。', 'highImpactConfirmation');
  }
  for (const proposal of impact.componentProposals) {
    if (!includedComponentNodeIds.has(proposal.nodeId)) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', '组件抽象提案越出已确认范围：' + proposal.nodeId, 'highImpactConfirmation.componentProposals');
    }
    if (proposal.decision === 'shared-component' && !proposal.componentName) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', 'shared-component 提案必须记录组件名称：' + proposal.nodeId, 'highImpactConfirmation.componentProposals');
    }
  }
  const candidates = new Map(capturePlan.candidateVisualNodes.map((item) => [item.nodeId, item]));
  for (const ambiguity of impact.resourceAmbiguities) {
    if (!includedVisualNodeIds.has(ambiguity.nodeId) || candidates.get(ambiguity.nodeId)?.strategy !== ambiguity.decision) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', '资源歧义决策必须位于确认范围并与最终分类一致：' + ambiguity.nodeId, 'highImpactConfirmation.resourceAmbiguities');
    }
  }

  const operationIds = impact.writebackOperations.map((item) => item.id);
  if (new Set(operationIds).size !== operationIds.length || !sameStringSet(operationIds, boundary.operationIds)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '写回边界必须完整引用第二次人工确认的有限写回操作。', 'writebackBoundary.operationIds');
  }
  const approvedDetachNodes = new Set(impact.detachApprovals.map((item) => item.instanceNodeId));
  const requestedDetachNodes = new Set();
  for (const operation of impact.writebackOperations) {
    for (const nodeId of operation.targetNodeIds) {
      if (!includedNodeIds.has(nodeId)) {
        block('AIH_SOURCE_CAPTURE_BLOCKED', 'Figma 写回越出已确认范围：' + nodeId, operation.id);
      }
      if (operation.kind === 'detach-instance') {
        requestedDetachNodes.add(nodeId);
        if (!approvedDetachNodes.has(nodeId)) {
          block('AIH_SOURCE_CAPTURE_BLOCKED', 'Detach Instance 只允许具体阻断实例获得明确批准后执行：' + nodeId, operation.id);
        }
      }
    }
  }
  if (!sameStringSet([...approvedDetachNodes], [...requestedDetachNodes])) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Detach Instance 批准项必须与有限写回中的具体实例一一对应。', 'highImpactConfirmation.detachApprovals');
  }

  const scopeAt = Date.parse(scope.confirmedAt);
  const impactAt = Date.parse(impact.confirmedAt);
  const writebackAt = Date.parse(boundary.completedAt);
  const frozenAt = Date.parse(capturePlan.frozenAt);
  if (!(scopeAt <= impactAt && impactAt <= writebackAt && writebackAt < frozenAt)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '必须先确认范围，再确认高影响决策，合并完成全部写回，最后执行唯一一次正式采集。', 'frozenAt');
  }
}

const actor = argument('--actor');
const capturePlanArgument = argument('--capture-plan');
const acquisitionArgument = argument('--acquisition');

try {
  if (!actor || !/^ACTOR-[0-9]{3}$/.test(actor)) {
    block('AIH_ASSET_CLOSURE_FAILED', '必须使用 --actor ACTOR-NNN 指定 Canonical UI 参与者。', '--actor');
  }
  if (!capturePlanArgument || !acquisitionArgument) {
    block('AIH_ASSET_MISSING', '必须同时提供 --capture-plan 与 --acquisition。');
  }

  const capturePlanPath = capturePlanArgument ? resolve(capturePlanArgument) : null;
  const acquisitionPath = acquisitionArgument ? resolve(acquisitionArgument) : null;
  if (capturePlanPath && !within(tmpdir(), capturePlanPath)) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Capture Plan 必须位于操作系统临时目录。', capturePlanPath);
  }
  if (acquisitionPath && !within(tmpdir(), acquisitionPath)) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Acquisition Packet 必须位于操作系统临时目录。', acquisitionPath);
  }

  if (blockers.length === 0) {
    const [capturePlanContent, acquisitionContent] = await Promise.all([
      readFile(capturePlanPath),
      readFile(acquisitionPath),
    ]);
    const capturePlan = JSON.parse(capturePlanContent.toString('utf8'));
    const acquisition = JSON.parse(acquisitionContent.toString('utf8'));
    const [planValid, acquisitionValid] = await Promise.all([
      validatePacket('.agents/skills/capture-figma-design-source/capture-plan.schema.json', capturePlan, 'Capture Plan'),
      validatePacket('.agents/skills/capture-figma-design-source/acquisition-packet.schema.json', acquisition, 'Acquisition Packet'),
    ]);

    if (planValid && acquisitionValid) {
      validateConfirmedWorkflow(capturePlan);
      if (capturePlan.sourceId !== acquisition.sourceId || !same(capturePlan.sourceVersion, acquisition.sourceVersion)) {
        block('AIH_ASSET_CLOSURE_FAILED', 'Capture Plan 与 Acquisition Packet 的来源身份或版本不一致。');
      }
      const capturePlanHash = sha256(capturePlanContent);
      if (capturePlanHash !== acquisition.capturePlanSha256) {
        block('AIH_ASSET_HASH_MISMATCH', 'Acquisition Packet 引用的 Capture Plan 哈希不匹配。', acquisitionPath);
      }
      if (acquisition.downloadOperation !== capturePlan.candidateVisualNodes.find((item) => item.strategy === 'asset')?.assetExport.downloadOperation && acquisition.files.length > 0) {
        block('AIH_ASSET_CLOSURE_FAILED', 'Acquisition Packet 下载操作与 Capture Plan 不一致。', acquisition.downloadOperation);
      }

      const candidates = new Map();
      for (const candidate of capturePlan.candidateVisualNodes) {
        if (candidates.has(candidate.nodeId)) {
          block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', '视觉候选节点存在多个 strategy：' + candidate.nodeId, 'candidateVisualNodes');
        }
        candidates.set(candidate.nodeId, candidate);
      }
      const plannedAssets = new Map(
        capturePlan.candidateVisualNodes
          .filter((candidate) => candidate.strategy === 'asset')
          .map((candidate) => [candidate.nodeId, candidate]),
      );
      const acquiredAssets = new Map();
      for (const file of acquisition.files) {
        if (acquiredAssets.has(file.sourceNodeId)) {
          block('AIH_ASSET_CLOSURE_FAILED', '同一 asset 节点被下载多次：' + file.sourceNodeId, 'files');
        }
        acquiredAssets.set(file.sourceNodeId, file);
        if (!plannedAssets.has(file.sourceNodeId)) {
          block('AIH_ASSET_CLOSURE_FAILED', '下载文件没有对应的 asset 分类节点：' + file.sourceNodeId, file.path);
        }
      }
      for (const nodeId of plannedAssets.keys()) {
        if (!acquiredAssets.has(nodeId)) block('AIH_ASSET_MISSING', '已分类 asset 缺少下载文件：' + nodeId, 'candidateVisualNodes');
      }

      const { project, manifest } = await loadProjectAndManifest(root);
      if (project.stages?.['product-design']?.status !== 'active') {
        block('AIH_STAGE_UNINITIALIZED', 'Asset Ingest 只允许在 active Product Design 阶段执行。', 'product-design');
      }
      const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
      const areaDirectory = repositoryFile(root, paths.authorityRoot + '/' + actor);
      try { await access(areaDirectory); } catch { block('AIH_ASSET_CLOSURE_FAILED', 'Canonical UI 参与者 Area 不存在：' + actor, paths.authorityRoot); }
      const artifact = manifest.artifactRegistry.find((item) => item.id === 'canonical-ui-prototype');
      if (!artifact || artifact.authorityKind !== 'area-set') {
        block('AIH_ASSET_CLOSURE_FAILED', 'Canonical UI Artifact 未绑定 area-set。', 'canonical-ui-prototype');
      }

      const verified = [];
      const destinations = new Set();
      for (const [nodeId, candidate] of plannedAssets) {
        const file = acquiredAssets.get(nodeId);
        if (!file) continue;
        const planned = candidate.assetExport;
        if (
          file.targetPath !== planned.targetPath
          || file.format !== planned.format
          || file.scale !== planned.scale
          || !same(file.cropBounds, planned.cropBounds)
          || !same(file.transparentPadding, planned.transparentPadding)
          || !same(file.dimensions, planned.expectedDimensions)
          || acquisition.downloadOperation !== planned.downloadOperation
        ) {
          block('AIH_ASSET_CLOSURE_FAILED', '下载参数与 Capture Plan 不一致：' + nodeId, file.path);
          continue;
        }
        if (!same(expectedExportDimensions(planned), planned.expectedDimensions)) {
          block('AIH_ASSET_CLOSURE_FAILED', '预期尺寸不等于 cropBounds × scale：' + nodeId, planned.targetPath);
          continue;
        }
        if (!file.targetPath.startsWith('public/assets/' + capturePlan.sourceId + '/')) {
          block('AIH_ASSET_CLOSURE_FAILED', 'Asset 目标必须位于当前 sourceId 的正式目录：' + file.targetPath, nodeId);
          continue;
        }
        if (destinations.has(file.targetPath)) {
          block('AIH_ASSET_CLOSURE_FAILED', '多个来源节点写入同一 Asset：' + file.targetPath, nodeId);
          continue;
        }
        destinations.add(file.targetPath);
        const sourcePath = packetFile(acquisitionPath, file.path);
        let content;
        try { content = await readFile(sourcePath); }
        catch { block('AIH_ASSET_MISSING', 'Acquisition Packet 文件不存在：' + file.path, nodeId); continue; }
        if (sha256(content) !== file.sha256) {
          block('AIH_ASSET_HASH_MISMATCH', '下载文件内容哈希不匹配：' + file.path, nodeId);
          continue;
        }
        if (extname(file.path).toLowerCase() !== '.' + file.format || extname(file.targetPath).toLowerCase() !== '.' + file.format) {
          block('AIH_ASSET_CLOSURE_FAILED', '文件扩展名与声明格式不一致：' + file.path, nodeId);
          continue;
        }
        try {
          let actualDimensions;
          if (file.format === 'png') {
            const analysis = await analyzePng(sourcePath, { edgeMargin: 1 });
            actualDimensions = { width: analysis.width, height: analysis.height };
            const expectedPadding = file.transparentPadding;
            if (Object.values(expectedPadding).some((value) => value > 0)) {
              if (analysis.errors.length > 0 || !same(pngPadding(analysis), expectedPadding)) {
                block('AIH_ASSET_CLOSURE_FAILED', 'PNG 透明边距与 Capture Plan 不一致：' + file.path, nodeId);
              }
            }
          } else {
            actualDimensions = svgDimensions(content);
          }
          if (!same(actualDimensions, file.dimensions)) {
            block('AIH_ASSET_CLOSURE_FAILED', 'Asset 实际尺寸与预期尺寸不一致：' + file.path, nodeId);
          }
        } catch (error) {
          block('AIH_ASSET_CLOSURE_FAILED', '无法验证 Asset 格式或尺寸：' + error.message, nodeId);
        }
        const target = areaFile(areaDirectory, file.targetPath);
        try {
          const existing = await readFile(target);
          const existingHash = sha256(existing);
          if (existingHash !== file.sha256 && existingHash !== planned.previousSha256) {
            block('AIH_ASSET_INGEST_CONFLICT', '正式 Asset 已存在且不匹配 previousSha256：' + file.targetPath, nodeId);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        verified.push({ candidate, file, sourcePath, target });
      }

      if (blockers.length === 0) {
        const formalPlanPath = 'design-sources/' + capturePlan.sourceId + '/capture-plan.json';
        const formalReceiptPath = 'design-sources/' + capturePlan.sourceId + '/ingest-receipt.json';
        const receipt = {
          version: '1.0.0',
          sourceId: capturePlan.sourceId,
          sourceVersion: capturePlan.sourceVersion,
          capturePlan: { path: formalPlanPath, sha256: capturePlanHash },
          downloadOperation: acquisition.downloadOperation,
          ingestedAt: new Date().toISOString(),
          assets: verified.map(({ candidate, file }) => ({
            sourceNodeId: file.sourceNodeId,
            path: file.targetPath,
            format: file.format,
            scale: file.scale,
            cropBounds: file.cropBounds,
            transparentPadding: file.transparentPadding,
            expectedDimensions: file.dimensions,
            sha256: file.sha256,
            consumerTargets: candidate.consumerTargets,
            status: 'verified',
          })),
          status: 'PASS',
        };
        const writes = [
          { target: areaFile(areaDirectory, formalPlanPath), content: capturePlanContent },
          { target: areaFile(areaDirectory, formalReceiptPath), content: Buffer.from(JSON.stringify(receipt, null, 2) + '\n') },
          ...verified.map((item) => ({ target: item.target, source: item.sourcePath })),
        ];
        for (const write of writes) {
          await mkdir(dirname(write.target), { recursive: true });
          if (write.source) await copyFile(write.source, write.target);
          else await writeFile(write.target, write.content);
        }
        const result = {
          status: 'PASS',
          sourceId: capturePlan.sourceId,
          actor,
          capturePlan: formalPlanPath,
          receipt: formalReceiptPath,
          assets: receipt.assets,
        };
        if (json) console.log(JSON.stringify(result, null, 2));
        else console.log('[PASS] 已受控导入 ' + receipt.assets.length + ' 个 Figma Asset。');
      }
    }
  }
} catch (error) {
  block(error.code || 'AIH_ASSET_CLOSURE_FAILED', error.message);
}

if (blockers.length > 0) {
  const result = { status: 'BLOCKED', blockers };
  if (json) console.log(JSON.stringify(result, null, 2));
  else for (const item of blockers) console.error('[' + item.code + '] ' + item.message);
  process.exitCode = 1;
}
