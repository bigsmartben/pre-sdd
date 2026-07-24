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

const root = repositoryRootFrom(resolve(import.meta.dirname, '..'));
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

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  return '{' + Object.keys(value)
    .sort()
    .map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key]))
    .join(',') + '}';
}

function confirmationSha256(confirmation) {
  const payload = { ...confirmation };
  delete payload.sha256;
  return sha256(Buffer.from(canonicalJson(payload), 'utf8'));
}

function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
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

async function validatePacket(schemaPath, value, label, code = 'AIH_ASSET_CLASSIFICATION_INCOMPLETE') {
  const schema = await readJson(root, schemaPath);
  const validate = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true }).compile(schema);
  if (validate(value)) return true;
  for (const error of validate.errors || []) {
    block(code, label + ' 结构无效：' + (error.instancePath || '/') + ' ' + error.message, schemaPath);
  }
  return false;
}

function sameStringSet(left, right) {
  return left.length === right.length && [...new Set(left)].every((item) => right.includes(item));
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function validateConfirmedWorkflow(capturePlan) {
  const scope = capturePlan.scopeConfirmation;
  const scan = scope.scanInventory;
  const screenBindings = scope.screenBindings;
  const impact = capturePlan.highImpactConfirmation;
  const boundary = capturePlan.writebackBoundary;
  const formalCapture = capturePlan.formalCapture;
  const includedNodeIds = new Set(scope.includedNodes.map((item) => item.nodeId));
  const includedVisualNodeIds = new Set(scope.includedNodes.filter((item) => item.kind === 'visual').map((item) => item.nodeId));
  const includedComponentNodeIds = new Set(scope.includedNodes.filter((item) => item.kind === 'component').map((item) => item.nodeId));
  const includedKeyValues = scope.includedNodes.map((item) => item.kind + ':' + item.nodeId);
  const includedKeys = new Set(includedKeyValues);
  const excludedKeys = scope.excludedNodes.map((item) => item.kind + ':' + item.nodeId);
  const scopeItems = new Map(
    [...scope.includedNodes, ...scope.excludedNodes].map((item) => [item.kind + ':' + item.nodeId, item]),
  );

  for (const key of duplicateValues(includedKeyValues)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope Confirmation 重复包含同一类节点：' + key, 'scopeConfirmation.includedNodes');
  }
  for (const key of duplicateValues(excludedKeys)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope Confirmation 重复排除同一类节点：' + key, 'scopeConfirmation.excludedNodes');
  }

  if (scope.rootNodeId !== capturePlan.rootNodeId || !includedNodeIds.has(capturePlan.rootNodeId)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope Confirmation 的根节点必须与 Capture Plan 一致并位于包含范围。', 'scopeConfirmation.rootNodeId');
  }
  for (const key of excludedKeys) {
    if (includedKeys.has(key)) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', '同一类节点不能同时被范围确认包含和排除：' + key, 'scopeConfirmation');
    }
  }
  const scannedKeys = scan.nodes.map((item) => item.kind + ':' + item.nodeId);
  for (const key of duplicateValues(scannedKeys)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scan Inventory 重复登记同一类节点：' + key, 'scopeConfirmation.scanInventory.nodes');
  }
  if (!sameStringSet(scannedKeys, [...includedKeyValues, ...excludedKeys])) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope 的 includedNodes 与 excludedNodes 必须精确分区 Scan Inventory。', 'scopeConfirmation.scanInventory.nodes');
  }
  for (const item of scan.nodes) {
    const confirmed = scopeItems.get(item.kind + ':' + item.nodeId);
    if (confirmed && confirmed.name !== item.name) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scan Inventory 节点名称与 Scope Confirmation 不一致：' + item.nodeId, 'scopeConfirmation.scanInventory.nodes');
    }
    if (
      item.parentNodeId
      && !scan.nodes.some((candidate) => candidate.nodeId === item.parentNodeId)
    ) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scan Inventory parentNodeId 未出现在同一盘点：' + item.nodeId + ' → ' + item.parentNodeId, 'scopeConfirmation.scanInventory.nodes');
    }
  }
  if (
    scan.rootNodeId !== scope.rootNodeId
    || !same(scan.sourceVersion, scope.sourceVersion)
    || Date.parse(scan.scannedAt) > Date.parse(scope.confirmedAt)
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scan Inventory 的根节点、来源版本或时间与 Scope Confirmation 不闭合。', 'scopeConfirmation.scanInventory');
  }

  const expectedBindingCombinations = scope.viewportIds.flatMap((viewportId) => (
    scope.scenarioIds.map((scenarioId) => viewportId + '/' + scenarioId)
  ));
  const expectedBindingCombinationSet = new Set(expectedBindingCombinations);
  const bindingGroups = new Map();
  const screenIdsByRoot = new Map();
  for (const binding of screenBindings) {
    const groupKey = binding.screenId + '/' + binding.figmaRootNodeId;
    const combinationKey = binding.viewportId + '/' + binding.scenarioId;
    if (!bindingGroups.has(groupKey)) bindingGroups.set(groupKey, new Set());
    const observedCombinations = bindingGroups.get(groupKey);
    if (observedCombinations.has(combinationKey)) {
      block(
        'AIH_SOURCE_CAPTURE_BLOCKED',
        '同一 Screen 与 Figma Root 的 Viewport × Scenario 组合重复：' + groupKey + ' / ' + combinationKey,
        'scopeConfirmation.screenBindings',
      );
    }
    observedCombinations.add(combinationKey);
    if (!includedNodeIds.has(binding.figmaRootNodeId)) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', 'Screen Binding 的 Figma 根节点不在确认包含范围：' + binding.figmaRootNodeId, 'scopeConfirmation.screenBindings');
    }
    if (!expectedBindingCombinationSet.has(combinationKey)) {
      block(
        'AIH_SOURCE_CAPTURE_BLOCKED',
        'Screen Binding 的 Viewport × Scenario 组合越出确认范围：' + groupKey + ' / ' + combinationKey,
        'scopeConfirmation.screenBindings',
      );
    }
    for (const stateId of binding.stateIds) {
      if (!scope.stateIds.includes(stateId)) {
        block('AIH_SOURCE_CAPTURE_BLOCKED', 'Screen Binding 引用未确认的 State：' + binding.screenId + ' / ' + stateId, 'scopeConfirmation.screenBindings');
      }
    }
    if (!screenIdsByRoot.has(binding.figmaRootNodeId)) screenIdsByRoot.set(binding.figmaRootNodeId, new Set());
    screenIdsByRoot.get(binding.figmaRootNodeId).add(binding.screenId);
  }
  for (const [groupKey, observedCombinations] of bindingGroups) {
    const missingCombinations = expectedBindingCombinations.filter((item) => !observedCombinations.has(item));
    if (missingCombinations.length > 0) {
      block(
        'AIH_SOURCE_CAPTURE_BLOCKED',
        '每个 Screen 与 Figma Root 必须完整覆盖 Scope 的 Viewport × Scenario 组合：'
          + groupKey + '，缺少 ' + missingCombinations.join(', '),
        'scopeConfirmation.screenBindings',
      );
    }
  }
  for (const [rootNodeId, screenIds] of screenIdsByRoot) {
    if (screenIds.size !== 1) {
      block('AIH_SOURCE_COVERAGE_FAILED', '同一 Figma Screen Root 的多行 Scenario/Viewport Binding 必须归属唯一 Product Screen：' + rootNodeId, 'scopeConfirmation.screenBindings');
    }
  }
  if (
    !sameStringSet(scope.viewportIds, [...new Set(screenBindings.map((item) => item.viewportId))])
    || !sameStringSet(scope.scenarioIds, [...new Set(screenBindings.map((item) => item.scenarioId))])
    || !sameStringSet(scope.stateIds, [...new Set(screenBindings.flatMap((item) => item.stateIds))])
  ) {
    block('AIH_SOURCE_COVERAGE_FAILED', 'Screen Bindings 必须完整覆盖 Scope 的 Viewport、Scenario 与 State。', 'scopeConfirmation.screenBindings');
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
  const candidateNodeIds = capturePlan.candidateVisualNodes.map((item) => item.nodeId);
  for (const nodeId of duplicateValues(candidateNodeIds)) {
    block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', '视觉候选节点存在多个 strategy：' + nodeId, 'candidateVisualNodes');
  }
  for (const candidate of capturePlan.candidateVisualNodes) {
    if (!includedVisualNodeIds.has(candidate.nodeId)) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', 'Capture Plan 自行扩大到未确认的视觉节点：' + candidate.nodeId, 'candidateVisualNodes');
    }
  }
  for (const nodeId of includedVisualNodeIds) {
    if (!candidateNodeIds.includes(nodeId)) {
      block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', '确认范围内的视觉节点缺少唯一 strategy：' + nodeId, 'candidateVisualNodes');
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
  if (scope.sha256 !== confirmationSha256(scope)) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Scope Confirmation 的规范化 SHA-256 与确认内容不一致。', 'scopeConfirmation.sha256');
  }
  if (impact.scopeConfirmationSha256 !== scope.sha256) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'High-impact Confirmation 未绑定当前 Scope Confirmation 内容哈希。', 'highImpactConfirmation.scopeConfirmationSha256');
  }
  if (impact.sha256 !== confirmationSha256(impact)) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'High-impact Confirmation 的规范化 SHA-256 与确认内容不一致。', 'highImpactConfirmation.sha256');
  }
  if (boundary.highImpactConfirmationSha256 !== impact.sha256) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '写回边界未绑定当前 High-impact Confirmation 内容哈希。', 'writebackBoundary.highImpactConfirmationSha256');
  }
  if (!same(scope.sourceVersion, impact.sourceVersion)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '两次人工确认之间 Figma 来源版本发生变化，必须重新扫描范围。', 'highImpactConfirmation.sourceVersion');
  }
  if (
    !same(boundary.sourceVersionBefore, impact.sourceVersion)
    || !same(boundary.sourceVersionAfter, capturePlan.sourceVersion)
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Writeback Boundary 的 before/after 来源版本未绑定 High-impact 与最终版本。', 'writebackBoundary');
  }
  if (
    impact.writebackOperations.length === 0
    && !same(boundary.sourceVersionBefore, boundary.sourceVersionAfter)
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '没有获批写回时，Writeback Boundary 的 before/after 来源版本必须相等。', 'writebackBoundary');
  }
  if (
    formalCapture.ordinal !== boundary.formalCaptureOrdinal
    || !same(formalCapture.sourceVersionBefore, capturePlan.sourceVersion)
    || !same(formalCapture.sourceVersionAfter, capturePlan.sourceVersion)
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Formal Capture ordinal 与 before/after 来源版本必须绑定唯一最终版本。', 'formalCapture');
  }

  const proposalIds = impact.componentProposals.map((item) => item.id);
  for (const proposalId of duplicateValues(proposalIds)) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件抽象 Proposal ID 重复：' + proposalId, 'highImpactConfirmation.componentProposals');
  }
  const proposalById = new Map(impact.componentProposals.map((item) => [item.id, item]));
  const proposalNodeOwners = new Map();
  for (const proposal of impact.componentProposals) {
    for (const nodeId of proposal.nodeIds) {
      if (!includedComponentNodeIds.has(nodeId)) {
        block('AIH_SOURCE_CAPTURE_BLOCKED', '组件抽象提案越出已确认范围：' + proposal.id + ' / ' + nodeId, 'highImpactConfirmation.componentProposals');
      }
      if (proposalNodeOwners.has(nodeId)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Figma 组件节点被多个抽象提案拥有：' + nodeId, 'highImpactConfirmation.componentProposals');
      }
      proposalNodeOwners.set(nodeId, proposal.id);
    }
    if (
      !proposal.nodeIds.includes(proposal.componentBoundary.rootNodeId)
      || proposal.componentBoundary.nestedComponentNodeIds.some((nodeId) => !proposal.nodeIds.includes(nodeId))
      || proposal.componentBoundary.nestedComponentNodeIds.includes(proposal.componentBoundary.rootNodeId)
    ) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Component Boundary 必须完全位于当前提案分组：' + proposal.id, 'highImpactConfirmation.componentProposals');
    }
    if (
      (proposal.componentBoundary.kind === 'single-component' && proposal.componentBoundary.nestedComponentNodeIds.length !== 0)
      || (proposal.componentBoundary.kind === 'nested-components' && proposal.componentBoundary.nestedComponentNodeIds.length === 0)
    ) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Component Boundary 的 kind 与嵌套节点不一致：' + proposal.id, 'highImpactConfirmation.componentProposals');
    }
    for (const dimension of ['width', 'height']) {
      const size = proposal.sizeBehavior[dimension];
      if (size.min !== null && size.max !== null && size.min > size.max) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Size Behavior 的 min 不得大于 max：' + proposal.id + ' / ' + dimension, 'highImpactConfirmation.componentProposals');
      }
    }
    const propertyKeys = proposal.interfaceProposal.properties.map((item) => item.kind + '/' + item.figmaProperty);
    const slotKeys = proposal.interfaceProposal.slots.map((item) => item.figmaProperty + '/' + item.litSlot);
    const eventKeys = proposal.interfaceProposal.events.map((item) => item.name + '/' + item.litEvent);
    if (
      duplicateValues(propertyKeys).length > 0
      || duplicateValues(slotKeys).length > 0
      || duplicateValues(eventKeys).length > 0
    ) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Interface Proposal 的 Property、Slot 或 Event 存在重复定义：' + proposal.id, 'highImpactConfirmation.componentProposals');
    }
  }
  if (!sameStringSet([...proposalNodeOwners.keys()], [...includedComponentNodeIds])) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件提案分组必须互斥且并集精确覆盖确认范围内的 Component 节点。', 'highImpactConfirmation.componentProposals');
  }

  const axisKeys = [];
  for (const axis of impact.stateAxes) {
    if (!proposalById.has(axis.proposalId)) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '有限状态轴引用未知组件提案：' + axis.id, 'highImpactConfirmation.stateAxes');
    }
    axisKeys.push(axis.proposalId + '/' + axis.kind + '/' + axis.name);
  }
  for (const key of duplicateValues(axisKeys)) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '同一组件的有限状态轴重复：' + key, 'highImpactConfirmation.stateAxes');
  }
  for (const proposal of impact.componentProposals) {
    const variantAxes = impact.stateAxes.filter((axis) => axis.proposalId === proposal.id && axis.kind === 'variant');
    const variantProperties = proposal.interfaceProposal.properties.filter((item) => item.kind === 'variant');
    if (!sameStringSet(
      variantAxes.map((item) => item.name),
      variantProperties.map((item) => item.figmaProperty),
    )) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Interface Proposal 的 Variant Property 必须与已确认 Variant Axis 完全一致：' + proposal.id, 'highImpactConfirmation.componentProposals');
      continue;
    }
    for (const axis of variantAxes) {
      const property = variantProperties.find((item) => item.figmaProperty === axis.name);
      if (!sameStringSet(axis.values, property?.values.map((item) => item.figmaValue) || [])) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Interface Proposal 的 Variant Property 值与已确认轴值不一致：' + proposal.id + ' / ' + axis.name, 'highImpactConfirmation.componentProposals');
      }
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
  const captureStartedAt = Date.parse(formalCapture.startedAt);
  const captureCompletedAt = Date.parse(formalCapture.completedAt);
  if (!(
    Date.parse(scan.scannedAt) <= scopeAt
    && scopeAt <= impactAt
    && impactAt <= writebackAt
    && writebackAt < frozenAt
    && frozenAt <= captureStartedAt
    && captureStartedAt <= captureCompletedAt
  )) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '必须先确认范围，再确认高影响决策，合并完成全部写回，最后执行唯一一次正式采集。', 'frozenAt');
  }
}

