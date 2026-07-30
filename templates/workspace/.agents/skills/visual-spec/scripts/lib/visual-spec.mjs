import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  artifactDefinition,
  artifactPaths,
  loadProject,
  readStructured,
  repositoryFile,
} from '../../../../runtime/project.mjs';

export const SOURCE_IDS = Object.freeze({
  capabilities: 'PRODUCT-USE-CASES',
  'functional-delivery-baseline': 'FUNCTIONAL-DELIVERY-BASELINE',
  'test-case-catalog': 'TEST-CASE-CATALOG',
});

export function sha256(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

export function blocker(code, message, location = null) {
  return { code, message, ...(location ? { location } : {}) };
}

export function isLegacyVisualInput(value, path = '') {
  const pathText = String(path).replaceAll('\\', '/').toLowerCase();
  if (/(?:^|\/)(mapping\.html|litspec\.html|preview\.html|visual-spec\.(?:md|html)|ui-cases\.json|(?:acquisition|registration)-packet\.json)$/.test(pathText)) return true;
  const visit = (current, seen = new Set()) => {
    if (!current || typeof current !== 'object' || seen.has(current)) return false;
    seen.add(current);
    if (['LitSpec', 'Mapping', 'VisualSpecDraft'].includes(current.kind)) return true;
    if (['LITSPEC', 'MAPPING'].some((name) => String(current?.metadata?.artifactId ?? '').includes(name))) return true;
    if (Object.hasOwn(current, 'conceptId') || Object.hasOwn(current, 'consumerTargets')) return true;
    return Object.values(current).some((entry) => visit(entry, seen));
  };
  return visit(value);
}

export async function validateWithSchema(root, schemaPath, data) {
  const schema = JSON.parse(await readFile(repositoryFile(root, schemaPath), 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(schema);
  return validate(data)
    ? []
    : (validate.errors ?? []).map((error) => blocker(
      'VSC_SCHEMA_INVALID',
      error.message ?? error.keyword,
      error.instancePath || '/',
    ));
}

export async function sourceRecord(root, project, stageId, artifactId) {
  const definition = artifactDefinition(project, artifactId, stageId);
  const paths = artifactPaths(project, artifactId, stageId);
  if (!definition || !paths?.authorityPath) {
    throw Object.assign(new Error(`Registry 未唯一绑定 ${stageId}.${artifactId}。`), {
      code: 'VISUAL_SPEC_SOURCE_LOCK_INVALID',
    });
  }
  const bytes = await readFile(repositoryFile(root, paths.authorityPath));
  const data = await readStructured(root, paths.authorityPath, definition.format);
  return {
    stageId,
    artifactId,
    declaredArtifactId: SOURCE_IDS[artifactId],
    definition,
    path: paths.authorityPath,
    bytes,
    digest: sha256(bytes),
    revision: data?.metadata?.revision,
    data,
  };
}

export async function loadSourceSet(root, needsTestCases) {
  const project = await loadProject(root);
  const records = [
    await sourceRecord(root, project, 'product-design', 'capabilities'),
    await sourceRecord(root, project, 'product-design', 'functional-delivery-baseline'),
  ];
  if (needsTestCases) records.push(await sourceRecord(root, project, 'user-path-cases', 'test-case-catalog'));
  return { project, records };
}

export function sourceLock(record) {
  return {
    artifactId: record.declaredArtifactId,
    path: record.path,
    revision: record.revision,
    digest: record.digest,
  };
}

export function collectProductIds(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectProductIds(item, result);
  } else if (value && typeof value === 'object') {
    if (typeof value.id === 'string' && /^(UC-[0-9]{3}(?:[A-Z0-9-]*)?|INT-STATE-[0-9]{3}|LF-(?:SCREEN|REGION|CONTROL)-[0-9]{3})$/.test(value.id)) {
      result.add(value.id);
    }
    for (const item of Object.values(value)) collectProductIds(item, result);
  }
  return result;
}

export function testCaseIndexes(catalog) {
  const cases = new Map();
  const steps = new Set();
  for (const item of catalog?.testCases ?? []) {
    cases.set(item.testCaseId, item);
    for (const step of item.steps ?? []) steps.add(step.stepId);
  }
  return { cases, steps };
}

function productEntityMap(value, result = new Map()) {
  if (Array.isArray(value)) {
    for (const item of value) productEntityMap(item, result);
  } else if (value && typeof value === 'object') {
    if (typeof value.id === 'string') result.set(value.id, value);
    for (const item of Object.values(value)) productEntityMap(item, result);
  }
  return result;
}

export function stableChecklistItems(baseline, useCases = null, testCatalog = null) {
  const output = [];
  const products = productEntityMap(useCases);
  const tests = new Map((testCatalog?.testCases ?? []).map((item) => [item.testCaseId, item]));
  for (const item of [...(baseline.items ?? [])].sort((a, b) => a.baselineItemId.localeCompare(b.baselineItemId))) {
    if (item.classification !== 'visual') continue;
    const groups = new Map();
    for (const requirement of item.visualRequirements ?? []) {
      const list = groups.get(requirement.kind) ?? [];
      list.push(requirement);
      groups.set(requirement.kind, list);
    }
    for (const kind of [...groups.keys()].sort()) {
      const requirements = groups.get(kind).sort((left, right) => (
        left.sourceRef.localeCompare(right.sourceRef)
        || left.name.localeCompare(right.name)
        || JSON.stringify(left.requirementRefs).localeCompare(JSON.stringify(right.requirementRefs))
      ));
      requirements.forEach((requirement, index) => {
        const dependencyDigest = sha256(Buffer.from(stableJson({
          baselineItem: item,
          productEntities: [...new Set(requirement.requirementRefs)]
            .sort()
            .map((id) => products.get(id) ?? { id }),
          testCases: [...(item.testCaseRefs ?? [])]
            .sort()
            .map((id) => tests.get(id) ?? { testCaseId: id }),
        })));
        output.push({
          itemId: `VSI-${item.baselineItemId}-${kind}-${String(index + 1).padStart(2, '0')}`,
          baselineItemRef: item.baselineItemId,
          requirementRefs: [...requirement.requirementRefs].sort(),
          target: { kind, ref: requirement.sourceRef, name: requirement.name },
          requiredDeliveryLevel: item.deliveryLevel,
          testCaseRefs: item.deliveryLevel === 'USER_PATH' ? [...item.testCaseRefs].sort() : [],
          dimensions: {
            viewports: [...(requirement.viewports ?? [])].sort(),
            states: [...(requirement.states ?? [])].sort(),
            variants: [...(requirement.variants ?? [])].sort(),
            contentCases: [...(requirement.contentCases ?? [])].sort(),
            tokens: [...(requirement.tokens ?? [])].sort(),
            assets: [...(requirement.assets ?? [])].sort(),
            motions: [...(requirement.motions ?? [])].sort(),
          },
          dependencyDigest,
          status: 'pending',
        });
      });
    }
  }
  return output;
}

export function validateReferences(useCases, baseline, testCatalog = null) {
  const blockers = [];
  const productIds = collectProductIds(useCases);
  const products = productEntityMap(useCases);
  const indexes = testCaseIndexes(testCatalog);
  const duplicateIds = (values, label) => {
    const seen = new Set();
    for (const value of values.filter(Boolean)) {
      if (seen.has(value)) blockers.push(blocker(
        'VSC_SCHEMA_INVALID',
        `${label} 重复：${value}`,
      ));
      seen.add(value);
    }
  };
  duplicateIds((baseline.items ?? []).map((item) => item.baselineItemId), 'Baseline ID');
  duplicateIds((testCatalog?.testCases ?? []).map((item) => item.testCaseId), 'Test Case ID');
  duplicateIds(
    (testCatalog?.testCases ?? []).flatMap((item) => (item.steps ?? []).map((step) => step.stepId)),
    'Test Case Step ID',
  );
  for (const testCase of testCatalog?.testCases ?? []) {
    if (!productIds.has(testCase.useCaseRef)) {
      blockers.push(blocker(
        'VISUAL_SPEC_TEST_CASE_REF_INVALID',
        `${testCase.testCaseId} 引用未知 Use Case：${testCase.useCaseRef}`,
      ));
    }
    if (
      testCase.scenarioRef !== 'main'
      && (!testCase.scenarioRef.startsWith(`${testCase.useCaseRef}-`) || !productIds.has(testCase.scenarioRef))
    ) blockers.push(blocker(
      'VISUAL_SPEC_TEST_CASE_REF_INVALID',
      `${testCase.testCaseId} 的 Scenario ${testCase.scenarioRef} 不属于 ${testCase.useCaseRef} 或不存在。`,
    ));
    const expectedStepPrefix = testCase.scenarioRef === 'main'
      ? `${testCase.useCaseRef}-STEP-`
      : `${testCase.scenarioRef}-STEP-`;
    for (const step of testCase.steps ?? []) {
      const source = products.get(step.useCaseStepRef);
      if (
        !step.stepId.startsWith(`${testCase.testCaseId}-STEP-`)
        || !step.useCaseStepRef.startsWith(expectedStepPrefix)
        || !source
      ) {
        blockers.push(blocker(
          'VISUAL_SPEC_TEST_CASE_REF_INVALID',
          `${step.stepId} 引用未知或越界的 Use Case Step：${step.useCaseStepRef}`,
        ));
      } else if (step.action !== source.action || step.expectedOutcome !== source.outcome) {
        blockers.push(blocker(
          'VISUAL_SPEC_TEST_CASE_REF_INVALID',
          `${step.stepId} 的 action/expectedOutcome 与来源步骤不一致。`,
        ));
      }
    }
  }
  for (const [index, item] of (baseline.items ?? []).entries()) {
    duplicateIds(
      (item.visualRequirements ?? []).map((requirement) => `${item.baselineItemId}:${requirement.kind}:${requirement.sourceRef}`),
      'Baseline Visual Requirement identity',
    );
    for (const ref of item.targetRefs ?? []) {
      if (!productIds.has(ref)) blockers.push(blocker(
        'VISUAL_SPEC_BASELINE_REF_INVALID',
        `Baseline 引用未知 Product 身份：${ref}`,
        `items[${index}].targetRefs`,
      ));
    }
    for (const requirement of item.visualRequirements ?? []) {
      for (const ref of requirement.requirementRefs ?? []) {
        if (!productIds.has(ref)) blockers.push(blocker(
          'VISUAL_SPEC_BASELINE_REF_INVALID',
          `视觉要求引用未知 Product 身份：${ref}`,
          `items[${index}].visualRequirements`,
        ));
      }
    }
    if (item.classification === 'visual' && item.deliveryLevel === 'USER_PATH') {
      if (!testCatalog || !(item.testCaseRefs ?? []).length) {
        blockers.push(blocker('VISUAL_SPEC_TEST_CASE_REQUIRED', `${item.baselineItemId} 要求 USER_PATH，但没有 Test Case。`));
      } else {
        for (const ref of item.testCaseRefs) {
          const testCase = indexes.cases.get(ref);
          if (!testCase) {
            blockers.push(blocker('VISUAL_SPEC_TEST_CASE_REF_INVALID', `未知 Test Case：${ref}`));
            continue;
          }
        }
      }
    }
  }
  return blockers;
}

export function sourceReadiness(record) {
  const result = [];
  if (record.data?.metadata?.artifactId !== record.declaredArtifactId) {
    result.push(blocker('VISUAL_SPEC_SOURCE_LOCK_INVALID', `${record.path} Artifact ID 不匹配。`));
  }
  if (!Number.isInteger(record.revision) || record.revision < 1) {
    result.push(blocker('VISUAL_SPEC_SOURCE_LOCK_INVALID', `${record.path} revision 无效。`));
  }
  const classifiedGap = record.declaredArtifactId === 'FUNCTIONAL-DELIVERY-BASELINE'
    && (record.data?.items ?? []).some((item) => item.classification === 'gap');
  if (record.data?.metadata?.status !== 'ready' || (record.data?.gaps ?? []).length > 0 || classifiedGap) {
    result.push(blocker('VISUAL_SPEC_SOURCE_NOT_READY', `${record.path} 未 ready 或仍有 gap。`));
  }
  return result;
}
