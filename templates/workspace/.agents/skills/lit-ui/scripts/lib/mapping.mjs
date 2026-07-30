import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const DATA_PATTERN = /<script(?=[^>]*\bid=["']psp-mapping-data["'])(?=[^>]*\btype=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/i;
const IMPLEMENTATION_KEYS = new Set([
  'sourcePath', 'filePath', 'className', 'functionName', 'litTag', 'tagName', 'domSelector', 'selector',
  'implementationPlan', 'taskPlan', 'buildTask',
]);
const IMPLEMENTATION_VALUE = /(?:^|[/\\])src[/\\]|\.tsx?\b|querySelector|document\.|<[-a-z]+(?:\s|>)|#[A-Za-z][\w-]*|\b(?:class|function)\s+[A-Za-z_$]/i;
const STATUS_VALUES = new Set(['proposed', 'confirmed', 'gap', 'rejected', 'stale']);
const KINDS = new Set(['page', 'region', 'component', 'component-instance', 'state', 'event', 'transition', 'route', 'motion', 'port']);
const STATE_LAYERS = new Set(['business', 'interaction', 'page', 'component']);

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

export function mappingContentHash(model) {
  const payload = structuredClone(model);
  delete payload.confirmation;
  return 'sha256:' + createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export function extractMapping(html) {
  const match = html.match(DATA_PATTERN);
  if (!match) throw new Error('MAPPING_DATA_MISSING');
  return JSON.parse(match[1]);
}

export async function readMapping(path) {
  return extractMapping(await readFile(path, 'utf8'));
}

export function renderMapping(template, model) {
  const encoded = JSON.stringify(model).replaceAll('<', '\\u003c');
  if (!DATA_PATTERN.test(template)) throw new Error('MAPPING_DATA_MISSING');
  return template.replace(DATA_PATTERN, `<script id="psp-mapping-data" type="application/json">\n${encoded}\n  </script>`);
}

function blocker(code, message, location) {
  return { code, message, ...(location ? { location } : {}) };
}

function visit(value, location, blockers) {
  if (typeof value === 'string') {
    if (IMPLEMENTATION_VALUE.test(value)) {
      blockers.push(blocker(
        'MAPPING_LEAKS_IMPLEMENTATION_DETAIL',
        'Mapping 不得记录源码、符号、Lit Tag 或 DOM 细节。',
        location,
      ));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${location}[${index}]`, blockers));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (IMPLEMENTATION_KEYS.has(key)) {
      blockers.push(blocker(
        'MAPPING_LEAKS_IMPLEMENTATION_DETAIL',
        `Mapping 不得记录实现字段 ${key}。`,
        `${location}.${key}`,
      ));
    }
    visit(child, `${location}.${key}`, blockers);
  }
}

export function validateMapping(model, options = {}) {
  const blockers = [];
  if (model?.schemaVersion !== 'psp.dev/mapping/v1' || typeof model.mappingVersion !== 'string') {
    blockers.push(blocker('MAPPING_CONTRACT_INVALID', 'Mapping 根版本字段无效。', 'mapping'));
    return blockers;
  }
  for (const source of ['figma', 'uc']) {
    const binding = model.sources?.[source];
    if (!binding?.version || !/^sha256:[a-f0-9]{64}$/i.test(binding.contentHash ?? '')) {
      blockers.push(blocker('MAPPING_SOURCE_BINDING_INVALID', `${source} 来源必须绑定版本和 SHA-256。`, `sources.${source}`));
    }
  }
  if (!Array.isArray(model.concepts) || !Array.isArray(model.questions)) {
    blockers.push(blocker('MAPPING_CONTRACT_INVALID', 'concepts 与 questions 必须是数组。', 'mapping'));
    return blockers;
  }

  const ids = new Set();
  const concepts = new Map();
  for (const [index, concept] of model.concepts.entries()) {
    const location = `concepts[${index}]`;
    if (!concept?.conceptId || ids.has(concept.conceptId)) {
      blockers.push(blocker('MAPPING_CONCEPT_ID_INVALID', 'conceptId 必须存在且唯一。', `${location}.conceptId`));
      continue;
    }
    ids.add(concept.conceptId);
    concepts.set(concept.conceptId, concept);
    if (!KINDS.has(concept.kind) || !STATUS_VALUES.has(concept.status)) {
      blockers.push(blocker('MAPPING_CONTRACT_INVALID', '概念 kind 或 status 无效。', location));
    }
    if (
      !Array.isArray(concept.sourceRefs)
      || !Array.isArray(concept.relations)
      || !Array.isArray(concept.useCaseRefs)
      || !concept.observableContract
      || typeof concept.observableContract !== 'object'
    ) {
      blockers.push(blocker('MAPPING_CONTRACT_INVALID', '概念引用字段必须为数组。', location));
    }
    if (concept.kind === 'state' && !STATE_LAYERS.has(concept.stateLayer)) {
      blockers.push(blocker('MAPPING_STATE_LAYER_COLLISION', 'State 必须明确属于四层之一。', `${location}.stateLayer`));
    }
    const refs = new Set(concept.sourceRefs ?? []);
    if (concept.observableContract?.business && ![...refs].some((ref) => /^(?:uc|user):/.test(ref))) {
      blockers.push(blocker('MAPPING_SOURCE_AUTHORITY_VIOLATION', '业务事实必须来自 UC 或用户确认。', location));
    }
    if (concept.observableContract?.visual && ![...refs].some((ref) => /^(?:figma|user):/.test(ref))) {
      blockers.push(blocker('MAPPING_SOURCE_AUTHORITY_VIOLATION', '视觉事实必须来自 Figma 或用户确认。', location));
    }
  }
  visit(model.concepts, 'concepts', blockers);

  for (const [index, question] of model.questions.entries()) {
    if (!['open', 'resolved'].includes(question.status)) {
      blockers.push(blocker('MAPPING_CONTRACT_INVALID', '问题状态必须为 open 或 resolved。', `questions[${index}].status`));
    }
    if (question.status === 'open' && (!question.conceptId || !concepts.has(question.conceptId))) {
      blockers.push(blocker('MAPPING_QUESTION_UNBOUND', '待澄清问题必须绑定有效 conceptId。', `questions[${index}].conceptId`));
    }
  }
  for (const concept of model.concepts) {
    for (const relation of concept.relations ?? []) {
      if (!relation?.kind || !concepts.has(relation.targetConceptId)) {
        blockers.push(blocker('MAPPING_CONTRACT_INVALID', '关系必须指向有效 conceptId。', concept.conceptId));
      }
    }
  }

  const stateGroups = new Map();
  for (const concept of model.concepts.filter((item) => item.kind === 'state')) {
    const group = stateGroups.get(concept.name) ?? [];
    group.push(concept);
    stateGroups.set(concept.name, group);
  }
  for (const group of stateGroups.values()) {
    const layers = new Set(group.map((item) => item.stateLayer));
    if (layers.size < 2) continue;
    for (const concept of group) {
      for (const relation of concept.relations ?? []) {
        const target = concepts.get(relation.targetConceptId);
        if (
          relation.kind === 'same-as'
          && target?.kind === 'state'
          && target.stateLayer !== concept.stateLayer
          && relation.confirmedBy !== 'user'
        ) {
          blockers.push(blocker(
            'MAPPING_STATE_LAYER_COLLISION',
            '跨层同名 State 不得自动合并；same-as 必须由用户确认。',
            concept.conceptId,
          ));
        }
      }
    }
  }

  if (
    model.concepts.length === 0
    || model.concepts.some((item) => ['proposed', 'gap', 'stale'].includes(item.status))
    || model.questions.some((item) => item.status === 'open')
  ) {
    blockers.push(blocker('MAPPING_GAPS_OPEN', '存在未解决 gap 或待澄清问题。', 'mapping'));
  }

  const confirmation = model.confirmation;
  const expected = mappingContentHash(model);
  if (
    !confirmation
    || confirmation.status !== 'confirmed'
    || confirmation.mappingVersion !== model.mappingVersion
    || confirmation.mappingContentHash !== expected
    || confirmation.figmaVersion !== model.sources.figma.version
    || confirmation.figmaContentHash !== model.sources.figma.contentHash
    || confirmation.ucVersion !== model.sources.uc.version
    || confirmation.ucContentHash !== model.sources.uc.contentHash
  ) {
    blockers.push(blocker('MAPPING_CONFIRMATION_STALE', 'Mapping 确认未绑定当前来源版本与内容哈希。', 'confirmation'));
  }
  if (options.parallelArtifacts?.length) {
    blockers.push(blocker('MAPPING_AUTHORITY_DUPLICATED', '发现平行 Preview/JSON 映射权威。', options.parallelArtifacts[0]));
  }
  return blockers;
}

export function confirmationFor(model, confirmedBy, confirmedAt = new Date().toISOString()) {
  return {
    status: 'confirmed',
    confirmedBy,
    confirmedAt,
    mappingVersion: model.mappingVersion,
    mappingContentHash: mappingContentHash(model),
    figmaVersion: model.sources.figma.version,
    figmaContentHash: model.sources.figma.contentHash,
    ucVersion: model.sources.uc.version,
    ucContentHash: model.sources.uc.contentHash,
  };
}
