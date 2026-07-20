import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import {
  artifactCollectionMembers,
  artifactMemberPath,
  artifactPaths,
  joinRepositoryPath,
  readStructured,
  repositoryFile,
  stringifyStructured,
} from '../../../../../.psp/harness/scripts/lib/repository.mjs';

function text(value) {
  return value === null || value === undefined || value === ''
    ? '未提供（见显式 gaps）'
    : String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function list(values) {
  return values?.length ? values.map((value) => '- ' + text(value)).join('\n') : '- 暂无正式条目';
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
    .replaceAll('\\', '／')
    .replaceAll('"', '”')
    .replaceAll('<', '‹')
    .replaceAll('>', '›')
    .replaceAll('&', '和')
    .replaceAll('|', '｜')
    .replaceAll('[', '［')
    .replaceAll(']', '］')
    .replaceAll('`', '’')
    .replaceAll('{', '｛')
    .replaceAll('}', '｝')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .trim();
}

function mermaidNode(prefix, id) {
  return prefix + '_' + String(id).replaceAll(/[^A-Za-z0-9_]/g, '_');
}

function mermaidFlow(lines) {
  return ['```mermaid', 'flowchart TB', ...lines.map((line) => '    ' + line), '```'].join('\n');
}

function renderIntent(intent) {
  const name = intent.productName || '本产品';
  return [
    intent.businessGoal ? name + '旨在' + intent.businessGoal + '。' : name + '的目标尚待确认。',
    '',
    '- 产品构想：' + (intent.productConcept || '尚待确认'),
    '- 要解决的问题：' + (intent.problem || '尚待确认'),
    '- 成功信号：' + (intent.successSignal || '尚待确认'),
  ].join('\n');
}

function renderScope(scope) {
  const included = scope.included?.length ? scope.included : ['尚待确认'];
  const excluded = scope.excluded?.length ? scope.excluded : ['尚待确认'];
  if (included.length + excluded.length <= 4) {
    return [
      '- 范围内：' + included.join('、'),
      '- 范围外：' + excluded.join('、'),
    ].join('\n');
  }
  const lines = ['scope_root["产品范围"]', 'scope_root --> scope_included["范围内"]', 'scope_root --> scope_excluded["范围外"]'];
  included.forEach((item, index) => lines.push('scope_included --> scope_in_' + index + '["' + mermaidText(item) + '"]'));
  excluded.forEach((item, index) => lines.push('scope_excluded --> scope_out_' + index + '["' + mermaidText(item) + '"]'));
  return mermaidFlow(lines);
}

function renderActorUseCases(data) {
  if (data.actors.length + data.useCases.length <= 4) {
    const actorsById = new Map(data.actors.map((actor) => [actor.id, actor]));
    return data.useCases.length
      ? data.useCases.map((useCase) => '- ' + (actorsById.get(useCase.actor)?.name || useCase.actor) + ' → ' + useCase.name + '（' + useCase.id + '）').join('\n')
      : '尚待定义 Actor 与 Use Case。';
  }
  const lines = [];
  for (const actor of data.actors) {
    lines.push(mermaidNode('actor', actor.id) + '["' + mermaidText(actor.name + '：' + actor.goal) + '"]');
  }
  for (const useCase of data.useCases) {
    lines.push(mermaidNode('uc', useCase.id) + '["' + mermaidText(useCase.name) + '"]');
    lines.push(mermaidNode('actor', useCase.actor) + ' --> ' + mermaidNode('uc', useCase.id));
  }
  return lines.length ? mermaidFlow(lines) : '尚待定义 Actor 与 Use Case。';
}

function renderUseCaseFlow(useCase) {
  const trigger = mermaidNode('trigger', useCase.id);
  const success = mermaidNode('success', useCase.id);
  const lines = [trigger + '["触发：' + mermaidText(useCase.trigger) + '"]'];
  let previous = trigger;
  for (const step of useCase.mainScenario) {
    const stepNode = mermaidNode('step', step.id);
    const initiator = step.initiator === 'actor' ? '使用者' : '系统';
    lines.push(stepNode + '["' + mermaidText(initiator + '：' + step.action) + '<br/>' + mermaidText('结果：' + step.outcome) + '"]');
    lines.push(previous + ' --> ' + stepNode);
    previous = stepNode;
  }
  lines.push(success + '["成功完成"]');
  lines.push(previous + ' --> ' + success);

  for (const scenario of useCase.alternateScenarios) {
    const condition = mermaidNode('condition', scenario.id);
    lines.push(condition + '{"' + mermaidText(scenario.name + '：' + scenario.condition) + '"}');
    lines.push(mermaidNode('step', scenario.startsAt) + ' --> ' + condition);
    let branchPrevious = condition;
    for (const step of scenario.steps) {
      const stepNode = mermaidNode('branch_step', step.id);
      const initiator = step.initiator === 'actor' ? '使用者' : '系统';
      lines.push(stepNode + '["' + mermaidText(initiator + '：' + step.action) + '<br/>' + mermaidText('结果：' + step.outcome) + '"]');
      lines.push(branchPrevious + ' --> ' + stepNode);
      branchPrevious = stepNode;
    }
    const outcome = mermaidNode('branch_outcome', scenario.id);
    lines.push(outcome + '["' + mermaidText(scenario.outcome) + '"]');
    lines.push(branchPrevious + ' --> ' + outcome);
  }
  return mermaidFlow(lines);
}

function renderRelationships(useCases) {
  const useCasesById = new Map(useCases.map((useCase) => [useCase.id, useCase]));
  const relations = useCases.flatMap((useCase) => useCase.relationships.map((relation) => ({ useCase, relation })));
  if (relations.length === 0) return '当前用例之间没有声明关系。';
  const lines = [];
  for (const useCase of useCases) lines.push(mermaidNode('relation', useCase.id) + '["' + mermaidText(useCase.name) + '"]');
  const labels = { include: '包含', extend: '扩展', generalize: '泛化' };
  for (const { useCase, relation } of relations) {
    if (!useCasesById.has(relation.target)) continue;
    lines.push(mermaidNode('relation', useCase.id) + ' -->|' + labels[relation.type] + '| ' + mermaidNode('relation', relation.target));
  }
  return mermaidFlow(lines);
}

function renderCapabilities(data) {
  const useCasesById = new Map(data.useCases.map((useCase) => [useCase.id, useCase]));
  const actorsById = new Map(data.actors.map((actor) => [actor.id, actor]));
  const lines = [
    '# ' + (data.intent.productName || '产品') + '用例',
    '',
    '## 产品目标',
    '',
    renderIntent(data.intent),
    '',
    '## 产品范围',
    '',
    renderScope(data.productScope),
    '',
    '## 参与者与用例',
    '',
    renderActorUseCases(data),
    '',
  ];
  if (data.useCases.length >= 4) {
    lines.push(
      '## 用例索引',
      '',
      table(
        ['Use Case', '名称', '主要参与者'],
        data.useCases.map((useCase) => [useCase.id, useCase.name, actorsById.get(useCase.actor)?.name || useCase.actor]),
      ),
      '',
    );
  }
  lines.push(
    '## 业务规则',
    '',
    ...(data.businessRules.length
      ? data.businessRules.map((rule) => {
        const targets = rule.appliesTo.map((id) => useCasesById.get(id)?.name).filter(Boolean);
        return '- ' + rule.statement + (targets.length ? '（适用于：' + targets.join('、') + '）' : '');
      })
      : ['- 暂无业务规则']),
    '',
    '## 用例',
    '',
  );

  if (data.useCases.length === 0) lines.push('尚待定义稳定的产品行为。', '');
  for (const useCase of data.useCases) {
    lines.push(
      '### ' + useCase.id + '｜' + useCase.name,
      '',
      useCase.goal + '，从而' + useCase.value + '。',
      '',
      renderUseCaseFlow(useCase),
      '',
      '#### 前置条件',
      '',
      list(useCase.preconditions.length ? useCase.preconditions : ['无']),
      '',
      '#### 结果保证',
      '',
      '- 成功：' + useCase.successOutcome,
      '- 未成功时：' + useCase.minimumGuarantee,
      '',
    );
  }

  lines.push(
    '## 用例关系',
    '',
    renderRelationships(data.useCases),
    '',
    '## 待确认问题',
    '',
    ...((data.gaps || []).length ? data.gaps.map((gap) => '- ' + gap.reason) : ['- 无']),
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

function characterWidth(character) {
  const point = character.codePointAt(0);
  if (
    (point >= 0x0300 && point <= 0x036f)
    || (point >= 0x1dc0 && point <= 0x1dff)
    || (point >= 0xfe00 && point <= 0xfe0f)
    || (point >= 0xfe20 && point <= 0xfe2f)
  ) return 0;
  return (
    point >= 0x1100 && (
      point <= 0x115f
      || point === 0x2329
      || point === 0x232a
      || (point >= 0x2e80 && point <= 0xa4cf && point !== 0x303f)
      || (point >= 0xac00 && point <= 0xd7a3)
      || (point >= 0xf900 && point <= 0xfaff)
      || (point >= 0xfe10 && point <= 0xfe19)
      || (point >= 0xfe30 && point <= 0xfe6f)
      || (point >= 0xff00 && point <= 0xff60)
      || (point >= 0xffe0 && point <= 0xffe6)
      || (point >= 0x1f300 && point <= 0x1faff)
      || (point >= 0x20000 && point <= 0x3fffd)
    )
  ) ? 2 : 1;
}

function displayWidth(value) {
  return [...String(value ?? '')].reduce((width, character) => width + characterWidth(character), 0);
}

function padDisplay(value, width, alignment = 'left') {
  const normalized = String(value ?? '');
  const padding = Math.max(0, width - displayWidth(normalized));
  if (alignment === 'center') {
    const left = Math.floor(padding / 2);
    return ' '.repeat(left) + normalized + ' '.repeat(padding - left);
  }
  return normalized + ' '.repeat(padding);
}

function wrapDisplay(value, width) {
  const result = [];
  for (const sourceLine of String(value ?? '').split(/\r?\n/)) {
    if (sourceLine === '') {
      result.push('');
      continue;
    }
    let line = '';
    let lineWidth = 0;
    for (const character of sourceLine) {
      const nextWidth = characterWidth(character);
      if (line && lineWidth + nextWidth > width) {
        result.push(line);
        line = '';
        lineWidth = 0;
      }
      line += character;
      lineWidth += nextWidth;
    }
    result.push(line);
  }
  return result;
}

function controlWireframeText(control) {
  if (control.type === 'selection') return '( ) ' + control.label;
  if (control.type === 'input') return control.label + '：[____________]';
  if (control.type === 'action') return '[' + control.label + ']';
  if (control.type === 'navigation') return '[' + control.label + ' →]';
  return control.label;
}

function boxedBlock(title, body, width) {
  const safeWidth = Math.max(18, width);
  const innerWidth = safeWidth - 2;
  const contentWidth = safeWidth - 4;
  const border = '+' + '-'.repeat(innerWidth) + '+';
  const bodyLines = body.flatMap((item) => wrapDisplay(item, contentWidth));
  return [
    border,
    '|' + padDisplay(title, innerWidth, 'center') + '|',
    border,
    ...bodyLines.map((line) => '| ' + padDisplay(line, contentWidth) + ' |'),
    border,
  ];
}

function regionBlock(region, width) {
  if (!region) return boxedBlock('未解析区域', ['结构化模型引用了不存在的区域。'], width);
  const body = [
    ...region.content.map((item) => '· ' + item),
    ...region.controls.map(controlWireframeText),
  ];
  return boxedBlock(region.name, body, width);
}

function verticalLayoutBlocks(children, regions, width) {
  return children.flatMap((child, index) => [
    ...(index > 0 ? [' '.repeat(width)] : []),
    ...layoutBlock(child, regions, width),
  ]);
}

function horizontalLayoutBlocks(children, regions, width) {
  const gap = 2;
  const available = width - gap * (children.length - 1);
  const columnWidth = Math.floor(available / children.length);
  if (columnWidth < 24) return verticalLayoutBlocks(children, regions, width);
  const remainder = available - columnWidth * children.length;
  const widths = children.map((_, index) => columnWidth + (index < remainder ? 1 : 0));
  const columns = children.map((child, index) => layoutBlock(child, regions, widths[index]));
  const height = Math.max(...columns.map((column) => column.length));
  return Array.from({ length: height }, (_, row) => columns.map((column, index) => (
    column[row] || ' '.repeat(widths[index])
  )).join(' '.repeat(gap)));
}

function layoutBlock(node, regions, width) {
  if (node.type === 'region') return regionBlock(regions.get(node.region), width);
  if (node.type === 'horizontal') return horizontalLayoutBlocks(node.children, regions, width);
  return verticalLayoutBlocks(node.children, regions, width);
}

function textWireframe(screen) {
  const frameWidth = 90;
  const innerWidth = frameWidth - 2;
  const layoutWidth = innerWidth - 4;
  const regions = new Map(screen.regions.map((region) => [region.id, region]));
  const border = '+' + '-'.repeat(innerWidth) + '+';
  const layout = layoutBlock(screen.layoutTree, regions, layoutWidth);
  return [
    '```text',
    border,
    '|' + padDisplay(screen.name, innerWidth, 'center') + '|',
    border,
    ...layout.map((line) => '|  ' + padDisplay(line, layoutWidth) + '  |'),
    border,
    '```',
  ].join('\n');
}

function sitemapDiagram(siteMap, screensById) {
  const nodes = siteMap?.nodes || [];
  if (nodes.length === 0) return '- 尚未形成站点层级。';
  if (nodes.length === 1) {
    const only = nodes[0];
    return '- 单页站点：' + (screensById.get(only.screen)?.name || only.screen) + '（入口）';
  }
  const lines = ['```mermaid', 'flowchart TB'];
  for (const item of nodes) {
    const screen = screensById.get(item.screen);
    const label = mermaidText(screen?.name || item.screen) + (item.screen === siteMap.entryScreen ? '<br/>入口' : '');
    lines.push('    ' + mermaidNode('SM', item.screen) + '["' + label + '"]');
  }
  for (const item of nodes) {
    if (item.parent) lines.push('    ' + mermaidNode('SM', item.parent) + ' --> ' + mermaidNode('SM', item.screen));
  }
  lines.push('```');
  return lines.join('\n');
}

function userFlowDiagram(flow, screensById, statesById, controlsById) {
  const endpoints = [
    flow.entry,
    ...flow.steps.flatMap((step) => [step.from, step.to]),
    ...flow.completionStates.map((stateId) => ({
      state: stateId,
      screen: statesById.get(stateId)?.screen,
    })),
  ];
  const uniqueStates = new Map(endpoints.map((endpoint) => [endpoint.state, endpoint]));
  const stateNodeIds = new Map([...uniqueStates.keys()].map((stateId, index) => [stateId, 'state_' + (index + 1)]));
  const lines = ['```mermaid', 'flowchart LR'];
  let stateIndex = 0;
  for (const endpoint of uniqueStates.values()) {
    stateIndex += 1;
    const state = statesById.get(endpoint.state);
    const screen = screensById.get(endpoint.screen);
    const label = mermaidText(screen?.name || '未命名页面') + '<br/>' + mermaidText(state?.condition || '状态待确认');
    lines.push('    state_' + stateIndex + '["' + label + '"]');
  }

  lines.push('    entry(["入口"]) --> ' + stateNodeIds.get(flow.entry.state));

  const transitionGroups = new Map();
  for (const step of flow.steps) {
    const triggerKey = step.trigger.control || 'system:' + step.trigger.event;
    const key = step.from.state + '\u0000' + triggerKey;
    if (!transitionGroups.has(key)) transitionGroups.set(key, []);
    transitionGroups.get(key).push(step);
  }

  let decisionIndex = 0;
  for (const steps of transitionGroups.values()) {
    const first = steps[0];
    const fromNode = stateNodeIds.get(first.from.state);
    const control = controlsById.get(first.trigger.control);
    const requiresDecision = steps.length > 1 || steps.some((step) => step.guard);
    const transitionLabel = control?.label || (requiresDecision ? '系统返回结果' : '系统继续');

    if (requiresDecision) {
      decisionIndex += 1;
      const decisionNode = 'decision_' + decisionIndex;
      lines.push('    ' + decisionNode + '{"' + mermaidText(flow.name + '结果') + '"}');
      lines.push('    ' + fromNode + ' -->|"' + mermaidText(transitionLabel) + '"| ' + decisionNode);
      for (const step of steps) {
        lines.push(
          '    ' + decisionNode
          + ' -->|"' + mermaidText(step.branchLabel) + '"| '
          + stateNodeIds.get(step.to.state),
        );
      }
      continue;
    }

    const targetState = statesById.get(first.to.state);
    const directLabel = control?.label || systemResultLabel(targetState?.type);
    lines.push('    ' + fromNode + ' -->|"' + mermaidText(directLabel) + '"| ' + stateNodeIds.get(first.to.state));
  }

  flow.completionStates.forEach((stateId, index) => {
    const state = statesById.get(stateId);
    const terminalNode = 'terminal_' + (index + 1);
    lines.push('    ' + terminalNode + '(["' + mermaidText(terminalResultLabel(state?.type)) + '"])');
    lines.push('    ' + stateNodeIds.get(stateId) + ' --> ' + terminalNode);
  });
  lines.push('```');
  return lines.join('\n');
}

function branchResultLabel(stateType) {
  return ({
    success: '成功',
    error: '失败',
    validation: '待确认',
    loading: '处理中',
    empty: '无结果',
    disabled: '不可用',
    default: '继续',
  })[stateType] || '其他结果';
}

function systemResultLabel(stateType) {
  return '系统结果：' + branchResultLabel(stateType);
}

function terminalResultLabel(stateType) {
  return ({
    success: '成功结束',
    error: '失败结束',
    validation: '待确认结束',
  })[stateType] || '流程结束';
}

function useCaseReference(useCaseId, context) {
  const capabilities = context?.artifacts?.capabilities;
  const target = capabilities?.outputs?.find((output) => output.role === 'user-artifact')?.path;
  if (!target || !context?.output) return useCaseId;
  const relative = posix.relative(posix.dirname(context.output), target) || posix.basename(target);
  return '[' + useCaseId + '](' + relative + ')';
}

const STATE_TYPE_LABELS = {
  default: '默认',
  loading: '加载',
  empty: '空状态',
  error: '错误',
  success: '成功',
  validation: '校验',
  disabled: '禁用',
};

function stateReferenceLabel(reference, regionsById, controlsById) {
  const control = controlsById.get(reference);
  if (control) return '控件「' + control.label + '」';
  const region = regionsById.get(reference);
  if (region) return '区域「' + region.name + '」';
  return reference;
}

function stateSummary(state, regionsById, controlsById) {
  const delta = state.stateDelta;
  const changes = [];
  for (const [key, label] of [['show', '显示'], ['hide', '隐藏'], ['enable', '启用'], ['disable', '禁用']]) {
    if (delta[key].length > 0) {
      changes.push(label + '：' + delta[key].map((reference) => stateReferenceLabel(reference, regionsById, controlsById)).join('、'));
    }
  }
  for (const change of delta.content) {
    changes.push(stateReferenceLabel(change.target, regionsById, controlsById) + '显示“' + change.value + '”');
  }
  if (state.terminal) changes.push('此状态为流程终点');
  return '- **' + (STATE_TYPE_LABELS[state.type] || state.type) + '**｜' + state.condition + (changes.length ? '：' + changes.join('；') : '') + '。';
}

function renderInteractions(data, context) {
  const screensById = new Map(data.screens.map((screen) => [screen.id, screen]));
  const regionsById = new Map(data.screens.flatMap((screen) => (
    screen.regions.map((region) => [region.id, region])
  )));
  const statesById = new Map(data.interactionStates.map((state) => [state.id, state]));
  const controlsById = new Map(data.screens.flatMap((screen) => (
    screen.regions.flatMap((region) => region.controls.map((control) => [control.id, control]))
  )));
  const lines = [
    '# ' + (context?.actorName || data.metadata.actor) + '｜页面结构与交互蓝图',
    '',
  ];
  lines.push(
    '本文用于评审页面组织、用户路径和页面骨架。Use Case 引用作为跨文档导航保留；完整 ID、Guard、事件名、追踪引用、状态差量与布局树仍由同源 YAML 机器模型拥有。',
    '',
    '## 站点地图（Sitemap）',
    '',
    sitemapDiagram(data.siteMap, screensById),
    '',
    '## 用户流程图（User Flow）',
    '',
    '> 图例：矩形 State Node（状态节点）= 页面名称 + 当前状态；菱形 Decision Node（判断节点）= 业务结果或条件分叉；连线 = 用户操作或系统结果；分支标签 = 成功、失败、待确认等简短结果；圆角节点 = 入口或终止状态。',
    '',
  );
  if (data.wireflows.length === 0) lines.push('- 尚未形成用户流程。', '');
  for (const flow of data.wireflows) {
    lines.push(
      '### ' + flow.name,
      '',
      '对应 Use Case：' + useCaseReference(flow.useCase, context),
      '',
      userFlowDiagram(flow, screensById, statesById, controlsById),
      '',
    );
  }
  lines.push('## 线框图（Wireframe）', '');
  if (data.screens.length === 0) lines.push('- 尚未形成页面线框。', '');
  for (const screen of data.screens) {
    const screenStates = data.interactionStates.filter((state) => state.screen === screen.id);
    lines.push(
      '### ' + screen.name,
      '',
      screen.purpose,
      '',
      textWireframe(screen),
      '',
    );
    if (screenStates.length > 0) {
      lines.push(
        '#### 页面状态',
        '',
        ...screenStates.map((state) => stateSummary(state, regionsById, controlsById)),
        '',
      );
    }
  }
  lines.push(
    '## 待确认问题',
    '',
    ...((data.gaps || []).length ? data.gaps.map((gap) => '- ' + gap.reason) : ['- 无']),
    '',
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderWireflowIndex(members, context) {
  const actorNames = new Map((context?.capabilities?.actors || []).map((actor) => [actor.id, actor.name]));
  const rows = members.map((member) => {
    const target = context.memberOutput(member.actor);
    const relative = posix.relative(posix.dirname(context.output), target);
    return [member.actor, actorNames.get(member.actor) || member.actor, '[查看 Sitemap、User Flow 与 Wireframe](' + relative + ')'];
  });
  return [
    '# Wireflow 参与者索引',
    '',
    '本文件只负责导航。每个参与者目录中的 `wireflow-mid.yaml` 是机器权威模型；同目录 `wireflow-mid.md` 是确定性生成的人类评审视图。',
    '',
    table(['参与者 ID', '参与者', '评审文档'], rows),
    '',
  ].join('\n');
}

const RENDERERS = {
  'capabilities-markdown': renderCapabilities,
  'interactions-markdown': renderInteractions,
  'wireflow-index': renderWireflowIndex,
};

function outputsForArtifact(registry, paths, data, allArtifacts, project) {
  return paths.outputs.map((output) => {
    const projection = registry.projections?.find((item) => item.id === output.projection);
    const rendererId = projection?.renderer || registry.renderer;
    const renderer = RENDERERS[rendererId];
    if (registry.projections && !projection) throw new Error('未知 projection：' + registry.id + ' / ' + output.projection);
    if (!renderer) throw new Error('未知 renderer：' + rendererId);
    const target = output.path;
    return {
      artifact: registry.id,
      projection: output.projection,
      internalModel: paths.authorityPath,
      output: target,
      role: output.role,
      content: renderer(data, {
        internalModel: posix.relative(posix.dirname(target), paths.authorityPath),
        output: target,
        outputRole: output.role,
        artifacts: allArtifacts,
        project,
      }),
    };
  });
}

function outputsForArtifactSet(registry, paths, members, allArtifacts, project, capabilities = null) {
  const staticOutputs = paths.outputs.map((output) => {
    const projection = registry.projections?.find((item) => item.id === output.projection);
    const renderer = RENDERERS[projection?.renderer];
    if (!renderer) throw new Error('未知集合 renderer：' + registry.id + ' / ' + output.projection);
    const memberBinding = paths.memberOutputs.find((item) => item.projection === 'interactions-markdown') || paths.memberOutputs[0];
    return {
      artifact: registry.id,
      projection: output.projection,
      internalModel: paths.authorityRoot,
      output: output.path,
      role: output.role,
      content: renderer(members, {
        output: output.path,
        capabilities,
        memberOutput: (actor) => memberBinding.root + '/' + actor + '/' + memberBinding.member,
      }),
    };
  });
  const actorNames = new Map((capabilities?.actors || []).map((actor) => [actor.id, actor.name]));
  const memberOutputs = members.flatMap((member) => paths.memberOutputs.map((output) => {
    const projection = registry.projections?.find((item) => item.id === output.projection);
    const renderer = RENDERERS[projection?.renderer];
    if (!renderer) throw new Error('未知集合 renderer：' + registry.id + ' / ' + output.projection);
    const target = output.root + '/' + member.actor + '/' + output.member;
    const authority = artifactMemberPath(paths, member.actor);
    return {
      artifact: registry.id,
      projection: output.projection,
      internalModel: authority,
      output: target,
      role: output.role,
      content: renderer(member.data, {
        internalModel: posix.relative(posix.dirname(target), authority),
        output: target,
        outputRole: output.role,
        artifacts: allArtifacts,
        project,
        actorName: actorNames.get(member.actor),
      }),
    };
  }));
  return [...staticOutputs, ...memberOutputs];
}

export async function preparedArtifactOutputs(root, project, manifest, stageId, artifactId, data, members = []) {
  const registries = manifest.artifactRegistry.filter((registry) => registry.stage === stageId);
  const registry = registries.find((item) => item.id === artifactId);
  if (!registry || !['internal-model', 'internal-model-set'].includes(registry.authorityKind)) throw new Error('未知内部模型 artifact：' + artifactId);
  const allArtifacts = {};
  for (const item of registries) {
    const paths = artifactPaths(project, item.id, item.stage);
    if (paths) allArtifacts[item.id] = paths;
  }
  const paths = allArtifacts[artifactId];
  if (!paths) throw new Error('项目未绑定 artifact：' + artifactId);
  if (paths.authorityKind === 'internal-model-set') {
    const capabilityRegistry = registries.find((item) => item.id === 'capabilities');
    const capabilityPaths = allArtifacts.capabilities;
    const capabilities = capabilityRegistry && capabilityPaths
      ? await readStructured(root, capabilityPaths.authorityPath, capabilityRegistry.format)
      : null;
    return outputsForArtifactSet(registry, paths, members, allArtifacts, project, capabilities);
  }
  return outputsForArtifact(
    registry,
    paths,
    data,
    allArtifacts,
    project,
  );
}

export async function expectedOutputs(root, project, manifest, stageId, artifactIds = null) {
  const stageRegistries = stageId
    ? manifest.artifactRegistry.filter((registry) => registry.stage === stageId)
    : manifest.artifactRegistry;
  const selectedArtifacts = artifactIds ? new Set(artifactIds) : null;
  const registries = selectedArtifacts
    ? stageRegistries.filter((registry) => selectedArtifacts.has(registry.id))
    : stageRegistries;
  const allArtifacts = {};
  let capabilities = null;
  for (const registry of stageRegistries) {
    const paths = artifactPaths(project, registry.id, registry.stage);
    if (paths) allArtifacts[registry.id] = paths;
    if (registry.id === 'capabilities' && paths?.authorityKind === 'internal-model') {
      try { capabilities = await readStructured(root, paths.authorityPath, registry.format); } catch { /* schema validation reports missing authority */ }
    }
  }

  const outputs = [];
  for (const registry of registries) {
    if (!['internal-model', 'internal-model-set'].includes(registry.authorityKind)) continue;
    const paths = allArtifacts[registry.id];
    if (!paths) continue;
    if (paths.authorityKind === 'internal-model-set') {
      const memberPaths = await artifactCollectionMembers(root, paths);
      const members = [];
      for (const member of memberPaths) members.push({
        actor: member.actor,
        data: await readStructured(root, member.authorityPath, registry.format),
      });
      outputs.push(...outputsForArtifactSet(registry, paths, members, allArtifacts, project, capabilities));
      continue;
    }
    const data = await readStructured(root, paths.authorityPath, registry.format);
    outputs.push(...outputsForArtifact(
      registry,
      paths,
      data,
      allArtifacts,
      project,
    ));
  }
  return outputs;
}

export async function outputDrift(root, project, manifest, stageId, artifactIds = null) {
  const results = [];
  for (const output of await expectedOutputs(root, project, manifest, stageId, artifactIds)) {
    let actual = null;
    try {
      actual = await readFile(repositoryFile(root, output.output), 'utf8');
    } catch {
      // Missing outputs are reported as drift.
    }
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