function validateDesignContextClosure(capturePlan, capturePlanHash, context) {
  if (
    context.sourceId !== capturePlan.sourceId
    || context.nodeId !== capturePlan.rootNodeId
    || !same(context.sourceVersion, capturePlan.sourceVersion)
  ) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Design Context 的来源身份、根节点或版本与 Capture Plan 不一致。', 'designContext');
  }
  if (
    context.rawCapture.requestedNodeId !== context.nodeId
    || context.rawCapture.capturedAt !== context.capturedAt
    || !same(context.rawCapture.sourceVersion, context.sourceVersion)
    || context.rawCapture.capturePlanSha256 !== capturePlanHash
  ) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Raw Capture provenance 与正式 Design Context 或 Capture Plan 不一致。', 'designContext.rawCapture');
  }
  if (
    Date.parse(context.capturedAt) < Date.parse(capturePlan.formalCapture.startedAt)
    || Date.parse(context.capturedAt) > Date.parse(capturePlan.formalCapture.completedAt)
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '正式 Design Context 必须在 Formal Capture 时间边界内采集。', 'designContext.capturedAt');
  }

  const components = new Map();
  for (const component of context.components) {
    if (components.has(component.nodeId)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Design Context 组件节点重复：' + component.nodeId, 'designContext.components');
    }
    components.set(component.nodeId, component);
  }
  const screenBindingsByRoot = new Map();
  for (const binding of capturePlan.scopeConfirmation.screenBindings) {
    if (!screenBindingsByRoot.has(binding.figmaRootNodeId)) {
      screenBindingsByRoot.set(binding.figmaRootNodeId, new Set());
    }
    screenBindingsByRoot.get(binding.figmaRootNodeId).add(binding.screenId);
  }
  for (const component of context.components.filter((item) => item.kind === 'instance')) {
    const screenIds = screenBindingsByRoot.get(component.screenRootNodeId);
    if (!screenIds || screenIds.size !== 1) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Instance 的 screenRootNodeId 必须映射到唯一 Product Screen：' + component.nodeId, 'designContext.components');
    }
  }
  for (const scopeNode of capturePlan.scopeConfirmation.includedNodes.filter((item) => item.kind === 'component')) {
    if (!components.has(scopeNode.nodeId)) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '确认范围内的组件节点未出现在正式 Design Context：' + scopeNode.nodeId, 'designContext.components');
    }
  }

  const catalogs = new Map();
  for (const catalog of context.componentSetCatalog) {
    if (catalogs.has(catalog.componentSetNodeId)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set Catalog 重复：' + catalog.componentSetNodeId, 'designContext.componentSetCatalog');
    }
    catalogs.set(catalog.componentSetNodeId, catalog);
  }

  for (const component of context.components) {
    if (component.kind === 'component-set') {
      if (
        component.componentSetNodeId !== component.nodeId
        || component.mainComponentNodeId !== null
        || Object.keys(component.variantProperties).length !== 0
      ) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set 身份字段不闭合：' + component.nodeId, 'designContext.components');
      }
      if (!catalogs.has(component.nodeId)) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set 缺少完整轴值 Catalog：' + component.nodeId, 'designContext.componentSetCatalog');
      }
    }
    if (component.kind === 'component' && component.mainComponentNodeId !== component.nodeId) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Main Component 必须以自身 nodeId 作为 mainComponentNodeId：' + component.nodeId, 'designContext.components');
    }
    if (component.componentSetNodeId && components.get(component.componentSetNodeId)?.kind !== 'component-set') {
      block('AIH_COMPONENT_MAPPING_INVALID', '组件引用未知 Component Set：' + component.nodeId + ' → ' + component.componentSetNodeId, 'designContext.components');
    }
    if (component.kind === 'instance') {
      const main = components.get(component.mainComponentNodeId);
      if (
        main?.kind !== 'component'
        || main.componentSetNodeId !== component.componentSetNodeId
        || !same(main.variantProperties, component.variantProperties)
      ) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Instance 的 Main Component、Component Set 或 Variant 属性不闭合：' + component.nodeId, 'designContext.components');
      }
    }
    if (
      ['component', 'instance'].includes(component.kind)
      && component.componentSetNodeId === null
      && Object.keys(component.variantProperties).length !== 0
    ) {
      block('AIH_COMPONENT_MAPPING_INVALID', '独立 Component 或 Instance 不得声明 Component Set Variant 属性：' + component.nodeId, 'designContext.components');
    }
  }

  for (const [setNodeId, catalog] of catalogs) {
    const set = components.get(setNodeId);
    if (set?.kind !== 'component-set') {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set Catalog 引用未知 Set：' + setNodeId, 'designContext.componentSetCatalog');
      continue;
    }
    const axisNames = catalog.axes.map((axis) => axis.name);
    for (const name of duplicateValues(axisNames)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set Catalog 轴名称重复：' + setNodeId + ' / ' + name, 'designContext.componentSetCatalog');
    }
    const actualDefinitions = context.components
      .filter((item) => item.kind === 'component' && item.componentSetNodeId === setNodeId)
      .map((item) => item.nodeId);
    if (!sameStringSet(catalog.definitionNodeIds, actualDefinitions)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set Catalog 必须完整列出全部 Variant Definition：' + setNodeId, 'designContext.componentSetCatalog');
    }
    const combinations = [];
    const observedValues = new Map(catalog.axes.map((axis) => [axis.name, new Set()]));
    for (const definitionNodeId of catalog.definitionNodeIds) {
      const definition = components.get(definitionNodeId);
      if (definition?.kind !== 'component' || definition.componentSetNodeId !== setNodeId) continue;
      const propertyNames = Object.keys(definition.variantProperties);
      if (!sameStringSet(propertyNames, axisNames)) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Variant Definition 的属性轴与 Catalog 不一致：' + definitionNodeId, 'designContext.components');
        continue;
      }
      for (const axis of catalog.axes) {
        const value = definition.variantProperties[axis.name];
        if (!axis.values.includes(value)) {
          block('AIH_COMPONENT_MAPPING_INVALID', 'Variant Definition 使用 Catalog 外的轴值：' + definitionNodeId + ' / ' + axis.name + '=' + value, 'designContext.components');
        } else {
          observedValues.get(axis.name).add(value);
        }
      }
      combinations.push(canonicalJson(definition.variantProperties));
    }
    for (const combination of duplicateValues(combinations)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set 存在重复 Variant Definition 组合：' + setNodeId + ' / ' + combination, 'designContext.components');
    }
    for (const axis of catalog.axes) {
      if (!sameStringSet(axis.values, [...observedValues.get(axis.name)])) {
        block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set Catalog 的轴值必须与全部 Definition 的实际值集合一致：' + setNodeId + ' / ' + axis.name, 'designContext.componentSetCatalog');
      }
    }
  }

  const contextAssets = new Map();
  for (const asset of context.assets) {
    if (contextAssets.has(asset.nodeId)) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Design Context 静态 Asset 节点重复：' + asset.nodeId, 'designContext.assets');
    }
    contextAssets.set(asset.nodeId, asset);
  }
  const plannedAssets = capturePlan.candidateVisualNodes.filter((item) => item.strategy === 'asset');
  if (!sameStringSet(plannedAssets.map((item) => item.nodeId), [...contextAssets.keys()])) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Design Context 静态 Asset 集合必须与 Capture Plan 的 asset 分类完全一致。', 'designContext.assets');
  }
  for (const planned of plannedAssets) {
    const asset = contextAssets.get(planned.nodeId);
    if (
      !asset
      || asset.assetKind !== planned.assetKind
      || asset.captureScope !== planned.captureScope
      || asset.containsDynamicContent !== planned.containsDynamicContent
      || asset.recommendedFormat !== planned.assetExport.format
    ) {
      block('AIH_ASSET_CLOSURE_FAILED', 'Design Context Asset 事实与 Capture Plan 不一致：' + planned.nodeId, 'designContext.assets');
    }
  }
}

