import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

export function contentSha256(value) {
  const payload = { ...value };
  delete payload.sha256;
  return 'sha256:' + createHash('sha256').update(Buffer.from(canonicalJson(payload), 'utf8')).digest('hex');
}

export function same(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

export function sameStringSet(left, right) {
  return left.length === right.length && [...new Set(left)].every((item) => right.includes(item));
}

export function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export function createSchemaValidatorCache(loadSchema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  const schemas = new Map();
  const validators = new Map();

  function schema(schemaPath) {
    if (!schemas.has(schemaPath)) schemas.set(schemaPath, Promise.resolve(loadSchema(schemaPath)));
    return schemas.get(schemaPath);
  }

  return {
    schema,
    async get(schemaPath) {
      if (!validators.has(schemaPath)) {
        validators.set(schemaPath, schema(schemaPath).then((value) => ajv.compile(value)));
      }
      return validators.get(schemaPath);
    },
  };
}

function validateAuditRows(rows, location, block, final = false) {
  for (const row of rows) {
    if (row.status === 'FAIL' || (row.status === 'EXCLUDED' && !row.reason)) {
      block(
        final ? 'AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED' : 'AIH_FIGMA_AUDIT_INCOMPLETE',
        '审计存在未解决或无排除理由的项目。',
        location,
      );
    }
  }
}

export function validateFigmaWorkflow(plan, block) {
  const audit = plan.scopeAudit;
  const approval = plan.writebackApproval;
  const receipt = plan.writebackReceipt;
  const acceptance = plan.finalFigmaAcceptance;
  const scan = audit.scanInventory;
  const includedKeys = audit.includedNodes.map((item) => item.kind + ':' + item.nodeId);
  const excludedKeys = audit.excludedNodes.map((item) => item.kind + ':' + item.nodeId);
  const scannedKeys = scan.nodes.map((item) => item.kind + ':' + item.nodeId);
  const includedNodeIds = new Set(audit.includedNodes.map((item) => item.nodeId));

  if (
    duplicateValues(includedKeys).length > 0
    || duplicateValues(excludedKeys).length > 0
    || duplicateValues(scannedKeys).length > 0
    || excludedKeys.some((key) => includedKeys.includes(key))
    || !sameStringSet(scannedKeys, [...includedKeys, ...excludedKeys])
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope Audit 必须无重复、无交集并精确分区 Scan Inventory。', 'scopeAudit');
  }
  if (
    plan.rootNodeId !== audit.rootNodeId
    || scan.rootNodeId !== audit.rootNodeId
    || !includedNodeIds.has(plan.rootNodeId)
    || !same(scan.sourceVersion, audit.sourceVersion)
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scope Audit 的根节点、来源版本或包含范围不闭合。', 'scopeAudit');
  }
  for (const node of scan.nodes) {
    if (node.parentNodeId && !scan.nodes.some((candidate) => candidate.nodeId === node.parentNodeId)) {
      block('AIH_SOURCE_CAPTURE_BLOCKED', 'Scan Inventory parentNodeId 未出现在同一盘点：' + node.nodeId, 'scopeAudit.scanInventory.nodes');
    }
  }

  validateAuditRows(audit.pageCoverage, 'scopeAudit.pageCoverage', block);
  validateAuditRows(audit.groupIntegrity, 'scopeAudit.groupIntegrity', block);
  validateAuditRows(audit.imageGroupCoverage, 'scopeAudit.imageGroupCoverage', block);
  validateAuditRows(audit.stateCoverage, 'scopeAudit.stateCoverage', block);
  validateAuditRows(audit.variantCoverage, 'scopeAudit.variantCoverage', block);
  if (audit.findings.some((item) => !item.resolved)) {
    block('AIH_FIGMA_AUDIT_INCOMPLETE', 'Scope Audit 存在未解决 finding。', 'scopeAudit.findings');
  }

  if (audit.scopeMode === 'file') {
    const scannedPages = scan.nodes.filter((item) => item.kind === 'page').map((item) => item.nodeId);
    const coveredPages = audit.pageCoverage
      .filter((item) => item.status !== 'EXCLUDED' && item.figmaPageNodeId)
      .map((item) => item.figmaPageNodeId);
    if (!sameStringSet(scannedPages, coveredPages)) {
      block('AIH_FIGMA_AUDIT_INCOMPLETE', 'file 模式必须覆盖文件中的全部 Page。', 'scopeAudit.pageCoverage');
    }
  }
  for (const group of audit.groupIntegrity) {
    if (group.memberNodeIds.some((nodeId) => !includedNodeIds.has(nodeId))) {
      block('AIH_FIGMA_AUDIT_INCOMPLETE', 'Group 成员越出确认范围：' + group.groupNodeId, 'scopeAudit.groupIntegrity');
    }
    if (group.containsVisualContent && group.assetBoundaryNodeId !== group.groupNodeId) {
      block('AIH_FIGMA_VISUAL_POLICY_VIOLATION', '含视觉内容的 Group 必须以自身作为 Asset Boundary：' + group.groupNodeId, 'scopeAudit.groupIntegrity');
    }
  }
  for (const image of audit.imageGroupCoverage) {
    if (image.status === 'PASS' && image.ownerGroupNodeId !== image.expectedGroupNodeId) {
      block('AIH_FIGMA_AUDIT_INCOMPLETE', '图片不在预期 Group：' + image.imageNodeId, 'scopeAudit.imageGroupCoverage');
    }
  }
  for (const state of audit.stateCoverage) {
    if (state.status === 'PASS' && state.figmaNodeIds.length === 0) {
      block('AIH_FIGMA_AUDIT_INCOMPLETE', 'State Coverage 未解析到 Figma 节点：' + state.stateId, 'scopeAudit.stateCoverage');
    }
  }
  for (const variant of audit.variantCoverage) {
    if (
      variant.status === 'PASS'
      && (!sameStringSet(variant.expectedValues, variant.observedValues) || variant.definitionNodeIds.length === 0)
    ) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Coverage 未完整覆盖预期值或 Definition：' + variant.proposalId + '/' + variant.axisName, 'scopeAudit.variantCoverage');
    }
  }

  const bindingKeys = [];
  const screensByRoot = new Map();
  for (const binding of audit.screenBindings) {
    bindingKeys.push([binding.screenId, binding.figmaRootNodeId, binding.viewportId, binding.scenarioId].join('/'));
    if (!includedNodeIds.has(binding.figmaRootNodeId)) {
      block('AIH_SOURCE_COVERAGE_FAILED', 'Screen Binding 根节点不在确认范围：' + binding.figmaRootNodeId, 'scopeAudit.screenBindings');
    }
    if (!screensByRoot.has(binding.figmaRootNodeId)) screensByRoot.set(binding.figmaRootNodeId, new Set());
    screensByRoot.get(binding.figmaRootNodeId).add(binding.screenId);
  }
  if (duplicateValues(bindingKeys).length > 0) {
    block('AIH_SOURCE_COVERAGE_FAILED', 'Screen Binding 组合重复。', 'scopeAudit.screenBindings');
  }
  for (const [rootNodeId, screens] of screensByRoot) {
    if (screens.size !== 1) {
      block('AIH_SOURCE_COVERAGE_FAILED', '同一 Figma Root 必须只映射一个 Product Screen：' + rootNodeId, 'scopeAudit.screenBindings');
    }
  }

  if (audit.sha256 !== contentSha256(audit)) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Scope Audit 内容哈希不一致。', 'scopeAudit.sha256');
  }
  if (
    approval.scopeAuditId !== audit.id
    || approval.scopeAuditSha256 !== audit.sha256
    || !same(approval.sourceVersion, audit.sourceVersion)
    || approval.sha256 !== contentSha256(approval)
  ) {
    block('AIH_FIGMA_WRITEBACK_UNAPPROVED', 'Writeback Approval 未绑定当前审计、来源版本或内容哈希。', 'writebackApproval');
  }
  const plannedOperationIds = audit.writebackPlan.map((item) => item.id);
  if (
    duplicateValues(plannedOperationIds).length > 0
    || !sameStringSet(plannedOperationIds, approval.operationIds)
  ) {
    block('AIH_FIGMA_WRITEBACK_UNAPPROVED', 'Writeback Approval 必须精确批准写回计划。', 'writebackApproval.operationIds');
  }
  const detachedNodeIds = audit.writebackPlan
    .filter((item) => item.kind === 'detach-instance')
    .flatMap((item) => item.targetNodeIds);
  if (!sameStringSet(detachedNodeIds, approval.detachApprovals.map((item) => item.instanceNodeId))) {
    block('AIH_FIGMA_WRITEBACK_UNAPPROVED', 'Detach Approval 必须与写回计划一一对应。', 'writebackApproval.detachApprovals');
  }
  for (const operation of audit.writebackPlan) {
    if (operation.targetNodeIds.some((nodeId) => !includedNodeIds.has(nodeId))) {
      block('AIH_FIGMA_WRITEBACK_UNAPPROVED', '写回操作越出确认范围：' + operation.id, 'scopeAudit.writebackPlan');
    }
  }

  if (
    receipt.writebackApprovalId !== approval.id
    || receipt.writebackApprovalSha256 !== approval.sha256
    || receipt.sha256 !== contentSha256(receipt)
    || !sameStringSet(receipt.operationIds, approval.operationIds)
    || !same(receipt.sourceVersionBefore, approval.sourceVersion)
    || !same(receipt.sourceVersionAfter, plan.sourceVersion)
  ) {
    block('AIH_FIGMA_WRITEBACK_UNAPPROVED', 'Writeback Receipt 未精确绑定批准、操作或来源版本。', 'writebackReceipt');
  }
  if (plannedOperationIds.length === 0 && !same(receipt.sourceVersionBefore, receipt.sourceVersionAfter)) {
    block('AIH_FIGMA_WRITEBACK_UNAPPROVED', '空写回不得改变来源版本。', 'writebackReceipt');
  }
  validateAuditRows(receipt.postWriteAudit.pageCoverage, 'writebackReceipt.postWriteAudit.pageCoverage', block, true);
  validateAuditRows(receipt.postWriteAudit.groupIntegrity, 'writebackReceipt.postWriteAudit.groupIntegrity', block, true);
  validateAuditRows(receipt.postWriteAudit.imageGroupCoverage, 'writebackReceipt.postWriteAudit.imageGroupCoverage', block, true);
  validateAuditRows(receipt.postWriteAudit.stateCoverage, 'writebackReceipt.postWriteAudit.stateCoverage', block, true);
  validateAuditRows(receipt.postWriteAudit.variantCoverage, 'writebackReceipt.postWriteAudit.variantCoverage', block, true);
  if (receipt.postWriteAudit.findings.some((item) => !item.resolved)) {
    block('AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED', '写回后仍有未解决 finding。', 'writebackReceipt.postWriteAudit.findings');
  }

  if (
    acceptance.writebackReceiptId !== receipt.id
    || acceptance.writebackReceiptSha256 !== receipt.sha256
    || !same(acceptance.sourceVersion, receipt.sourceVersionAfter)
    || acceptance.sha256 !== contentSha256(acceptance)
    || acceptance.result !== 'accepted'
  ) {
    block('AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED', '最终人工验收缺失、过期或未绑定写回后版本。', 'finalFigmaAcceptance');
  }
  const orderedTimes = [
    scan.scannedAt,
    approval.confirmedAt,
    receipt.completedAt,
    acceptance.confirmedAt,
    plan.frozenAt,
    plan.formalCapture.startedAt,
    plan.formalCapture.completedAt,
  ].map((value) => Date.parse(value));
  if (
    orderedTimes.some((value) => !Number.isFinite(value))
    || orderedTimes.some((value, index) => index > 0 && value < orderedTimes[index - 1])
    || plan.formalCapture.ordinal !== 1
    || !same(plan.formalCapture.sourceVersionBefore, plan.sourceVersion)
    || !same(plan.formalCapture.sourceVersionAfter, plan.sourceVersion)
    || !same(acceptance.sourceVersion, plan.sourceVersion)
  ) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', '扫描、批准、写回、验收、冻结与正式采集的顺序或来源版本无效。', 'formalCapture');
  }

  const visualGroupIds = audit.groupIntegrity.filter((item) => item.containsVisualContent).map((item) => item.groupNodeId);
  const expectedVisualIds = new Set([
    ...audit.includedNodes.filter((item) => ['visual', 'image'].includes(item.kind)).map((item) => item.nodeId),
    ...visualGroupIds,
  ]);
  const candidateIds = plan.candidateVisualNodes.map((item) => item.nodeId);
  if (duplicateValues(candidateIds).length > 0 || !sameStringSet(candidateIds, [...expectedVisualIds])) {
    block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', '视觉候选必须唯一覆盖视觉、图片与视觉 Group。', 'candidateVisualNodes');
  }
  const candidates = new Map(plan.candidateVisualNodes.map((item) => [item.nodeId, item]));
  for (const group of audit.groupIntegrity.filter((item) => item.containsVisualContent)) {
    const boundary = candidates.get(group.assetBoundaryNodeId);
    if (group.assetBoundaryNodeId !== group.groupNodeId || boundary?.strategy !== 'asset') {
      block('AIH_FIGMA_VISUAL_POLICY_VIOLATION', '含视觉内容的 Group 必须登记为唯一整体 Asset：' + group.groupNodeId, 'candidateVisualNodes');
    }
    for (const memberNodeId of group.memberNodeIds) {
      const member = candidates.get(memberNodeId);
      if (member && (member.strategy !== 'ignored' || member.assetBoundaryNodeId !== group.groupNodeId)) {
        block('AIH_FIGMA_VISUAL_POLICY_VIOLATION', 'Group 子节点不得作为独立 Asset 或脱离父 Asset Boundary：' + memberNodeId, 'candidateVisualNodes');
      }
    }
  }
  for (const candidate of plan.candidateVisualNodes) {
    if (candidate.strategy === 'asset' && candidate.assetBoundaryNodeId !== candidate.nodeId) {
      block('AIH_FIGMA_VISUAL_POLICY_VIOLATION', 'Asset 必须由 Asset Boundary 节点整体导出：' + candidate.nodeId, 'candidateVisualNodes');
    }
    if (candidate.assetBoundaryNodeId && candidate.assetBoundaryNodeId !== candidate.nodeId) {
      const boundary = candidates.get(candidate.assetBoundaryNodeId);
      if (candidate.strategy !== 'ignored' || boundary?.strategy !== 'asset') {
        block('AIH_FIGMA_VISUAL_POLICY_VIOLATION', 'Group 子视觉节点只能由父 Asset Boundary 整体覆盖：' + candidate.nodeId, 'candidateVisualNodes');
      }
    }
  }

  const componentNodeIds = new Set(
    audit.includedNodes
      .filter((item) => ['component-set', 'component', 'instance'].includes(item.kind))
      .map((item) => item.nodeId),
  );
  const owners = new Map();
  const proposalIds = audit.componentProposals.map((item) => item.id);
  if (duplicateValues(proposalIds).length > 0) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件提案 ID 重复。', 'scopeAudit.componentProposals');
  }
  for (const proposal of audit.componentProposals) {
    for (const nodeId of proposal.nodeIds) {
      if (!componentNodeIds.has(nodeId) || owners.has(nodeId)) {
        block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件提案越界或重复拥有节点：' + nodeId, 'scopeAudit.componentProposals');
      }
      owners.set(nodeId, proposal.id);
    }
    if (
      !proposal.nodeIds.includes(proposal.componentBoundary.rootNodeId)
      || proposal.componentBoundary.nestedComponentNodeIds.some((nodeId) => !proposal.nodeIds.includes(nodeId))
    ) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', 'Component Boundary 越出提案：' + proposal.id, 'scopeAudit.componentProposals');
    }
    const contract = proposal.figmaComponentContract;
    const propertyNames = contract.properties.map((item) => item.name);
    const axisNames = contract.variantAxes.map((item) => item.name);
    const variantProperties = new Map(
      contract.properties.filter((item) => item.kind === 'variant').map((item) => [item.name, item.values]),
    );
    if (
      duplicateValues(propertyNames).length > 0
      || duplicateValues(axisNames).length > 0
      || !sameStringSet([...variantProperties.keys()], axisNames)
    ) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Property 与 Variant Axis 不闭合：' + proposal.id, 'scopeAudit.componentProposals');
    }
    for (const axis of contract.variantAxes) {
      if (!sameStringSet(axis.values, variantProperties.get(axis.name) || [])) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Figma Variant Axis 值不闭合：' + proposal.id + '/' + axis.name, 'scopeAudit.componentProposals');
      }
    }
  }
  if (!sameStringSet([...owners.keys()], [...componentNodeIds])) {
    block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '组件提案必须互斥并精确覆盖全部组件相关节点。', 'scopeAudit.componentProposals');
  }
}

