import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  artifactDefinition,
  artifactDefinitions,
  artifactPaths,
  readStructured,
  repositoryFile,
} from '../../../../runtime/project.mjs';

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
  const shortId = (id) => id.replace(/^UC-\d{3}-/, '');
  const stepTable = (steps) => table(['步骤', '发起者', '动作', '可观察结果'], steps.map((step) => [
    shortId(step.id), step.initiator === 'actor' ? 'Actor' : 'System', step.action, step.outcome,
  ]));
  const lines = ['##### 主场景', '', stepTable(useCase.mainScenario)];
  for (const scenario of useCase.alternateScenarios) {
    lines.push(
      '',
      '##### ' + scenario.id + '｜' + scenario.name,
      '',
      '- 起始步骤：' + shortId(scenario.startsAt),
      '- 条件：' + scenario.condition,
      '- 结果：' + scenario.outcome,
      '',
      stepTable(scenario.steps),
    );
  }
  return lines.join('\n');
}

function useCaseSteps(useCase) {
  return new Map([
    ...useCase.mainScenario.map((step) => [step.id, step]),
    ...useCase.alternateScenarios.flatMap((scenario) => scenario.steps.map((step) => [step.id, step])),
  ]);
}

function transitionBehavior(transition, useCase) {
  const stepsById = useCaseSteps(useCase);
  const steps = transition.useCaseStepRefs.map((stepId) => stepsById.get(stepId)).filter(Boolean);
  return {
    action: steps.filter((step) => step.initiator === 'actor').map((step) => step.action).join('；') || '系统事件',
    response: steps.map((step) => step.outcome).join('；') || '—',
  };
}

function renderInteractionFlow(flow, useCase, statesById) {
  const graph = [];
  const alternateScenariosById = new Map(useCase.alternateScenarios.map((scenario) => [scenario.id, scenario]));
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
    const behavior = transitionBehavior(transition, useCase);
    const label = behavior.action + ' → ' + behavior.response;
    graph.push(mermaidNode('state', transition.from) + ' -->|"' + mermaidText(label) + '"| ' + mermaidNode('state', transition.to));
  }
  const transitionRows = flow.transitions.map((transition) => {
    const scenario = alternateScenariosById.get(transition.scenarioRef);
    const scenarioSummary = transition.scenarioRef === 'main'
      ? '主场景'
      : scenario
        ? scenario.name + '；' + scenario.condition
        : transition.scenarioRef;
    return [
      transition.id, scenarioSummary, transition.useCaseStepRefs.join('、'),
      transition.guard || '无', transition.branchLabel || '无',
      transition.failureResponse?.retry || '—',
      transition.failureResponse?.recovery || '—',
      transition.failureResponse?.returnToState || '—',
    ];
  });
  return [
    '- Flow：' + flow.id + '｜' + flow.name,
    '- 入口状态：' + flow.entryState,
    '- 完成状态：' + flow.completionStates.join('、'),
    '- 覆盖场景（由 Transition 推导）：' + [...new Set(flow.transitions.map((transition) => transition.scenarioRef))].join('、'),
    '',
    '##### Interaction States（交互状态）',
    '',
    table(['状态', '名称', '类型', '描述', '终态'], [...referenced].map((stateId) => {
      const state = statesById.get(stateId);
      return [stateId, state?.name, state?.type, state?.description || '—', state?.terminal ? '是' : '否'];
    })),
    '',
    '##### Flow 图',
    '',
    mermaidFlow(graph),
    '',
    table(['迁移', '场景', 'UC 步骤', 'Guard', '分支', '重试', '恢复', '返回状态'], transitionRows),
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
    region.purpose + '（' + region.content.join('、') + '）',
  ]));
  const controlRows = blueprint.screens.flatMap((screen) => screen.regions.flatMap((region) => region.controls.map((control) => [
    screen.id,
    region.id,
    control.id,
    control.type,
    control.label + (control.action && control.action !== control.label ? '：' + control.action : ''),
    control.purpose,
    control.transitionRefs.join('、') || '无',
  ])));
  const coveredUseCases = [...new Set(blueprint.screens.flatMap((screen) => screen.useCases))];
  return [
    '### ' + blueprint.id + '｜' + (actorsById.get(blueprint.actor)?.name || blueprint.actor),
    '',
    '- 覆盖 Use Case（由 Screen 推导）：' + coveredUseCases.join('、'),
    '- 建议入口：' + blueprint.informationArchitecture.entryScreen + (iaLines.length <= 1 ? '（单页面架构）' : ''),
    '',
    ...(iaLines.length > 1
      ? ['#### 信息架构（IA）', '', mermaidFlow(iaLines), '']
      : []
    ),
    '#### Screen 与 Layout 建议',
    '',
    table(['Screen', '名称', '目的', 'Use Case', 'Layout'], screenRows),
    '',
    '#### Region 建议',
    '',
    table(['Screen', 'Region', '名称', '说明'], regionRows),
    '',
    '#### Control 与正式 Transition 追溯',
    '',
    table(['Screen', 'Region', 'Control', '类型', '交互', '目的', 'Transition refs'], controlRows),
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
    '- 状态：' + data.metadata.status,
    '- 版本：' + data.metadata.version,
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
    table(['规则', '声明'], data.businessRules.map((rule) => [
      rule.id, rule.statement,
    ])),
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
      '- 适用业务规则：' + (useCase.businessRules.join('、') || '无'),
      ...(useCase.relationships.length > 0
        ? ['- Use Case 关系：' + useCase.relationships.map((relationship) => relationship.type + ' → ' + relationship.target).join('；')]
        : []),
      '',
      '#### Product Behavior（产品行为）',
      '',
      renderUseCaseBehavior(useCase),
      '',
      ...(flow
        ? ['#### Interaction Flow（正式交互流程）', '', renderInteractionFlow(flow, useCase, statesById), '']
        : useCase.uiApplicability.mode === 'required'
          ? ['#### Interaction Flow（正式交互流程）', '', '待补充正式 Interaction Flow。', '']
          : []
      ),
    );
  }
  lines.push('## Low-Fi UI Blueprints', '');
  if (data.lowFiUiBlueprints.length === 0) {
    if (data.useCases.length === 0) lines.push('- 尚未判断 UI 适用性。', '');
    else if (data.useCases.some((useCase) => useCase.uiApplicability.mode === 'required')) lines.push('- 待补充 UI Use Case 对应的 Low-Fi UI Blueprint。', '');
    else lines.push('- 所有 Use Case 均已明确为非 UI，因此无需 Low-Fi UI Blueprint。', '');
  } else {
    lines.push('> 本蓝图是内部低保真建议；UI HTML 可重组页面与控件，但必须保持正式 Interaction Flow 的行为语义与追溯关系。', '');
  }
  for (const blueprint of data.lowFiUiBlueprints) lines.push(renderBlueprint(blueprint, actorsById), '');
  if ((data.gaps || []).length > 0) {
    lines.push(
      '## 待确认问题',
      '',
      ...data.gaps.map((gap) => '- ' + gap.field + '：' + gap.reason),
      '',
    );
  }
  return lines.join('\n').trimEnd() + '\n';
}