function validateComponentHandshake(capturePlan, context, registration) {
  const proposals = new Map(capturePlan.highImpactConfirmation.componentProposals.map((item) => [item.id, item]));
  const handshakes = new Map();
  const finalOwners = new Map();
  const components = new Map(context.components.map((item) => [item.nodeId, item]));
  const catalogs = new Map(context.componentSetCatalog.map((item) => [item.componentSetNodeId, item]));
  const screenBindingsByRoot = new Map();
  for (const binding of capturePlan.scopeConfirmation.screenBindings) {
    if (!screenBindingsByRoot.has(binding.figmaRootNodeId)) {
      screenBindingsByRoot.set(binding.figmaRootNodeId, new Map());
    }
    screenBindingsByRoot.get(binding.figmaRootNodeId).set(binding.screenId, binding);
  }

  for (const handshake of registration.componentHandshake) {
    if (handshakes.has(handshake.proposalId)) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Packet 重复登记组件提案：' + handshake.proposalId, 'componentHandshake');
    }
    handshakes.set(handshake.proposalId, handshake);
    const proposal = proposals.get(handshake.proposalId);
    if (
      !proposal
      || proposal.decision !== handshake.decision
      || proposal.semanticRole !== handshake.semanticRole
      || proposal.reason !== handshake.reason
      || proposal.counterexample !== handshake.counterexample
      || !same(proposal.interfaceProposal, handshake.interfaceProposal)
    ) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Packet 组件握手与获批提案或 Interface Proposal 不一致：' + handshake.proposalId, 'componentHandshake');
    }
    const signatures = new Set();
    for (const nodeId of handshake.finalNodeIds) {
      const component = components.get(nodeId);
      if (!component) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件握手引用未知正式节点：' + nodeId, 'componentHandshake');
      } else {
        signatures.add(component.structureSignature);
      }
      if (finalOwners.has(nodeId)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '正式组件节点被多个抽象提案拥有：' + nodeId, 'componentHandshake');
      }
      finalOwners.set(nodeId, handshake.proposalId);
    }
    if (!sameStringSet(handshake.structureSignatures, [...signatures])) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件握手结构签名与正式节点不一致：' + handshake.proposalId, 'componentHandshake');
    }
    if (handshake.decision !== 'shared-component') {
      if (handshake.usageBindings.length !== 0) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '非共享组件提案不得登记 Instance Usage Binding：' + handshake.proposalId, 'componentHandshake');
      }
      continue;
    }

    const rootComponent = components.get(handshake.figmaComponentNodeId);
    if (!['component', 'component-set'].includes(rootComponent?.kind) || !handshake.finalNodeIds.includes(handshake.figmaComponentNodeId)) {
      block('AIH_COMPONENT_MAPPING_INVALID', '共享组件握手必须引用本抽象中的 Component 或 Component Set：' + handshake.proposalId, 'componentHandshake');
      continue;
    }
    const expectedDefinitions = rootComponent.kind === 'component-set'
      ? catalogs.get(rootComponent.nodeId)?.definitionNodeIds || []
      : [rootComponent.nodeId];
    if (!sameStringSet(handshake.variantDefinitionNodeIds, expectedDefinitions)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '共享组件握手未完整覆盖 Variant Definition：' + handshake.proposalId, 'componentHandshake');
    }
    const expectedInstances = context.components
      .filter((item) => item.kind === 'instance' && expectedDefinitions.includes(item.mainComponentNodeId))
      .map((item) => item.nodeId);
    if (!sameStringSet(handshake.variantUsageInstanceNodeIds, expectedInstances)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '共享组件握手未完整覆盖使用中的 Instance：' + handshake.proposalId, 'componentHandshake');
    }
    for (const nodeId of [...handshake.variantDefinitionNodeIds, ...handshake.variantUsageInstanceNodeIds]) {
      if (!handshake.finalNodeIds.includes(nodeId)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 或 Instance Usage 不属于当前组件抽象：' + nodeId, 'componentHandshake');
      }
    }
    const usageKeys = handshake.usageBindings.map((item) => item.instanceNodeId + '/' + item.screenId);
    for (const key of duplicateValues(usageKeys)) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Instance Usage Binding 重复：' + key, 'componentHandshake');
    }
    if (!sameStringSet(
      handshake.usageBindings.map((item) => item.instanceNodeId),
      handshake.variantUsageInstanceNodeIds,
    )) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Usage Binding 的 Instance 集合必须精确覆盖 Variant Usage Instance：' + handshake.proposalId, 'componentHandshake');
    }
    for (const usage of handshake.usageBindings) {
      const instance = components.get(usage.instanceNodeId);
      const screenBindings = screenBindingsByRoot.get(instance?.screenRootNodeId);
      if (instance?.kind !== 'instance' || !screenBindings?.has(usage.screenId)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Usage Binding 必须沿 Instance screenRootNodeId 解析到同一 Product Screen：' + usage.instanceNodeId + ' / ' + usage.screenId, 'componentHandshake');
      }
    }

    const confirmedVariantAxes = capturePlan.highImpactConfirmation.stateAxes
      .filter((axis) => axis.proposalId === handshake.proposalId && axis.kind === 'variant');
    const finalAxes = rootComponent.kind === 'component-set' ? catalogs.get(rootComponent.nodeId)?.axes || [] : [];
    const confirmedAxes = new Map(confirmedVariantAxes.map((axis) => [axis.name, axis.values]));
    const finalAxisMap = new Map(finalAxes.map((axis) => [axis.name, axis.values]));
    if (!sameStringSet([...confirmedAxes.keys()], [...finalAxisMap.keys()])) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '正式 Component Set 的 Variant 轴与 High-impact Confirmation 不一致：' + handshake.proposalId, 'componentHandshake');
    } else {
      for (const [name, values] of confirmedAxes) {
        if (!sameStringSet(values, finalAxisMap.get(name) || [])) {
          block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', '正式 Component Set 的 Variant 值与 High-impact Confirmation 不一致：' + handshake.proposalId + ' / ' + name, 'componentHandshake');
        }
      }
    }
  }

  if (!sameStringSet([...handshakes.keys()], [...proposals.keys()])) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Packet 必须为每个获批组件提案提供且只提供一个握手项。', 'componentHandshake');
  }
  if (!sameStringSet([...finalOwners.keys()], [...components.keys()])) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Registration Packet 的组件握手必须唯一分区正式 Design Context 的全部组件相关节点。', 'componentHandshake');
  }
}