export function validateFigmaDesignContext(plan, planHash, context, block) {
  if (
    context.sourceId !== plan.sourceId
    || context.nodeId !== plan.rootNodeId
    || !same(context.sourceVersion, plan.sourceVersion)
    || context.rawCapture.requestedNodeId !== context.nodeId
    || context.rawCapture.capturedAt !== context.capturedAt
    || !same(context.rawCapture.sourceVersion, context.sourceVersion)
    || context.rawCapture.capturePlanSha256 !== planHash
  ) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Design Context、Raw Capture 与 Capture Plan 身份不一致。', 'designContext');
  }
  const capturedAt = Date.parse(context.capturedAt);
  if (capturedAt < Date.parse(plan.formalCapture.startedAt) || capturedAt > Date.parse(plan.formalCapture.completedAt)) {
    block('AIH_SOURCE_CAPTURE_BLOCKED', 'Design Context 必须位于 Formal Capture 时间边界内。', 'designContext.capturedAt');
  }

  const catalog = new Map();
  for (const node of context.visualNodeCatalog) {
    if (catalog.has(node.nodeId)) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Visual Node Catalog 重复：' + node.nodeId, 'designContext.visualNodeCatalog');
    }
    catalog.set(node.nodeId, node);
  }
  if (!sameStringSet([...catalog.keys()], plan.candidateVisualNodes.map((item) => item.nodeId))) {
    block('AIH_ASSET_CLASSIFICATION_INCOMPLETE', 'Visual Node Catalog 必须精确覆盖 Candidate Visual Nodes。', 'designContext.visualNodeCatalog');
  }
  for (const candidate of plan.candidateVisualNodes) {
    const node = catalog.get(candidate.nodeId);
    if (!node) continue;
    const hasVisualDrawing = node.hasPaint || node.hasStroke || node.hasEffect || node.hasMask || node.hasRaster;
    if (candidate.strategy === 'layout' && hasVisualDrawing) {
      block('AIH_FIGMA_VISUAL_POLICY_VIOLATION', 'layout 节点包含 Paint、Stroke、Effect、Mask 或 Raster：' + candidate.nodeId, 'designContext.visualNodeCatalog');
    }
    if (candidate.assetBoundaryNodeId !== node.assetBoundaryNodeId) {
      block('AIH_FIGMA_VISUAL_POLICY_VIOLATION', 'Capture Plan 与 Design Context 的 Asset Boundary 不一致：' + candidate.nodeId, 'designContext.visualNodeCatalog');
    }
  }

  const components = new Map();
  for (const component of context.components) {
    if (components.has(component.nodeId)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Design Context 组件节点重复：' + component.nodeId, 'designContext.components');
    }
    components.set(component.nodeId, component);
  }
  const scopedComponentIds = plan.scopeAudit.includedNodes
    .filter((item) => ['component-set', 'component', 'instance'].includes(item.kind))
    .map((item) => item.nodeId);
  for (const nodeId of scopedComponentIds) {
    if (!components.has(nodeId)) {
      block('AIH_COMPONENT_ABSTRACTION_UNRESOLVED', '确认范围内组件未出现在 Design Context：' + nodeId, 'designContext.components');
    }
  }
  const screensByRoot = new Map();
  for (const binding of plan.scopeAudit.screenBindings) {
    if (!screensByRoot.has(binding.figmaRootNodeId)) screensByRoot.set(binding.figmaRootNodeId, new Set());
    screensByRoot.get(binding.figmaRootNodeId).add(binding.screenId);
  }
  for (const instance of context.components.filter((item) => item.kind === 'instance')) {
    if (screensByRoot.get(instance.screenRootNodeId)?.size !== 1) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Instance 必须解析到唯一 Product Screen：' + instance.nodeId, 'designContext.components');
    }
    const main = components.get(instance.mainComponentNodeId);
    if (
      main?.kind !== 'component'
      || main.componentSetNodeId !== instance.componentSetNodeId
      || !same(main.variantProperties, instance.variantProperties)
    ) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Instance 与 Main Component 或 Variant 不闭合：' + instance.nodeId, 'designContext.components');
    }
  }

  const setCatalogs = new Map();
  for (const item of context.componentSetCatalog) {
    if (setCatalogs.has(item.componentSetNodeId)) {
      block('AIH_COMPONENT_MAPPING_INVALID', 'Component Set Catalog 重复：' + item.componentSetNodeId, 'designContext.componentSetCatalog');
    }
    setCatalogs.set(item.componentSetNodeId, item);
  }
  for (const [setNodeId, item] of setCatalogs) {
    const definitions = context.components
      .filter((component) => component.kind === 'component' && component.componentSetNodeId === setNodeId);
    if (!sameStringSet(item.definitionNodeIds, definitions.map((definition) => definition.nodeId))) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Component Set Catalog 未覆盖全部 Definition：' + setNodeId, 'designContext.componentSetCatalog');
    }
    const axisNames = item.axes.map((axis) => axis.name);
    const observed = new Map(item.axes.map((axis) => [axis.name, new Set()]));
    const combinations = [];
    for (const definition of definitions) {
      if (!sameStringSet(Object.keys(definition.variantProperties), axisNames)) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 轴与 Catalog 不一致：' + definition.nodeId, 'designContext.components');
        continue;
      }
      for (const axis of item.axes) observed.get(axis.name).add(definition.variantProperties[axis.name]);
      combinations.push(canonicalJson(definition.variantProperties));
    }
    if (duplicateValues(combinations).length > 0) {
      block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Definition 组合重复：' + setNodeId, 'designContext.components');
    }
    for (const axis of item.axes) {
      if (!sameStringSet(axis.values, [...observed.get(axis.name)])) {
        block('AIH_COMPONENT_VARIANT_COVERAGE_FAILED', 'Variant Axis 值与 Definition 不闭合：' + setNodeId + '/' + axis.name, 'designContext.componentSetCatalog');
      }
    }
  }

  const contextAssets = new Map(context.assets.map((item) => [item.nodeId, item]));
  const plannedAssets = plan.candidateVisualNodes.filter((item) => item.strategy === 'asset');
  if (contextAssets.size !== context.assets.length || !sameStringSet([...contextAssets.keys()], plannedAssets.map((item) => item.nodeId))) {
    block('AIH_ASSET_CLOSURE_FAILED', 'Design Context Asset 集合必须与 Capture Plan 完全一致。', 'designContext.assets');
  }
  for (const planned of plannedAssets) {
    const actual = contextAssets.get(planned.nodeId);
    if (
      !actual
      || actual.assetBoundaryNodeId !== planned.assetBoundaryNodeId
      || actual.assetKind !== planned.assetKind
      || actual.captureScope !== planned.captureScope
      || actual.containsDynamicContent !== planned.containsDynamicContent
      || actual.recommendedFormat !== planned.assetExport.format
    ) {
      block('AIH_ASSET_CLOSURE_FAILED', 'Design Context Asset 与 Capture Plan 不一致：' + planned.nodeId, 'designContext.assets');
    }
  }
}