function dimensionText(value) {
  return value?.mode === 'fixed' ? value.valuePx + 'px' : value?.mode || '—';
}

function renderVisualStyle(style) {
  if (!style) return '—';
  return [
    dimensionText(style.width) + ' × ' + dimensionText(style.height),
    'layout=' + (style.layoutRef || 'none'),
    'type=' + (style.typographyRef || 'none'),
    'fill=' + (style.fillPaintRef || 'none'),
    'text=' + (style.textPaintRef || 'none'),
    'border=' + style.border.widthPx + 'px ' + style.border.style + ' ' + (style.border.paintRef || 'none') + ' r' + style.border.radiusPx,
    'effects=' + (style.effectRefs.join('、') || 'none'),
    'opacity=' + style.opacity,
  ].join('；');
}

function renderVisualSpec(data) {
  const lines = [
    '# Visual Spec',
    '',
    '> Provider-neutral Visual Spec Intake（提供方中立视觉规格输入）。业务行为与正式状态来自 Use Cases；本文只定义确定渲染，不反向修改产品事实。',
    '',
    '## Runtime（运行环境）',
    '',
    table(['平台', '渲染器', '颜色方案', '语言环境', '根字号'], [[
      data.runtime.platform, data.runtime.renderer, data.runtime.colorScheme, data.runtime.locale, data.runtime.rootFontSizePx + 'px',
    ]]),
    '',
    '## Viewports（视口）',
    '',
    table(['ID', '名称', '宽', '高', 'DPR'], data.viewports.map((item) => [item.id, item.name, item.widthPx, item.heightPx, item.deviceScaleFactor])),
    '',
    '## Sources（来源）',
    '',
    table(['ID', '类型', '定位', '版本', '内容哈希'], data.sources.map((item) => [item.id, item.kind, item.locator, item.version, item.contentHash])),
    '',
    '## Foundations（视觉基础）',
    '',
    '### Spacing（间距）',
    '',
    table(['Token', '像素值'], data.foundations.spacing.map((item) => [item.id, item.valuePx])),
    '',
    '### Typography（排版）',
    '',
    table(['Token', '字体族', '字号', '字重', '行高', '字距', '转换'], data.foundations.typography.map((item) => [item.id, item.fontFamilies.join('、'), item.fontSizePx, item.fontWeight, item.lineHeightPx, item.letterSpacingPx, item.textTransform])),
    '',
    '### Paints 与 Effects（颜色与效果）',
    '',
    table(['Paint', '类型', '值', '不透明度'], data.foundations.paints.map((item) => [item.id, item.kind, item.value, item.opacity])),
    '',
    table(['Effect', '类型', '偏移', 'Blur', 'Spread', 'Paint'], data.foundations.effects.map((item) => [item.id, item.kind, item.offsetXPx + ',' + item.offsetYPx, item.blurPx, item.spreadPx, item.paintRef || 'none'])),
    '',
    '## Layouts（布局）',
    '',
    table(['ID', '名称', '方向', '尺寸', '间距', '内边距', '对齐', '溢出', 'Children'], data.layouts.map((item) => [
      item.id, item.name, item.direction, dimensionText(item.width) + ' × ' + dimensionText(item.height), item.gapRef,
      [item.padding.top, item.padding.right, item.padding.bottom, item.padding.left].join(' / '),
      item.alignItems + ' / ' + item.justifyContent, item.overflow,
      item.children.map((child) => child.order + ':' + child.componentRef).join('、') || '无',
    ])),
    '',
    '## Pages 与 Renderings（页面与确定渲染）',
    '',
    table(['Page', '名称', 'Route', 'Use Cases'], data.pages.map((item) => [item.id, item.name, item.route, item.useCaseRefs.join('、')])),
    '',
    table(['Rendering', 'Page', 'Viewport', 'Interaction States', 'Layout', 'Components', '背景'], data.renderings.map((item) => [
      item.id, item.pageRef, item.viewportRef, item.interactionStateRefs.join('、'), item.layoutRef, item.componentRefs.join('、'), item.backgroundPaintRef,
    ])),
    '',
    '## Components（组件状态与 Variant）',
    '',
  ];
  for (const component of data.components) {
    lines.push(
      '### ' + component.id + '｜' + component.name,
      '',
      '- Role：' + component.role,
      '- Use Cases：' + component.useCaseRefs.join('、'),
      '- Interaction States：' + component.interactionStateRefs.join('、'),
      '- Variant Axes：' + (component.variantAxes.map((axis) => axis.name + '=' + axis.values.join('/')).join('；') || '无'),
      '',
      table(['Visual Case', '状态', 'Variants', '完整视觉'], component.visualCases.map((item) => [
        item.id + '｜' + item.name,
        item.interactionStateRef,
        item.variants.map((variant) => variant.name + '=' + variant.value).join('、') || '无',
        renderVisualStyle(item.visual),
      ])),
      '',
    );
  }
  lines.push(
    '## Assets（资源）',
    '',
    table(['ID', '文件', '来源', 'Role', '内容哈希', '使用位置'], data.assets.map((item) => [
      item.id, item.file, item.sourceRef, item.role, item.contentHash,
      item.usage.map((usage) => [usage.renderingRef, usage.componentRef, usage.visualCaseRef].filter(Boolean).join('/')).join('、'),
    ])),
    '',
    '## 待确认问题',
    '',
    ...((data.gaps || []).length ? data.gaps.map((gap) => '- ' + gap.field + '：' + gap.reason) : ['- 无']),
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

const RENDERERS = {
  'capabilities-markdown': renderCapabilities,
  'visual-spec-markdown': renderVisualSpec,
};

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

export async function preparedArtifactOutputs(root, project, stageId, artifactId, data) {
  const registry = artifactDefinition(project, artifactId, stageId);
  if (!registry || registry.authorityKind !== 'internal-model') throw new Error('未知内部模型 artifact：' + artifactId);
  const paths = artifactPaths(project, artifactId, stageId);
  if (!paths) throw new Error('项目未绑定 artifact：' + artifactId);
  return outputsForArtifact(registry, paths, data);
}

export async function expectedOutputs(root, project, stageId, artifactIds = null) {
  const selected = artifactIds ? new Set(artifactIds) : null;
  const outputs = [];
  for (const registry of artifactDefinitions(project, stageId).filter((item) => item.authorityKind === 'internal-model')) {
    if (selected && !selected.has(registry.id)) continue;
    const paths = artifactPaths(project, registry.id, stageId);
    if (!paths) continue;
    const data = await readStructured(root, paths.authorityPath, registry.format);
    outputs.push(...outputsForArtifact(registry, paths, data));
  }
  return outputs;
}

export async function outputDrift(root, project, stageId, artifactIds = null) {
  const results = [];
  for (const output of await expectedOutputs(root, project, stageId, artifactIds)) {
    let actual = null;
    try { actual = await readFile(repositoryFile(root, output.output), 'utf8'); } catch { /* missing output is drift */ }
    if (actual !== output.content) results.push(output);
  }
  return results;
}

export async function writeExpectedOutputs(root, project, stageId) {
  const outputs = await expectedOutputs(root, project, stageId);
  for (const output of outputs) {
    const absolute = repositoryFile(root, output.output);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, output.content, 'utf8');
  }
  return outputs;
}
