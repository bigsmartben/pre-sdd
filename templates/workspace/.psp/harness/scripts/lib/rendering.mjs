import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import {
  artifactPaths,
  joinRepositoryPath,
  readStructured,
  repositoryFile,
} from './repository.mjs';

const LABELS = {
  capabilities: 'UC Specification',
  interactions: 'Wireflow Mid-Fidelity Specification',
  'ui-spec': 'HTML Mock Specification',
  'component-catalog': 'HTML Mock Component Catalog（支撑）',
  traceability: 'UC → Wireflow → HTML Mock Traceability（支撑）',
  'system-boundary': '系统边界',
  'conceptual-model': '概念建模',
  'technical-validation': '技术验证',
};

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

function header(title, data, internalModel) {
  return [
    '<!-- OFFICIAL USER ARTIFACT. GENERATED FROM INTERNAL MODEL; DO NOT EDIT DIRECTLY. Internal model: ' + internalModel + ' -->',
    '---',
    'generated: true',
    'artifactRole: user-artifact',
    'internalModel: ' + internalModel,
    'status: ' + (data.metadata?.status || 'not-applicable'),
    'version: ' + (data.metadata?.version || data.version),
    '---',
    '',
    '# ' + title,
    '',
  ];
}

function gates(data) {
  return [
    '## Gates',
    '',
    ...(data.gates || []).map((gate) => '- [' + (gate.checked ? 'x' : ' ') + '] ' + gate.label + ' (' + gate.id + ')'),
    '',
  ];
}

function gaps(data) {
  return [
    '## Explicit Gaps',
    '',
    ...((data.gaps || []).length
      ? data.gaps.map((gap) => '- ' + gap.id + ' · ' + gap.field + '：' + gap.reason)
      : ['- 无']),
    '',
  ];
}

function relativeLink(from, to) {
  const value = posix.relative(posix.dirname(from), to);
  return value.startsWith('.') ? value : './' + value;
}