async function validateRegistrationMode(actor, registrationPath) {
  if (!within(tmpdir(), registrationPath)) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 必须位于操作系统临时目录。', registrationPath);
    return null;
  }
  let registrationContent;
  let registration;
  try {
    registrationContent = await readFile(registrationPath);
    registration = JSON.parse(registrationContent.toString('utf8'));
  } catch (error) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 不可读：' + error.message, registrationPath);
    return null;
  }
  if (!await validatePacket(
    '.agents/skills/figma-workflow/source-registration.schema.json',
    registration,
    'Registration Packet',
    'AIH_SOURCE_INTEGRITY_FAILED',
  )) return null;

  const { project, manifest } = await loadProjectAndManifest(root);
  if (project.stages?.['product-design']?.status !== 'active') {
    block('AIH_STAGE_UNINITIALIZED', 'Registration Packet 校验只允许在 active Product Design 阶段执行。', 'product-design');
    return null;
  }
  const paths = artifactPaths(project, 'canonical-ui-prototype', 'product-design');
  const areaDirectory = repositoryFile(root, paths.authorityRoot + '/' + actor);
  try { await access(areaDirectory); }
  catch {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Canonical UI 参与者 Area 不存在：' + actor, paths.authorityRoot);
    return null;
  }
  const artifact = manifest.artifactRegistry.find((item) => item.id === 'canonical-ui-prototype');
  if (!artifact || artifact.authorityKind !== 'area-set') {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Canonical UI Artifact 未绑定 area-set。', 'canonical-ui-prototype');
    return null;
  }

  const references = {
    evidence: { path: registration.evidencePath, sha256: registration.evidenceSha256 },
    capturePlan: registration.capturePlan,
    designContext: registration.designContext,
    ingestReceipt: registration.ingestReceipt,
  };
  const loaded = {};
  for (const [role, reference] of Object.entries(references)) {
    const path = areaFile(areaDirectory, reference.path);
    try {
      const content = await readFile(path);
      if (sha256(content) !== reference.sha256) {
        block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 引用文件哈希不匹配：' + role, reference.path);
        continue;
      }
      loaded[role] = { path, content, value: JSON.parse(content.toString('utf8')) };
    } catch (error) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration Packet 引用文件不可读：' + role + ' / ' + error.message, reference.path);
    }
  }
  if (!loaded.capturePlan || !loaded.designContext || !loaded.ingestReceipt || !loaded.evidence) return null;

  const [planValid, contextValid, receiptValid] = await Promise.all([
    validatePacket('.agents/skills/figma-workflow/capture-plan.schema.json', loaded.capturePlan.value, 'Capture Plan', 'AIH_SOURCE_CAPTURE_BLOCKED'),
    validatePacket('.agents/skills/figma-workflow/figma-design-context.schema.json', loaded.designContext.value, 'Design Context', 'AIH_VISUAL_SOURCE_INCOMPLETE'),
    validatePacket('.agents/skills/figma-workflow/ingest-receipt.schema.json', loaded.ingestReceipt.value, 'Ingest Receipt', 'AIH_ASSET_CLOSURE_FAILED'),
  ]);
  if (!planValid || !contextValid || !receiptValid) return null;

  const capturePlan = loaded.capturePlan.value;
  const context = loaded.designContext.value;
  const receipt = loaded.ingestReceipt.value;
  const evidence = loaded.evidence.value;
  validateConfirmedWorkflow(capturePlan);
  validateDesignContextClosure(capturePlan, registration.capturePlan.sha256, context);
  validateComponentHandshake(capturePlan, context, registration);
  const formalStartedAt = Date.parse(capturePlan.formalCapture.startedAt);
  const formalCompletedAt = Date.parse(capturePlan.formalCapture.completedAt);
  for (const [label, value] of [
    ['Design Context', context.capturedAt],
    ['Ingest Receipt', receipt.ingestedAt],
    ['Evidence', evidence.capturedAt],
  ]) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp) || timestamp < formalStartedAt || timestamp > formalCompletedAt) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', label + ' 的时间必须位于 Formal Capture 边界内。', value);
    }
  }

  if (
    registration.sourceId !== capturePlan.sourceId
    || registration.sourceId !== context.sourceId
    || registration.sourceId !== receipt.sourceId
    || registration.sourceId !== evidence.sourceId
    || evidence.nodeId !== capturePlan.rootNodeId
    || !same(registration.sourceVersion, capturePlan.sourceVersion)
    || !same(registration.sourceVersion, context.sourceVersion)
    || !same(registration.sourceVersion, receipt.sourceVersion)
    || !same(registration.sourceVersion, evidence.sourceVersion)
  ) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration、Capture、Context、Receipt 与 Evidence 的来源身份、根节点或版本不一致。', registrationPath);
  }
  if (
    receipt.capturePlan.path !== registration.capturePlan.path
    || receipt.capturePlan.sha256 !== registration.capturePlan.sha256
  ) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Ingest Receipt 未绑定 Registration Packet 引用的 Capture Plan。', registration.ingestReceipt.path);
  }
  const plannedAssets = new Map(
    capturePlan.candidateVisualNodes
      .filter((item) => item.strategy === 'asset')
      .map((item) => [item.nodeId, item]),
  );
  const receiptAssetsForPlan = new Map(receipt.assets.map((item) => [item.sourceNodeId, item]));
  if (
    receiptAssetsForPlan.size !== receipt.assets.length
    || !sameStringSet([...plannedAssets.keys()], [...receiptAssetsForPlan.keys()])
  ) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Ingest Receipt 的 Asset 集合必须与 Capture Plan 完全一致。', registration.ingestReceipt.path);
  }
  for (const [nodeId, planned] of plannedAssets) {
    const received = receiptAssetsForPlan.get(nodeId);
    if (
      !received
      || received.path !== planned.assetExport.targetPath
      || received.assetKind !== planned.assetKind
      || received.captureScope !== planned.captureScope
      || received.containsDynamicContent !== planned.containsDynamicContent
      || received.format !== planned.assetExport.format
      || received.scale !== planned.assetExport.scale
      || !same(received.cropBounds, planned.assetExport.cropBounds)
      || !same(received.transparentPadding, planned.assetExport.transparentPadding)
      || !same(received.expectedDimensions, planned.assetExport.expectedDimensions)
      || receipt.downloadOperation !== planned.assetExport.downloadOperation
      || !same(received.consumerTargets, planned.consumerTargets)
      || received.status !== 'verified'
    ) {
      block('AIH_ASSET_CLOSURE_FAILED', 'Capture Plan 与 Ingest Receipt 的 Asset 事实不一致：' + nodeId, registration.ingestReceipt.path);
    }
  }

  const evidenceItems = Array.isArray(evidence.items) ? evidence.items : [];
  const itemIds = evidenceItems.map((item) => item.id);
  const itemPaths = evidenceItems.map((item) => item.path);
  for (const id of duplicateValues(itemIds)) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Evidence Item ID 重复：' + id, registration.evidencePath);
  }
  for (const path of duplicateValues(itemPaths)) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Evidence Item 路径重复：' + path, registration.evidencePath);
  }
  const requiredRoles = ['raw-design-context', 'design-context', 'capture-plan', 'ingest-receipt'];
  for (const role of requiredRoles) {
    const matches = evidenceItems.filter((item) => item.role === role);
    if (matches.length !== 1) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma Evidence 必须且只能包含一个 ' + role + ' 项。', registration.evidencePath);
    }
  }
  if (evidenceItems.filter((item) => item.role === 'screenshot').length < 1) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Figma Evidence 至少需要一个来源截图。', registration.evidencePath);
  }
  const evidenceById = new Map(evidenceItems.map((item) => [item.id, item]));
  for (const handshake of registration.componentHandshake) {
    for (const evidenceItemId of handshake.baselineEvidenceItemIds) {
      const item = evidenceById.get(evidenceItemId);
      if (!item || !['screenshot', 'design-context'].includes(item.role)) {
        block('AIH_SOURCE_INTEGRITY_FAILED', '组件 Baseline Evidence 必须解析到 screenshot 或 design-context：' + handshake.proposalId + ' / ' + evidenceItemId, registration.evidencePath);
      }
    }
  }
  const expectedEvidenceRefs = {
    'design-context': registration.designContext,
    'capture-plan': registration.capturePlan,
    'ingest-receipt': registration.ingestReceipt,
    'raw-design-context': { path: context.rawCapture.path, sha256: context.rawCapture.sha256 },
  };
  for (const [role, reference] of Object.entries(expectedEvidenceRefs)) {
    const item = evidenceItems.find((entry) => entry.role === role);
    if (!item || item.path !== reference.path || item.sha256 !== reference.sha256) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Evidence 中的 ' + role + ' 未绑定同一正式文件。', registration.evidencePath);
    }
  }
  for (const item of evidenceItems) {
    try {
      const content = await readFile(areaFile(areaDirectory, item.path));
      if (sha256(content) !== item.sha256) {
        block(item.role === 'asset' ? 'AIH_ASSET_HASH_MISMATCH' : 'AIH_SOURCE_INTEGRITY_FAILED', 'Evidence Item 文件哈希不匹配：' + item.id, item.path);
      }
    } catch (error) {
      block(item.role === 'asset' ? 'AIH_ASSET_MISSING' : 'AIH_SOURCE_INTEGRITY_FAILED', 'Evidence Item 文件不可读：' + item.id + ' / ' + error.message, item.path);
    }
  }

  const receiptAssets = new Map(receipt.assets.map((item) => [item.sourceNodeId, item]));
  const registrationAssets = new Map(registration.assets.map((item) => [item.sourceNodeId, item]));
  if (receiptAssets.size !== receipt.assets.length || registrationAssets.size !== registration.assets.length) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Receipt 或 Registration 重复登记同一来源 Asset 节点。', registrationPath);
  }
  if (!sameStringSet([...receiptAssets.keys()], [...registrationAssets.keys()])) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Registration Packet 的 Asset 集合必须与 Ingest Receipt 完全一致。', registrationPath);
  }
  for (const [nodeId, asset] of registrationAssets) {
    const received = receiptAssets.get(nodeId);
    const evidenceAsset = evidenceItems.find((item) => item.role === 'asset' && item.sourceNodeId === nodeId);
    if (
      !received
      || !evidenceAsset
      || asset.path !== received.path
      || asset.path !== evidenceAsset.path
      || asset.assetKind !== received.assetKind
      || asset.assetKind !== evidenceAsset.assetKind
      || asset.captureScope !== received.captureScope
      || asset.captureScope !== evidenceAsset.captureScope
      || asset.containsDynamicContent !== received.containsDynamicContent
      || asset.containsDynamicContent !== evidenceAsset.containsDynamicContent
      || asset.format !== received.format
      || asset.format !== evidenceAsset.format
      || asset.scale !== received.scale
      || asset.scale !== evidenceAsset.scale
      || !same(asset.cropBounds, received.cropBounds)
      || !same(asset.cropBounds, evidenceAsset.cropBounds)
      || !same(asset.transparentPadding, received.transparentPadding)
      || !same(asset.transparentPadding, evidenceAsset.transparentPadding)
      || !same(asset.expectedDimensions, received.expectedDimensions)
      || !same(asset.expectedDimensions, evidenceAsset.expectedDimensions)
      || asset.sha256 !== received.sha256
      || asset.sha256 !== evidenceAsset.sha256
      || asset.downloadOperation !== receipt.downloadOperation
      || asset.downloadOperation !== evidenceAsset.downloadOperation
      || !same(asset.consumerTargets, received.consumerTargets)
      || !same(asset.consumerTargets, evidenceAsset.consumerTargets)
    ) {
      block('AIH_ASSET_CLOSURE_FAILED', 'Registration、Receipt 与 Evidence 的 Asset 事实不一致：' + nodeId, registrationPath);
    }
  }

  try {
    const rawContent = await readFile(areaFile(areaDirectory, context.rawCapture.path));
    if (sha256(rawContent) !== context.rawCapture.sha256) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Raw Capture 文件哈希与 Design Context provenance 不一致。', context.rawCapture.path);
    }
  } catch (error) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Raw Capture 文件不可读：' + error.message, context.rawCapture.path);
  }
  return { registration, capturePlan, context, receipt, evidence };
}

