import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import {
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

function header(title, data, context) {
  return [
    '<!-- OFFICIAL USER ARTIFACT. GENERATED FROM INTERNAL MODEL; DO NOT EDIT DIRECTLY. Internal model: ' + context.internalModel + ' -->',
    '---',
    'generated: true',
    'artifactRole: user-artifact',
    'internalModel: ' + context.internalModel,
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

function renderProductPackageSummary(data, context) {
  const targetUsers = data.actors.map((actor) => actor.name + '（' + actor.id + '）');
  const coreValues = [...new Set(data.useCases.map((useCase) => useCase.value))];
  const lines = header('Product Package Summary', data, context);
  lines.push(
    '本文件是 Use Cases 权威模型的只读摘要投影，不拥有独立产品事实，也不得单独编辑。所有摘要字段均可追溯到同一次产物 operation 写入的 `use-cases.yaml`。',
    '',
    '## Product Summary',
    '',
    table(
      ['摘要字段', '投影值', '权威来源'],
      [
        ['产品名称', data.intent.productName, 'intent.productName'],
        ['产品概念', data.intent.productConcept, 'intent.productConcept'],
        ['待解决问题', data.intent.problem, 'intent.problem'],
        ['产品目标', data.intent.businessGoal, 'intent.businessGoal'],
        ['成功信号', data.intent.successSignal, 'intent.successSignal'],
        ['目标用户', targetUsers.join('；'), 'actors[].name / actors[].id'],
        ['核心价值', coreValues.join('；'), 'useCases[].value'],
      ],
    ),
    '',
    '## Product Scope',
    '',
    '### Included',
    '',
    list(data.productScope.included),
    '',
    '### Excluded',
    '',
    list(data.productScope.excluded),
    '',
    '## Use Case Index',
    '',
    table(
      ['Use Case', '名称', 'Actor', '目标', '价值'],
      data.useCases.map((useCase) => [useCase.id, useCase.name, useCase.actor, useCase.goal, useCase.value]),
    ),
    '',
    '## Projection Rules',
    '',
    '1. 本摘要只能由 Use Cases 权威模型确定性生成；不存在从 `PSP.md` 反向更新 `use-cases.yaml` 的路径。',
    '2. 依赖、readiness（就绪）和 handoff（移交）关系只由 Harness Manifest 管理，不写入产品内容模型。',
    '3. 修改 Use Cases 时，产物 operation 从同一候选数据更新 `UC.md` 与本摘要；任一文件漂移都会被 Validator（校验器）识别。',
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderCapabilities(data, context) {
  const lines = header('Use Case Specification', data, context);
  lines.push(
    '本产物记录产品行为事实：Actor 为什么触发系统、系统承担什么责任、成功与失败后可观察到什么。它不定义 Screen、Control、组件或实现技术。',
    '',
    '## 产品意图',
    '',
    '- 产品名称：' + text(data.intent.productName),
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

function wireframeNodeLines(node, regions, prefix = '', last = true) {
  const connector = last ? '└─ ' : '├─ ';
  const childPrefix = prefix + (last ? '   ' : '│  ');
  if (node.type === 'region') {
    const region = regions.get(node.region);
    if (!region) return [prefix + connector + node.region + '（未解析）'];
    const lines = [prefix + connector + region.id + '：' + region.name];
    lines.push(childPrefix + '内容：' + region.content.join(' / '));
    if (region.controls.length > 0) {
      lines.push(childPrefix + 'Controls：' + region.controls.map((control) => (
        '[' + control.id + ' ' + control.type + '：' + control.label + ']'
      )).join(' '));
    }
    return lines;
  }
  const direction = node.type === 'horizontal' ? 'HORIZONTAL →' : 'VERTICAL ↓';
  const lines = [prefix + connector + direction];
  node.children.forEach((child, index) => {
    lines.push(...wireframeNodeLines(child, regions, childPrefix, index === node.children.length - 1));
  });
  return lines;
}

function textWireframe(screen) {
  const regions = new Map(screen.regions.map((region) => [region.id, region]));
  const lines = [
    '```text',
    '┌─ ' + screen.id + '：' + screen.name,
    ...wireframeNodeLines(screen.layoutTree, regions, '│  ', true),
    '└─',
    '```',
  ];
  return lines.join('\n');
}

function stateDeltaText(delta) {
  const parts = [];
  if (delta.show.length) parts.push('show: ' + delta.show.join(', '));
  if (delta.hide.length) parts.push('hide: ' + delta.hide.join(', '));
  if (delta.enable.length) parts.push('enable: ' + delta.enable.join(', '));
  if (delta.disable.length) parts.push('disable: ' + delta.disable.join(', '));
  if (delta.content.length) parts.push('content: ' + delta.content.map((item) => item.target + ' = ' + item.value).join('；'));
  return parts.join('<br>') || '—';
}

function endpointText(endpoint) {
  return endpoint.screen + ' / ' + endpoint.state;
}

function renderInteractions(data, context) {
  const lines = header('Wireflow Mid-Fidelity Specification', data, context);
  lines.push(
    '本产物是可执行交互蓝图（Executable Interaction Blueprint）：业务目标、Actor 动作和系统责任只引用上游 Use Cases；本产物拥有页面布局、语义 Control、状态差量和可验证迁移。文本线框图由结构化布局树确定性生成，不是第二份手写事实。',
    '',
    '## Wireflow 概览',
    '',
    table(
      ['Wireflow ID', 'Use Case', '名称', '覆盖场景', '入口 Screen / State', '完成状态'],
      data.wireflows.map((item) => [
        item.id,
        item.useCase,
        item.name,
        item.coveredScenarios.join(', '),
        endpointText(item.entry),
        item.completionStates.join(', '),
      ]),
    ),
    '',
    '## Screen Registry 与文本线框图',
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
      textWireframe(screen),
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
        ['Step ID', 'UC 场景引用', 'UC 步骤引用', 'From', 'Trigger', 'Guard', 'To'],
        flow.steps.map((step) => [
          step.id,
          step.scenarioRef,
          step.useCaseStepRefs.join(', '),
          endpointText(step.from),
          step.trigger.event + (step.trigger.control ? ' / ' + step.trigger.control : ''),
          step.guard || '—',
          endpointText(step.to),
        ]),
      ),
      '',
    );
  }
  lines.push(
    '## 可见交互状态',
    '',
    table(
      ['State ID', 'Screen', '类型', '进入条件', 'State Delta', '终态'],
      data.interactionStates.map((item) => [
        item.id,
        item.screen,
        item.type,
        item.condition,
        stateDeltaText(item.stateDelta),
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
  'product-package-summary-markdown': renderProductPackageSummary,
  'capabilities-markdown': renderCapabilities,
  'interactions-markdown': renderInteractions,
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

export function preparedArtifactOutputs(project, manifest, stageId, artifactId, data) {
  const registries = manifest.artifactRegistry.filter((registry) => registry.stage === stageId);
  const registry = registries.find((item) => item.id === artifactId);
  if (!registry || registry.authorityKind !== 'internal-model') throw new Error('未知内部模型 artifact：' + artifactId);
  const allArtifacts = {};
  for (const item of registries) {
    const paths = artifactPaths(project, item.id, item.stage);
    if (paths) allArtifacts[item.id] = paths;
  }
  const paths = allArtifacts[artifactId];
  if (!paths) throw new Error('项目未绑定 artifact：' + artifactId);
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
