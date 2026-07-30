import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function blocker(code, message, location) {
  return { code, message, ...(location ? { location } : {}) };
}

export function validateCases(model) {
  const blockers = [];
  if (model?.schemaVersion !== 'psp.dev/ui-cases/v1') {
    return [blocker('UI_CASE_CONTRACT_INVALID', '用例契约版本无效。')];
  }
  const businessKinds = new Set(['route', 'page', 'component', 'event', 'port', 'state']);
  const componentKinds = new Set(['property', 'attribute', 'slot', 'component-state', 'event', 'motion', 'viewport']);
  const allIds = new Set();
  for (const [layer, cases, prefix] of [
    ['business', model.businessCases, 'BUSINESS-CASE-'],
    ['component', model.componentCases, 'COMPONENT-CASE-'],
  ]) {
    if (!Array.isArray(cases)) {
      blockers.push(blocker('UI_CASE_CONTRACT_INVALID', `${layer}Cases 必须为数组。`));
      continue;
    }
    for (const [index, item] of cases.entries()) {
      const location = `${layer}Cases[${index}]`;
      if (!item.caseId?.startsWith(prefix) || allIds.has(item.caseId)) {
        blockers.push(blocker('UI_CASE_LAYER_COLLISION', '用例 ID 必须体现唯一所属层。', `${location}.caseId`));
      }
      allIds.add(item.caseId);
      const refs = new Set(item.sourceRefs ?? []);
      for (const source of ['uc:', 'mapping:', 'framework:']) {
        if (![...refs].some((ref) => ref.startsWith(source))) {
          blockers.push(blocker('UI_CASE_TRACEABILITY_MISSING', `用例缺少 ${source.slice(0, -1)} 追溯。`, location));
        }
      }
      const facts = layer === 'business' ? item.steps : item.checks;
      if (!Array.isArray(facts) || !facts.length) {
        blockers.push(blocker('UI_CASE_CONTRACT_INVALID', '用例必须包含可验证事实。', location));
        continue;
      }
      for (const [factIndex, fact] of facts.entries()) {
        const allowed = layer === 'business' ? businessKinds : componentKinds;
        if (!allowed.has(fact.kind)) {
          blockers.push(blocker('UI_CASE_LAYER_COLLISION', `${fact.kind} 不属于 ${layer} Case。`, `${location}[${factIndex}]`));
        }
        if (!fact.sourceRef || ![...refs].includes(fact.sourceRef)) {
          blockers.push(blocker('UI_CASE_INVENTS_BUSINESS_FACT', '每个事实必须引用该用例已登记的来源。', `${location}[${factIndex}]`));
        }
        if (
          layer === 'business'
          && ['event', 'port', 'state'].includes(fact.kind)
          && !/^(?:uc|user):/.test(fact.sourceRef ?? '')
        ) {
          blockers.push(blocker(
            'UI_CASE_INVENTS_BUSINESS_FACT',
            `${fact.kind} 业务事实必须直接追溯 UC 或用户决定。`,
            `${location}[${factIndex}]`,
          ));
        }
      }
    }
  }
  if (!Array.isArray(model.gaps)) blockers.push(blocker('UI_CASE_CONTRACT_INVALID', 'gaps 必须为数组。'));
  if (JSON.stringify(model).match(/(?:domSelector|querySelector|runtimeOperation|setAttribute|setProperty)/i)) {
    blockers.push(blocker('UI_CASE_RUNTIME_DEP', '用例不得成为改写 DOM 或产品状态的运行模型。'));
  }
  return blockers;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const model = JSON.parse(await readFile(resolve(argument('input', 'Cases/ui-cases.json')), 'utf8'));
    const blockers = validateCases(model);
    console.log(JSON.stringify({ status: blockers.length ? 'BLOCKED' : 'PASS', blockers }));
    process.exitCode = blockers.length ? 1 : 0;
  } catch (error) {
    console.log(JSON.stringify({
      status: 'BLOCKED',
      blockers: [blocker('UI_CASE_CONTRACT_INVALID', error instanceof Error ? error.message : String(error))],
    }));
    process.exitCode = 1;
  }
}