const actor = argument('--actor');
const capturePlanArgument = argument('--capture-plan');
const acquisitionArgument = argument('--acquisition');
const registrationArgument = argument('--registration');

try {
  if (!actor || !/^ACTOR-[0-9]{3}$/.test(actor)) {
    block('AIH_ASSET_CLOSURE_FAILED', '必须使用 --actor ACTOR-NNN 指定 Canonical UI 参与者。', '--actor');
  }
  if (registrationArgument) {
    if (capturePlanArgument || acquisitionArgument) {
      block('AIH_SOURCE_INTEGRITY_FAILED', '--registration 校验模式不得同时执行 Asset Ingest。');
    }
    if (blockers.length === 0) {
      const validated = await validateRegistrationMode(actor, resolve(registrationArgument));
      if (validated && blockers.length === 0) {
        const result = {
          status: 'PASS',
          sourceId: validated.registration.sourceId,
          actor,
          registration: resolve(registrationArgument),
          componentHandshakes: validated.registration.componentHandshake.length,
          assets: validated.registration.assets.length,
        };
        if (json) console.log(JSON.stringify(result, null, 2));
        else console.log('[PASS] Figma Registration Packet、Raw Capture、组件定义与使用覆盖闭合。');
      }
    }
  } else {
    if (!capturePlanArgument || !acquisitionArgument) {
      block('AIH_ASSET_MISSING', '必须同时提供 --capture-plan 与 --acquisition，或单独提供 --registration。');
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
      validatePacket(
        '.agents/skills/figma-workflow/capture-plan.schema.json',
        capturePlan,
        'Capture Plan',
        'AIH_SOURCE_CAPTURE_BLOCKED',
      ),
      validatePacket('.agents/skills/figma-workflow/acquisition-packet.schema.json', acquisition, 'Acquisition Packet'),
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
      if (
        Date.parse(acquisition.downloadedAt) < Date.parse(capturePlan.formalCapture.startedAt)
        || Date.parse(acquisition.downloadedAt) > Date.parse(capturePlan.formalCapture.completedAt)
      ) {
        block('AIH_SOURCE_CAPTURE_BLOCKED', 'Asset 下载时间必须位于 Formal Capture 边界内。', 'downloadedAt');
      }
      for (const candidate of capturePlan.candidateVisualNodes.filter((item) => item.strategy === 'asset')) {
        if (acquisition.downloadOperation !== candidate.assetExport.downloadOperation) {
          block('AIH_ASSET_CLOSURE_FAILED', 'Acquisition Packet 下载操作与 Capture Plan 不一致：' + candidate.nodeId, acquisition.downloadOperation);
        }
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
          || file.assetKind !== candidate.assetKind
          || file.captureScope !== candidate.captureScope
          || file.containsDynamicContent !== candidate.containsDynamicContent
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

      const receiptIngestedAt = new Date().toISOString();
      if (
        Date.parse(receiptIngestedAt) < Date.parse(capturePlan.formalCapture.startedAt)
        || Date.parse(receiptIngestedAt) > Date.parse(capturePlan.formalCapture.completedAt)
      ) {
        block('AIH_SOURCE_CAPTURE_BLOCKED', 'Ingest Receipt 时间必须位于 Formal Capture 边界内。', 'ingestedAt');
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
          ingestedAt: receiptIngestedAt,
          assets: verified.map(({ candidate, file }) => ({
            sourceNodeId: file.sourceNodeId,
            path: file.targetPath,
            assetKind: candidate.assetKind,
            captureScope: candidate.captureScope,
            containsDynamicContent: candidate.containsDynamicContent,
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