function indexed(items, key, code, message, location, block) {
  const result = new Map();
  for (const item of items) {
    const value = item[key];
    if (result.has(value)) block(code, message + value, location);
    result.set(value, item);
  }
  return result;
}

export function validateFigmaAssetClosure({
  plan,
  planSha256,
  context,
  receipt,
  evidence,
  registration,
  location = 'registration',
}, block) {
  if (
    registration.sourceId !== plan.sourceId
    || registration.sourceId !== context.sourceId
    || registration.sourceId !== receipt.sourceId
    || registration.sourceId !== evidence.sourceId
    || evidence.nodeId !== plan.rootNodeId
    || !same(registration.sourceVersion, plan.sourceVersion)
    || !same(registration.sourceVersion, context.sourceVersion)
    || !same(registration.sourceVersion, receipt.sourceVersion)
    || !same(registration.sourceVersion, evidence.sourceVersion)
  ) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Registration、Capture、Context、Receipt 与 Evidence 身份不一致。', location);
  }
  if (
    registration.capturePlan.sha256 !== planSha256
    || receipt.capturePlan.path !== registration.capturePlan.path
    || receipt.capturePlan.sha256 !== planSha256
  ) {
    block('AIH_SOURCE_INTEGRITY_FAILED', 'Ingest Receipt 与 Registration 未绑定当前 Capture Plan。', location);
  }

  const plannedAssets = indexed(
    plan.candidateVisualNodes.filter((item) => item.strategy === 'asset'),
    'nodeId',
    'AIH_ASSET_CLASSIFICATION_INCOMPLETE',
    'Capture Plan 重复登记 Asset：',
    location,
    block,
  );
  const contextAssets = indexed(context.assets, 'nodeId', 'AIH_ASSET_CLOSURE_FAILED', 'Design Context 重复登记 Asset：', location, block);
  const receiptAssets = indexed(receipt.assets, 'sourceNodeId', 'AIH_ASSET_CLOSURE_FAILED', 'Ingest Receipt 重复登记 Asset：', location, block);
  const evidenceAssets = indexed(
    (evidence.items || []).filter((item) => item.role === 'asset'),
    'sourceNodeId',
    'AIH_ASSET_CLOSURE_FAILED',
    'Evidence 重复登记 Asset：',
    location,
    block,
  );
  const registrationAssets = indexed(registration.assets, 'sourceNodeId', 'AIH_ASSET_CLOSURE_FAILED', 'Registration 重复登记 Asset：', location, block);
  const expectedNodeIds = [...plannedAssets.keys()];
  for (const [label, actual] of [
    ['Design Context', contextAssets],
    ['Ingest Receipt', receiptAssets],
    ['Evidence', evidenceAssets],
    ['Registration', registrationAssets],
  ]) {
    if (!sameStringSet(expectedNodeIds, [...actual.keys()])) {
      block('AIH_ASSET_CLOSURE_FAILED', label + ' Asset 集合与 Capture Plan 不闭合。', location);
    }
  }

  for (const [nodeId, planned] of plannedAssets) {
    const inContext = contextAssets.get(nodeId);
    const received = receiptAssets.get(nodeId);
    const evidenced = evidenceAssets.get(nodeId);
    const registered = registrationAssets.get(nodeId);
    if (
      !inContext
      || !evidenced
      || evidenced.sourceNodeId !== inContext?.nodeId
      || evidenced.assetBoundaryNodeId !== inContext?.assetBoundaryNodeId
      || evidenced.assetKind !== inContext?.assetKind
      || evidenced.captureScope !== inContext?.captureScope
      || evidenced.containsDynamicContent !== inContext?.containsDynamicContent
    ) {
      block('AIH_SOURCE_INTEGRITY_FAILED', 'Asset Evidence 与 Design Context 的来源事实不一致：' + nodeId, location);
    }
    if (
      !inContext
      || !received
      || !evidenced
      || !registered
      || inContext.assetBoundaryNodeId !== planned.assetBoundaryNodeId
      || received.assetBoundaryNodeId !== planned.assetBoundaryNodeId
      || evidenced.assetBoundaryNodeId !== planned.assetBoundaryNodeId
      || registered.assetBoundaryNodeId !== planned.assetBoundaryNodeId
      || inContext.assetKind !== planned.assetKind
      || received.assetKind !== planned.assetKind
      || evidenced.assetKind !== planned.assetKind
      || registered.assetKind !== planned.assetKind
      || inContext.captureScope !== planned.captureScope
      || received.captureScope !== planned.captureScope
      || evidenced.captureScope !== planned.captureScope
      || registered.captureScope !== planned.captureScope
      || inContext.containsDynamicContent !== planned.containsDynamicContent
      || received.containsDynamicContent !== planned.containsDynamicContent
      || evidenced.containsDynamicContent !== planned.containsDynamicContent
      || registered.containsDynamicContent !== planned.containsDynamicContent
      || received.path !== planned.assetExport.targetPath
      || evidenced.path !== planned.assetExport.targetPath
      || registered.path !== planned.assetExport.targetPath
      || received.format !== planned.assetExport.format
      || evidenced.format !== planned.assetExport.format
      || registered.format !== planned.assetExport.format
      || received.scale !== planned.assetExport.scale
      || evidenced.scale !== planned.assetExport.scale
      || registered.scale !== planned.assetExport.scale
      || !same(received.cropBounds, planned.assetExport.cropBounds)
      || !same(evidenced.cropBounds, planned.assetExport.cropBounds)
      || !same(registered.cropBounds, planned.assetExport.cropBounds)
      || !same(received.transparentPadding, planned.assetExport.transparentPadding)
      || !same(evidenced.transparentPadding, planned.assetExport.transparentPadding)
      || !same(registered.transparentPadding, planned.assetExport.transparentPadding)
      || !same(received.expectedDimensions, planned.assetExport.expectedDimensions)
      || !same(evidenced.expectedDimensions, planned.assetExport.expectedDimensions)
      || !same(registered.expectedDimensions, planned.assetExport.expectedDimensions)
      || !same(received.consumerTargets, planned.consumerTargets)
      || !same(evidenced.consumerTargets, planned.consumerTargets)
      || !same(registered.consumerTargets, planned.consumerTargets)
      || received.sha256 !== evidenced.sha256
      || received.sha256 !== registered.sha256
      || receipt.downloadOperation !== planned.assetExport.downloadOperation
      || evidenced.downloadOperation !== planned.assetExport.downloadOperation
      || registered.downloadOperation !== planned.assetExport.downloadOperation
      || evidenced.strategy !== 'asset'
      || registered.strategy !== 'asset'
      || evidenced.status !== 'verified'
      || registered.status !== 'verified'
    ) {
      block('AIH_ASSET_CLOSURE_FAILED', 'Asset 事实不闭合：' + nodeId, location);
    }
  }
}
