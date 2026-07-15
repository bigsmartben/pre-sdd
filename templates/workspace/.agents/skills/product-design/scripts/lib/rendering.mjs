import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import {
  artifactPaths,
  joinRepositoryPath,
  readStructured,
  repositoryFile,
} from '../../../../../.psp/harness/scripts/lib/repository.mjs';

const LABELS = {
  capabilities: 'UC Specification',
  interactions: 'Wireflow Mid-Fidelity Specification',
  'canonical-ui-prototype': 'Canonical UI Prototype',
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
    '本文件是产品设计 Package 的正式用户产物；隐藏结构化模型只服务于生成和机器校验，不属于用户交付物。',
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
    '1. 本文件只拥有 Product Overview（产品概览）事实，不代表后续产物已经开始。',
    '2. Use Case（用例）→ Wireflow（交互流程）→ Canonical UI Prototype（规范界面原型）只能消费通过门禁的上游事实，不得反向改写。',
    '3. Canonical UI Prototype 的可执行界面及 TypeScript 语义入口共同构成正式界面规格。',
    '4. 遇到 gap（缺口）或冲突时停止下游推导，并反馈对应上游用户产物。',
    '',
    '## Abstraction Boundary',
    '',
    '- UC Specification 定义产品行为事实，不定义 Screen 或实现。',
    '- Wireflow Mid 定义 Screen、内容层级、Control、状态和分支流转，不定义代码组件。',
    '- Canonical UI Prototype 将 Wireflow 转成可运行、可操作、可审阅的正式界面规格。',
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
    '本产物把上游 Use Case 场景转换为中保真 Screen、内容层级、语义 Control、可见状态与分支流转；它足以指导 Canonical UI Prototype，但不决定可复用代码组件或视觉 Token。',
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

const RENDERERS = {
  'product-package-markdown': renderProductPackage,
  'capabilities-markdown': renderCapabilities,
  'interactions-markdown': renderInteractions,
};

export async function expectedOutputs(root, project, manifest, stageId, artifactIds = null) {
  const stageRegistries = stageId
    ? manifest.artifactRegistry.filter((registry) => registry.stage === stageId)
    : manifest.artifactRegistry;
  const selectedArtifacts = artifactIds ? new Set(artifactIds) : null;
  const registries = selectedArtifacts
    ? stageRegistries.filter((registry) => selectedArtifacts.has(registry.id))
    : stageRegistries;
  const allArtifacts = {};
  for (const registry of stageRegistries) {
    const paths = artifactPaths(project, registry.id, registry.stage);
    if (paths) allArtifacts[registry.id] = paths;
  }

  const outputs = [];
  for (const registry of registries) {
    if (registry.authorityKind !== 'internal-model') continue;
    const paths = allArtifacts[registry.id];
    if (!paths) continue;
    const data = await readStructured(root, paths.authorityPath, registry.format);
    const renderer = RENDERERS[registry.renderer];
    if (!renderer) throw new Error('未知 renderer：' + registry.renderer);
    for (const output of paths.outputs) {
      const target = output.path;
      outputs.push({
        artifact: registry.id,
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
      });
    }
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