function renderProductPackage(data, context) {
  const lines = header('Product Specification Package', data, context.internalModel);
  lines.push(
    '本文件是产品设计 Package 的正式用户产物；内部 YAML/JSON 模型只服务于生成和机器校验，不属于用户交付物。',
    '',
    '## Product Overview',
    '',
    '- 产品名称：' + text(data.overview.productName),
    '- 产品目标：' + text(data.overview.productGoal),
    '- 目标用户：' + text(data.overview.targetUsers),
    '- 核心价值：' + text(data.overview.coreValue),
    '- 当前版本：' + data.metadata.version,
    '',
    '## Primary Delivery Chain',
    '',
  );
  for (const artifactId of data.primaryChain) {
    const artifact = context.artifacts[artifactId];
    const target = artifact?.outputs?.find((output) => output.role === 'user-artifact')?.path;
    lines.push('- [' + LABELS[artifactId] + '](' + relativeLink(context.output, target) + ')');
  }
  lines.push(
    '',
    '## Supporting Artifacts',
    '',
  );
  for (const artifactId of data.supportingArtifacts) {
    const artifact = context.artifacts[artifactId];
    const target = artifact?.outputs?.find((output) => output.role === 'user-artifact')?.path;
    lines.push(target
      ? '- [' + LABELS[artifactId] + '](' + relativeLink(context.output, target) + ')'
      : '- ' + LABELS[artifactId] + '（机器生成支撑，不作为用户产物）');
  }
  lines.push(
    '',
    '## Reading Protocol',
    '',
    '1. 从本文件确认 Package 状态、三段主链和支撑产物。',
    '2. 主链按 UC → Wireflow Mid → HTML Mock 顺序消费，后一步不得反向改写前一步事实。',
    '3. Component Catalog 与 Traceability 只支撑 HTML Mock 实现和机器校验，不拥有新场景。',
    '4. 遇到 gap 或冲突时停止下游推导，并反馈对应上游用户产物。',
    '',
    '## Abstraction Boundary',
    '',
    '- UC Specification 定义产品行为事实，不定义 Screen 或实现。',
    '- Wireflow Mid 定义 Screen、内容层级、Control、状态和分支流转，不定义代码组件。',
    '- HTML Mock Specification 将 Wireflow 转成可运行、可操作、可审阅的体验证据。',
    '- 本 Package 不拥有软件架构和生产实现事实。',
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderCapabilities(data, context) {
  const lines = header('Use Case Specification', data, context.internalModel);
  lines.push(
    '本产物记录产品行为事实：Actor 为什么触发系统、系统承担什么责任、成功与失败后可观察到什么。它不定义 Screen、Control、组件或实现技术。',
    '',
    '## 产品意图',
    '',
    '- 产品概念：' + text(data.intent.productConcept),
    '- 待解决问题：' + text(data.intent.problem),
    '- 业务目标：' + text(data.intent.businessGoal),
    '- 成功信号：' + text(data.intent.successSignal),
    '',
    '## Actor',
    '',
    table(
      ['Actor ID', '名称', '目标', '说明'],
      data.actors.map((item) => [item.id, item.name, item.goal, item.description]),
    ),
    '',
    '## 产品范围',
    '',
    '此处只声明产品能力范围，不替代阶段 2 的系统/子系统边界设计。',
    '',
    '### 范围内',
    '',
    list(data.productScope.included),
    '',
    '### 范围外',
    '',
    list(data.productScope.excluded),
    '',
    '## 业务规则',
    '',
    table(
      ['Rule ID', '规则', '理由', '适用 Use Cases'],
      data.businessRules.map((item) => [item.id, item.statement, item.rationale, item.appliesTo.join(', ')]),
    ),
    '',
  );
  if (data.useCases.length === 0) lines.push('## Use Cases', '', '- 暂无正式条目', '');
  else lines.push('## Use Cases', '');
  for (const useCase of data.useCases) {
    lines.push(
      '### ' + useCase.id + '：' + useCase.name,
      '',
      '- Actor：' + useCase.actor,
      '- Actor Goal：' + useCase.goal,
      '- 用户价值：' + useCase.value,
      '- 触发条件：' + useCase.trigger,
      '- 前置条件：' + (useCase.preconditions.join('；') || '无'),
      '- 成功后置条件：' + useCase.postconditions.success.join('；'),
      '- 失败最小保证：' + (useCase.postconditions.failure.join('；') || '无'),
      '- 适用业务规则：' + (useCase.businessRules.join(', ') || '无'),
      '- Use Case 关系：' + (useCase.relationships.length
        ? useCase.relationships.map((relation) => relation.type + ' → ' + relation.target).join(', ')
        : '无'),
      '',
      '#### 主成功场景',
      '',
      table(
        ['Step ID', '发起方', '动作', '系统责任', '可观察结果'],
        useCase.mainScenario.map((step) => [
          step.id,
          step.initiator,
          step.action,
          step.systemResponse,
          step.observableResult,
        ]),
      ),
      '',
      '#### 备选与异常场景',
      '',
    );
    if (useCase.alternateScenarios.length === 0) lines.push('- 无显式分支', '');
    for (const scenario of useCase.alternateScenarios) {
      lines.push(
        '##### ' + scenario.id + '：' + scenario.name,
        '',
        '- 类型：' + scenario.type,
        '- 分支点：' + scenario.startsAt,
        '- 条件：' + scenario.condition,
        '- 结果：' + scenario.outcome,
        '',
        table(
          ['Step ID', '发起方', '动作', '系统责任', '可观察结果'],
          scenario.steps.map((step) => [
            step.id,
            step.initiator,
            step.action,
            step.systemResponse,
            step.observableResult,
          ]),
        ),
        '',
      );
    }
    lines.push(
      '#### 验收条件',
      '',
      table(
        ['Acceptance ID', '场景', 'Given', 'When', 'Then'],
        useCase.acceptanceCriteria.map((criterion) => [
          criterion.id,
          criterion.scenario,
          criterion.given,
          criterion.when,
          criterion.then,
        ]),
      ),
      '',
    );
  }
  lines.push(...gates(data), ...gaps(data));
  return lines.join('\n').trimEnd() + '\n';
}

function renderInteractions(data, context) {
  const lines = header('Wireflow Mid-Fidelity Specification', data, context.internalModel);
  lines.push(
    '本产物把上游 Use Case 场景转换为中保真 Screen、内容层级、语义 Control、可见状态与分支流转；它足以指导 HTML Mock，但不决定可复用代码组件或视觉 Token。',
    '',
    '## Wireflow 概览',
    '',
    table(
      ['Wireflow ID', 'Use Case', '名称', '用户目标', '覆盖场景', '入口 Screen', '完成状态'],
      data.wireflows.map((item) => [
        item.id,
        item.useCase,
        item.name,
        item.userGoal,
        item.coveredScenarios.join(', '),
        item.entryScreen,
        item.completionStates.join(', '),
      ]),
    ),
    '',
    '## Screen Registry 与中保真结构',
    '',
  );
  if (data.screens.length === 0) lines.push('- 暂无正式条目', '');
  for (const screen of data.screens) {
    lines.push(
      '### ' + screen.id + '：' + screen.name,
      '',
      '- 目的：' + screen.purpose,
      '- Use Cases：' + screen.useCases.join(', '),
      '',
    );
    for (const region of screen.regions) {
      lines.push(
        '#### ' + region.id + '：' + region.name,
        '',
        '- 区域目的：' + region.purpose,
        '- 内容层级：' + region.content.join(' → '),
        '',
        table(
          ['Control ID', '类型', '标签', '目的', '数据绑定', '动作意图'],
          region.controls.map((control) => [
            control.id,
            control.type,
            control.label,
            control.purpose,
            control.dataBinding || '—',
            control.action || '—',
          ]),
        ),
        '',
      );
    }
  }
  lines.push('## Wireflow Steps', '');
  if (data.wireflows.length === 0) lines.push('- 暂无正式条目', '');
  for (const flow of data.wireflows) {
    lines.push(
      '### ' + flow.id + '：' + flow.name,
      '',
      table(
        ['Step ID', 'UC 场景', 'Actor 动作', '系统响应', 'From', '事件/Control', 'Guard', 'To', '可见反馈'],
        flow.steps.map((step) => [
          step.id,
          step.scenario,
          step.actorAction,
          step.systemResponse,
          step.from.screen + ' / ' + step.from.state,
          step.event + (step.control ? ' / ' + step.control : ''),
          step.guard || '—',
          step.to.screen + ' / ' + step.to.state,
          step.visibleFeedback,
        ]),
      ),
      '',
    );
  }
  lines.push(
    '## 可见交互状态',
    '',
    table(
      ['State ID', 'Screen', '类型', '进入条件', '呈现', '可用 Controls', '终态'],
      data.interactionStates.map((item) => [
        item.id,
        item.screen,
        item.type,
        item.condition,
        item.presentation,
        item.availableControls.join(', ') || '无',
        item.terminal ? '是' : '否',
      ]),
    ),
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderUiSpec(data, context) {
  const lines = header('HTML Mock Specification', data, context.internalModel);
  lines.push(
    '本产物把 Wireflow Mid 转换为可运行、可操作、可审阅的 HTML Mock。它记录代码入口、Screen 映射、场景操作与可观察断言，不拥有新的产品或交互事实。',
    '',
    '## 设计来源',
    '',
    table(
      ['Source ID', '类型', '位置', 'Node', '覆盖范围', '证据路径', 'SHA-256', '捕获时间', '状态'],
      data.designSources.map((item) => [
        item.id,
        item.type,
        item.location,
        item.nodeId || '—',
        item.scope,
        item.evidence?.path || '—',
        item.evidence?.sha256 || '—',
        item.evidence?.capturedAt || '—',
        item.status,
      ]),
    ),
    '',
    '## 设计资源本地化映射',
    '',
    table(
      ['Binding ID', '类型', '来源', 'Source Node', '本地路径', 'HTML Mocks', '代码使用', '状态'],
      data.assetBindings.map((item) => [
        item.id,
        item.kind,
        item.source,
        item.sourceNode || '—',
        item.localPath || '—',
        item.htmlMocks.join(', '),
        item.usages.map((usage) => usage.htmlMock + (usage.scenario ? ' / ' + usage.scenario : ' / initial') + ' @ ' + usage.entry + ' → ' + usage.reference).join('; ') || '—',
        item.status,
      ]),
    ),
    '',
    '## HTML Mock 入口与上游覆盖',
    '',
    table(
      ['HTML Mock ID', '名称', 'Use Cases', 'Wireflows', 'Design Sources', 'Route', '实现入口', 'Components'],
      data.htmlMocks.map((item) => [
        item.id,
        item.name,
        item.useCases.join(', '),
        item.wireflows.join(', '),
        item.designSources.join(', '),
        item.route,
        item.entry,
        item.components.join(', ') || '—',
      ]),
    ),
    '',
    '## Screen → DOM 映射',
    '',
    table(
      ['HTML Mock ID', 'Screen', 'Selector', '实现目的'],
      data.htmlMocks.flatMap((mock) => mock.screens.map((screen) => [mock.id, screen.screen, screen.selector, screen.purpose])),
    ),
    '',
    '## 可操作场景',
    '',
  );
  if (data.interactionScenarios.length === 0) lines.push('- 暂无正式条目', '');
  for (const scenario of data.interactionScenarios) {
    lines.push(
      '### ' + scenario.id + '：' + scenario.name,
      '',
      '- HTML Mock：' + scenario.htmlMock,
      '- Wireflow / UC Scenario：' + scenario.wireflow + ' / ' + scenario.ucScenario,
      '- 起始路由：' + scenario.startRoute,
      '',
      table(
        ['Step ID', '操作', 'Target', '输入', '预期 Screen', '预期状态', '可观察反馈'],
        scenario.steps.map((step) => [
          step.id,
          step.action,
          step.target,
          step.input || '—',
          step.expectedScreen,
          step.expectedState,
          step.expectedFeedback,
        ]),
      ),
      '',
    );
  }
  lines.push(
    '## Mock Behavior',
    '',
    table(
      ['Behavior ID', 'HTML Scenario', '触发', 'Fixture', '延迟', '结果状态'],
      data.mockBehaviors.map((item) => [
        item.id,
        item.scenario,
        item.trigger,
        item.fixture,
        String(item.latencyMs) + 'ms',
        item.resultState,
      ]),
    ),
    '',
    '## 视觉约束',
    '',
    table(
      ['Rule ID', 'Scope', '规格', '意图', '来源'],
      data.visualRules.map((item) => [item.id, item.scope, item.specification, item.intent, item.sourceRefs.join(', ')]),
    ),
    '',
    '## 必测视口',
    '',
    table(
      ['Viewport ID', '名称', '尺寸', '必测'],
      data.viewports.map((item) => [item.id, item.name, item.width + '×' + item.height, item.required ? '是' : '否']),
    ),
    '',
    '## Accessibility',
    '',
    table(
      ['A11y ID', '要求', '验证方式'],
      data.accessibility.map((item) => [item.id, item.requirement, item.verification]),
    ),
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderComponentCatalog(data, context) {
  const lines = header('Component Catalog', data, context.internalModel);
  lines.push(
    '本产物是 HTML Mock 的支撑契约，只维护可复用组件级视图责任，不定义新的产品能力、Screen 或用户流程。',
    '',
    '## Components',
    '',
  );
  if (data.components.length === 0) lines.push('- 暂无正式条目', '');
  for (const component of data.components) {
    lines.push(
      '### ' + component.id,
      '',
      '- HTML Mocks：' + component.htmlMocks.join(', '),
      '- Responsibility：' + component.responsibility,
      '- Inputs：' + (component.inputs.join(', ') || '—'),
      '- Outputs：' + (component.outputs.join(', ') || '—'),
      '- States：' + component.states.join(', '),
      '- Variants：' + (component.variants.join(', ') || '—'),
      '- Accessibility：' + component.accessibility.join(', '),
      '- Prototype：' + component.prototype,
      '',
    );
  }
  lines.push(...gates(data), ...gaps(data));
  return lines.join('\n').trimEnd() + '\n';
}

function renderArchitecturePackage(data, context) {
  const lines = header('Architecture Design Package', data, context.internalModel);
  lines.push(
    '本文件是架构设计 Package 的正式用户产物；内部结构化模型只服务于生成和校验，产品事实只从上游 Product Design 用户产物读取。',
    '',
    '## Upstream Baseline',
    '',
    '- 阶段：' + text(data.upstream.stage),
    '- Artifact：' + text(data.upstream.artifact),
    '- 版本：' + text(data.upstream.version),
    '',
    '## Architecture Overview',
    '',
    '- 系统名称：' + text(data.overview.systemName),
    '- 架构目标：' + text(data.overview.architectureGoal),
    '',
    '### Constraints',
    '',
    list(data.overview.constraints),
    '',
    '## Architecture Artifacts',
    '',
  );
  for (const artifactId of data.artifactOrder) {
    const target = context.artifacts[artifactId]?.outputs?.find((output) => output.role === 'user-artifact')?.path;
    lines.push('- [' + LABELS[artifactId] + '](' + relativeLink(context.output, target) + ')');
  }
  lines.push(
    '',
    '## Reading Protocol',
    '',
    '1. 先确认 Product Design strict Profile 与本 Package 记录的上游版本。',
    '2. 从系统边界读取 Actor/UC 到子系统、能力输入输出及做/不做范围的映射。',
    '3. 从概念建模读取对象字段、唯一键、约束、归一/继承关系和跨 UC 生命周期。',
    '4. 从技术验证读取能力及输入输出对象驱动的技术选型、可行性代码和脱敏证据。',
    '5. 发现产品缺口时记录 gap 并反馈上游，不得在架构产物中改写产品事实。',
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderSystemBoundary(data, context) {
  const lines = header('系统边界', data, context.internalModel);
  lines.push(
    '本产物从已批准 Actor 与 Use Case 抽象长期稳定的系统/子系统边界；它说明做什么、不做什么，但不定义对象字段或选择实现技术。',
    '',
    '## 系统级边界',
    '',
    '- 系统名称：' + text(data.system.name),
    '- 系统使命：' + text(data.system.mission),
    '- 覆盖 Use Case：' + (data.useCases.join(', ') || '暂无正式条目'),
    '',
    '### 系统负责',
    '',
    list(data.system.includedResponsibilities),
    '',
    '### 系统不负责',
    '',
    list(data.system.excludedResponsibilities),
    '',
    '## Actor 交互',
    '',
    table(
      ['Actor', 'Use Cases', '交互边界'],
      data.actorInteractions.map((item) => [item.actor, item.useCases.join(', '), item.interaction]),
    ),
    '',
    '## 子系统边界',
    '',
  );
  if (data.subsystems.length === 0) lines.push('- 暂无正式条目', '');
  for (const subsystem of data.subsystems) {
    lines.push(
      '### ' + subsystem.id + '：' + subsystem.name,
      '',
      '- 目的：' + subsystem.purpose,
      '- Actors：' + subsystem.actors.join(', '),
      '- Use Cases：' + subsystem.useCases.join(', '),
      '- 负责：' + subsystem.includedResponsibilities.join('；'),
      '- 不负责：' + subsystem.excludedResponsibilities.join('；'),
      '',
      table(
        ['Capability ID', '能力', '说明', 'Use Cases', '语义输入', '语义输出', '需技术选型'],
        subsystem.capabilities.map((capability) => [
          capability.id,
          capability.name,
          capability.description,
          capability.useCases.join(', '),
          capability.inputs.map((item) => item.name + (item.required ? '*' : '') + '：' + item.description).join('；') || '—',
          capability.outputs.map((item) => item.name + (item.required ? '*' : '') + '：' + item.description).join('；') || '—',
          capability.selectionRequired ? '是' : '否',
        ]),
      ),
      '',
      table(
        ['依赖类型', '目标', '原因'],
        subsystem.dependencies.map((dependency) => [dependency.type, dependency.target, dependency.reason]),
      ),
      '',
    );
  }
  lines.push(
    '## 外部系统与信任边界',
    '',
    table(
      ['External ID', '名称', '职责', '交互', 'Use Cases', '交换数据', '信任边界'],
      data.externalSystems.map((item) => [
        item.id,
        item.name,
        item.responsibility,
        item.interaction,
        item.useCases.join(', '),
        item.dataExchanged.join(', '),
        item.trustBoundary,
      ]),
    ),
    '',
    '## 架构约束',
    '',
    table(
      ['Constraint ID', '来源', '状态', '约束', 'Use Cases'],
      data.constraints.map((item) => [item.id, item.source, item.status, item.statement, item.useCases.join(', ')]),
    ),
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderConceptualModel(data, context) {
  const lines = header('概念建模', data, context.internalModel);
  lines.push(
    '本产物定义技术无关的关键对象实体、字段、唯一键、业务约束与生命周期；它指导后续迭代的对象归一和继承设计，但不是数据库 Schema、API DTO 或框架类图。',
    '',
    '## 关键对象实体',
    '',
  );
  if (data.objects.length === 0) lines.push('- 暂无正式条目', '');
  for (const object of data.objects) {
    lines.push(
      '### ' + object.id + '：' + object.name,
      '',
      '- 规范名称：' + object.name,
      '- 别名/待归一术语：' + (object.aliases.join(', ') || '无'),
      '- 类型：' + object.kind,
      '- 定义：' + object.definition,
      '- 归属子系统：' + object.ownedBy,
      '- Use Cases：' + object.useCases.join(', '),
      '- Capabilities：' + object.capabilities.join(', '),
      '',
      table(
        ['字段', '概念类型', '必需', '定义', '字段约束'],
        object.fields.map((field) => [field.name, field.type, field.required ? '是' : '否', field.definition, field.constraints.join('；') || '—']),
      ),
      '',
      table(
        ['Key ID', '类型', '字段', '唯一范围', '不可变'],
        object.keys.map((key) => [key.id, key.type, key.fields.join(', '), key.scope, key.immutable ? '是' : '否']),
      ),
      '',
      table(
        ['Rule ID', '类型', '约束'],
        object.constraints.map((rule) => [rule.id, rule.type, rule.description]),
      ),
      '',
      table(
        ['State ID', '状态', '定义', '初始', '终态'],
        object.states.map((state) => [state.id, state.name, state.definition, state.initial ? '是' : '否', state.terminal ? '是' : '否']),
      ),
      '',
    );
  }
  lines.push(
    '## 对象关系与归一/继承',
    '',
    table(
      ['Relationship ID', 'From', 'From Cardinality', '关系', 'To', 'To Cardinality', '说明'],
      data.relationships.map((item) => [item.id, item.from, item.fromCardinality, item.type, item.to, item.toCardinality, item.description]),
    ),
    '',
    '## 跨 UC 对象数据流与生命周期',
    '',
    table(
      ['Flow ID', 'Object', 'Use Case', 'Capability', 'Subsystem', '操作', 'Source', 'Target', '输入字段', '输出字段', '状态变化', '说明'],
      data.objectFlows.map((flow) => [
        flow.id,
        flow.object,
        flow.useCase,
        flow.capability,
        flow.subsystem,
        flow.operation,
        flow.source.type + ':' + (flow.source.ref || '—'),
        flow.target.type + ':' + (flow.target.ref || '—'),
        flow.inputFields.join(', ') || '—',
        flow.outputFields.join(', ') || '—',
        (flow.fromState || '∅') + ' → ' + (flow.toState || '∅'),
        flow.description,
      ]),
    ),
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderTechnicalValidation(data, context) {
  const lines = header('技术验证', data, context.internalModel);
  lines.push(
    '本产物根据子系统能力及输入输出对象固化技术选型。代码位于本目录 `cases/`，凭据只通过环境变量注入；后续迭代应复用结论和适用限制，无需重复选型验证。',
    '',
    '## 技术选型决策',
    '',
  );
  if (data.decisions.length === 0) lines.push('- 暂无正式条目', '');
  for (const decision of data.decisions) {
    lines.push(
      '### ' + decision.id + '：' + decision.decisionQuestion,
      '',
      '- 类别：' + decision.category,
      '- 子系统：' + decision.subsystem,
      '- Capabilities：' + decision.capabilities.join(', '),
      '- Use Cases：' + decision.useCases.join(', '),
      '- 输入对象：' + (decision.inputModels.join(', ') || '无'),
      '- 输出对象：' + (decision.outputModels.join(', ') || '无'),
      '- 外部系统：' + (decision.externalSystems.join(', ') || '无'),
      '- 评估标准：' + decision.criteria.join('；'),
      '- 状态：' + decision.status,
      '- 最终选择：' + text(decision.selectedCandidate),
      '- 决策理由：' + text(decision.rationale),
      '- 适用限制：' + (decision.limitations.join('；') || '无'),
      '',
      table(
        ['Option ID', '候选方案', 'Provider', '版本', '官方文档', '优势', '风险'],
        decision.candidates.map((candidate) => [
          candidate.id,
          candidate.name,
          candidate.provider,
          candidate.version,
          candidate.officialDocumentation,
          candidate.strengths.join('；'),
          candidate.risks.join('；'),
        ]),
      ),
      '',
    );
  }
  lines.push(
    '## 代码可行性实验',
    '',
    table(
      ['Experiment ID', 'Decision', 'Candidate', '假设', 'Source', 'Command', '结果'],
      data.experiments.map((item) => [
        item.id,
        item.decision,
        item.candidate,
        item.hypothesis,
        item.source,
        item.command,
        item.result.status,
      ]),
    ),
    '',
  );
  for (const experiment of data.experiments) {
    lines.push(
      '### ' + experiment.id + ' Evidence',
      '',
      '- 执行时间：' + text(experiment.result.executedAt),
      '- 摘要：' + text(experiment.result.summary),
      '- 必需环境变量：' + (experiment.requiredEnvironment.join(', ') || '无'),
      '- 断言：' + experiment.assertions.join('；'),
      '- 证据：' + (experiment.result.evidence.join('；') || '—'),
      '- 限制：' + (experiment.limitations.join('；') || '—'),
      '',
    );
  }
  lines.push(...gates(data), ...gaps(data));
  return lines.join('\n').trimEnd() + '\n';
}

function renderTraceability(data, context) {
  return [
    '// GENERATED SUPPORT. NOT A USER ARTIFACT. DO NOT EDIT.',
    '// Internal model: ' + context.internalModel,
    '',
    'export interface TraceabilityLink {',
    '  useCase: string;',
    '  wireflows: string[];',
    '  htmlMocks: string[];',
    '}',
    '',
    'export const traceability: TraceabilityLink[] = ' + JSON.stringify(data.links, null, 2) + ';',
    '',
  ].join('\n');
}

const RENDERERS = {
  'product-package-markdown': renderProductPackage,
  'capabilities-markdown': renderCapabilities,
  'interactions-markdown': renderInteractions,
  'ui-spec-markdown': renderUiSpec,
  'component-catalog-markdown': renderComponentCatalog,
  'traceability-typescript': renderTraceability,
  'architecture-package-markdown': renderArchitecturePackage,
  'system-boundary-markdown': renderSystemBoundary,
  'conceptual-model-markdown': renderConceptualModel,
  'technical-validation-markdown': renderTechnicalValidation,
};

export async function expectedOutputs(root, project, manifest, stageId) {
  const registries = stageId
    ? manifest.artifactRegistry.filter((registry) => registry.stage === stageId)
    : manifest.artifactRegistry;
  const allArtifacts = {};
  for (const registry of registries) {
    const paths = artifactPaths(project, registry.id, registry.stage);
    if (paths) allArtifacts[registry.id] = paths;
  }

  const outputs = [];
  for (const registry of registries) {
    const paths = allArtifacts[registry.id];
    if (!paths) continue;
    const data = await readStructured(root, paths.internalModel, registry.format);
    const renderer = RENDERERS[registry.renderer];
    if (!renderer) throw new Error('未知 renderer：' + registry.renderer);
    for (const output of paths.outputs) {
      const target = output.path;
      outputs.push({
        artifact: registry.id,
        internalModel: paths.internalModel,
        output: target,
        role: output.role,
        content: renderer(data, {
          internalModel: posix.relative(posix.dirname(target), paths.internalModel),
          output: target,
          outputRole: output.role,
          artifacts: allArtifacts,
          project,
        }),
      });
    }
  }
  return outputs;
}

export async function outputDrift(root, project, manifest, stageId) {
  const results = [];
  for (const output of await expectedOutputs(root, project, manifest, stageId)) {
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
