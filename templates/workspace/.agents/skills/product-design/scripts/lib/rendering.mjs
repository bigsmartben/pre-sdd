import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  artifactPaths,
  readStructured,
  repositoryFile,
} from '../../../../../.psp/harness/scripts/lib/repository.mjs';

function text(value) {
  return value === null || value === undefined || value === ''
    ? '—'
    : String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function list(values, fallback = '暂无正式条目') {
  return values?.length ? values.map((value) => '- ' + text(value)).join('\n') : '- ' + fallback;
}

function table(headers, rows) {
  const normalized = rows.length > 0 ? rows : [headers.map(() => '—')];
  return [
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...normalized.map((row) => '| ' + row.map(text).join(' | ') + ' |'),
  ].join('\n');
}

function mermaidText(value) {
  return String(value ?? '')
    .replaceAll('\\', '／').replaceAll('"', '”').replaceAll('<', '‹').replaceAll('>', '›')
    .replaceAll('&', '和').replaceAll('|', '｜').replaceAll('[', '［').replaceAll(']', '］')
    .replaceAll('`', '’').replaceAll('{', '｛').replaceAll('}', '｝').replaceAll(/\r?\n/g, ' ').trim();
}

function mermaidNode(prefix, id) {
  return prefix + '_' + String(id).replaceAll(/[^A-Za-z0-9_]/g, '_');
}

function mermaidFlow(lines) {
  return ['```mermaid', 'flowchart TB', ...lines.map((line) => '    ' + line), '```'].join('\n');
}

function renderUseCaseBehavior(useCase) {
  const lines = [];
  for (const step of useCase.mainScenario) {
    lines.push([step.id, '主场景', step.initiator === 'actor' ? 'Actor' : 'System', step.action, step.outcome]);
  }
  for (const scenario of useCase.alternateScenarios) for (const step of scenario.steps) {
    lines.push([step.id, scenario.id + '｜' + scenario.name, step.initiator === 'actor' ? 'Actor' : 'System', step.action, step.outcome]);
  }
  return table(['步骤', '场景', '发起者', '动作', '可观察结果'], lines);
}

function renderInteractionFlow(flow, statesById) {
  const graph = [];
  const referenced = new Set([flow.entryState, ...flow.completionStates]);
  for (const transition of flow.transitions) {
    referenced.add(transition.from);
    referenced.add(transition.to);
  }
  for (const stateId of referenced) {
    const state = statesById.get(stateId);
    graph.push(mermaidNode('state', stateId) + '["' + mermaidText((state?.name || stateId) + (state?.terminal ? '（终态）' : '')) + '"]');
  }
  for (const transition of flow.transitions) {
    const label = [transition.userAction, transition.systemResponse].filter(Boolean).join(' → ');
    graph.push(mermaidNode('state', transition.from) + ' -->|"' + mermaidText(label) + '"| ' + mermaidNode('state', transition.to));
  }
  const transitionRows = flow.transitions.map((transition) => [
    transition.id,
    transition.scenarioRef,
    transition.useCaseStepRefs.join('、'),
    transition.from + ' → ' + transition.to,
    transition.userAction || '系统事件',
    transition.systemResponse,
    transition.guard || '无',
    transition.branchLabel || '无',
  ]);
  const failureRows = flow.transitions
    .filter((transition) => transition.failureResponse)
    .map((transition) => [
      transition.id,
      transition.failureResponse.failure,
      transition.failureResponse.retry || '不可重试',
      transition.failureResponse.recovery || '无恢复动作',
      transition.failureResponse.returnToState || '不返回',
    ]);
  return [
    mermaidFlow(graph),
    '',
    table(['迁移', '场景', 'UC 步骤', '状态变化', '用户动作', '系统响应', 'Guard', '分支'], transitionRows),
    '',
    '失败、重试、恢复与返回：',
    '',
    table(['迁移', '失败', '重试', '恢复', '返回状态'], failureRows),
  ].join('\n');
}

function layoutSummary(node) {
  if (!node) return '—';
  if (node.type === 'region') return node.region;
  return node.type + '(' + (node.children || []).map(layoutSummary).join('，') + ')';
}

function renderBlueprint(blueprint, actorsById) {
  const iaLines = [];
  const screensById = new Map(blueprint.screens.map((screen) => [screen.id, screen]));
  for (const node of blueprint.informationArchitecture.nodes) {
    const id = mermaidNode('screen', node.screen);
    iaLines.push(id + '["' + mermaidText(screensById.get(node.screen)?.name || node.screen) + '"]');
    if (node.parent) iaLines.push(mermaidNode('screen', node.parent) + ' --> ' + id);
  }
  const screenRows = blueprint.screens.map((screen) => [
    screen.id,
    screen.name,
    screen.purpose,
    screen.useCases.join('、'),
    layoutSummary(screen.layoutTree),
  ]);
  const regionRows = blueprint.screens.flatMap((screen) => screen.regions.map((region) => [
    screen.id,
    region.id,
    region.name,
    region.purpose,
    region.content.join('、'),
    region.controls.map((control) => control.id + ' ' + control.label + '（' + control.type + '）').join('、') || '无',
  ]));
  return [
    '### ' + blueprint.id + '｜' + (actorsById.get(blueprint.actor)?.name || blueprint.actor),
    '',
    '> 本蓝图是内部低保真建议；UI HTML 可重组页面与控件，但必须保持正式 Interaction Flow 的行为语义与追溯关系。',
    '',
    '- 覆盖 Use Case：' + blueprint.useCases.join('、'),
    '- 建议入口：' + blueprint.informationArchitecture.entryScreen,
    '',
    '#### 信息架构（IA）',
    '',
    mermaidFlow(iaLines),
    '',
    '#### Screen 与 Layout 建议',
    '',
    table(['Screen', '名称', '目的', 'Use Case', 'Layout'], screenRows),
    '',
    '#### Region 与 Control 建议',
    '',
    table(['Screen', 'Region', '名称', '目的', '内容', 'Controls'], regionRows),
    '',
    '#### 正式状态到低保真呈现',
    '',
    table(['Interaction State', '建议 Screen', '呈现建议'], blueprint.statePresentations.map((item) => [item.interactionState, item.screen, item.suggestion])),
  ].join('\n');
}

function renderCapabilities(data) {
  const actorsById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const statesById = new Map(data.interactionStates.map((state) => [state.id, state]));
  const flowsByUseCase = new Map(data.interactionFlows.map((flow) => [flow.useCase, flow]));
  const lines = [
    '# ' + (data.intent.productName || '产品') + ' Use Cases',
    '',
    '> 单一权威模型：Product Behavior（产品行为）+ Interaction Flow（正式交互流程）+ Low-Fi UI Blueprint（内部低保真建议）。',
    '',
    '## 产品目标',
    '',
    '- 产品构想：' + text(data.intent.productConcept),
    '- 要解决的问题：' + text(data.intent.problem),
    '- 业务目标：' + text(data.intent.businessGoal),
    '- 成功信号：' + text(data.intent.successSignal),
    '',
    '## 产品范围',
    '',
    '### 范围内',
    '',
    list(data.productScope.included),
    '',
    '### 范围外',
    '',
    list(data.productScope.excluded),
    '',
    '## Actor 与业务规则',
    '',
    table(['Actor', '名称', '目标'], data.actors.map((actor) => [actor.id, actor.name, actor.goal])),
    '',
    table(['规则', '声明', '适用 Use Case'], data.businessRules.map((rule) => [rule.id, rule.statement, rule.appliesTo.join('、')])),
    '',
    '## Use Cases',
    '',
  ];
  if (data.useCases.length === 0) lines.push('尚待定义稳定的产品行为。', '');
  for (const useCase of data.useCases) {
    const flow = flowsByUseCase.get(useCase.id);
    lines.push(
      '### ' + useCase.id + '｜' + useCase.name,
      '',
      '- Actor：' + (actorsById.get(useCase.actor)?.name || useCase.actor),
      '- 目标与价值：' + useCase.goal + '，从而' + useCase.value,
      '- 触发：' + useCase.trigger,
      '- UI：' + (useCase.uiApplicability.mode === 'required' ? '需要 UI' : '不适用（' + useCase.uiApplicability.reason + '）'),
      '- 前置条件：' + (useCase.preconditions.join('、') || '无'),
      '- 成功保证：' + useCase.successOutcome,
      '- 最小保证：' + useCase.minimumGuarantee,
      '',
      '#### Product Behavior（产品行为）',
      '',
      renderUseCaseBehavior(useCase),
      '',
      '#### Interaction Flow（正式交互流程）',
      '',
      flow ? renderInteractionFlow(flow, statesById) : '非 UI 用例：无 Interaction Flow。',
      '',
    );
  }
  lines.push('## Low-Fi UI Blueprints', '');
  if (data.lowFiUiBlueprints.length === 0) lines.push('- 当前没有 UI 用例，因此无需 Low-Fi UI Blueprint。', '');
  for (const blueprint of data.lowFiUiBlueprints) lines.push(renderBlueprint(blueprint, actorsById), '');
  lines.push(
    '## 待确认问题',
    '',
    ...((data.gaps || []).length ? data.gaps.map((gap) => '- ' + gap.field + '：' + gap.reason) : ['- 无']),
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

const RENDERERS = { 'capabilities-markdown': renderCapabilities };

function outputsForArtifact(registry, paths, data) {
  return paths.outputs.map((output) => {
    const projection = registry.projections?.find((item) => item.id === output.projection);
    const renderer = RENDERERS[projection?.renderer || registry.renderer];
    if (!renderer) throw new Error('未知 renderer：' + registry.id + ' / ' + output.projection);
    return {
      artifact: registry.id,
      projection: output.projection,
      internalModel: paths.authorityPath,
      output: output.path,
      role: output.role,
      content: renderer(data),
    };
  });
}

export async function preparedArtifactOutputs(root, project, manifest, stageId, artifactId, data) {
  const registry = manifest.artifactRegistry.find((item) => item.id === artifactId && item.stage === stageId);
  if (!registry || registry.authorityKind !== 'internal-model') throw new Error('未知内部模型 artifact：' + artifactId);
  const paths = artifactPaths(project, artifactId, stageId);
  if (!paths) throw new Error('项目未绑定 artifact：' + artifactId);
  return outputsForArtifact(registry, paths, data);
}

export async function expectedOutputs(root, project, manifest, stageId, artifactIds = null) {
  const selected = artifactIds ? new Set(artifactIds) : null;
  const outputs = [];
  for (const registry of manifest.artifactRegistry.filter((item) => item.stage === stageId && item.authorityKind === 'internal-model')) {
    if (selected && !selected.has(registry.id)) continue;
    const paths = artifactPaths(project, registry.id, stageId);
    if (!paths) continue;
    const data = await readStructured(root, paths.authorityPath, registry.format);
    outputs.push(...outputsForArtifact(registry, paths, data));
  }
  return outputs;
}

export async function outputDrift(root, project, manifest, stageId, artifactIds = null) {
  const results = [];
  for (const output of await expectedOutputs(root, project, manifest, stageId, artifactIds)) {
    let actual = null;
    try { actual = await readFile(repositoryFile(root, output.output), 'utf8'); } catch { /* missing output is drift */ }
    if (actual !== output.content) results.push(output);
  }
  return results;
}

export async function writeExpectedOutputs(root, project, manifest, stageId) {
  const outputs = await expectedOutputs(root, project, manifest, stageId);
  for (const output of outputs) {
    const absolute = repositoryFile(root, output.output);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, output.content, 'utf8');
  }
  return outputs;
}
