import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import {
  artifactPaths,
  joinRepositoryPath,
  readStructured,
  repositoryFile,
  stringifyStructured,
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

function header(title, data, context) {
  return [
    '<!-- OFFICIAL USER ARTIFACT. GENERATED FROM INTERNAL MODEL; DO NOT EDIT DIRECTLY. Internal model: ' + context.internalModel + ' -->',
    '---',
    'generated: true',
    'artifactRole: user-artifact',
    'internalModel: ' + context.internalModel,
    'sourceSha256: ' + context.sourceSha256,
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

function renderArchitecturePackage(data, context) {
  const lines = header('Architecture Design Package', data, context);
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
    '1. 先确认 Use Cases readiness Profile 与本 Package 记录的 capabilities 版本；不读取 Canonical UI Prototype。',
    '2. 从系统边界读取 Actor/UC 到子系统、能力输入输出及做/不做范围的映射。',
    '3. 从概念建模读取对象字段、唯一键、约束、归一/继承关系和跨 UC 生命周期。',
    '4. 从技术验证读取关键能力到技术选型结论及真实代码测试通过结论的映射。',
    '5. 发现产品缺口时记录 gap 并反馈上游，不得在架构产物中改写产品事实。',
    '',
    ...gates(data),
    ...gaps(data),
  );
  return lines.join('\n').trimEnd() + '\n';
}

function renderSystemBoundary(data, context) {
  const lines = header('系统边界', data, context);
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
        ['Capability ID', '能力', '说明', 'Use Cases', '语义输入', '语义输出', '需真实代码技术验证'],
        subsystem.capabilities.map((capability) => [
          capability.id,
          capability.name,
          capability.description,
          capability.useCases.join(', '),
          capability.inputs.map((item) => item.name + (item.required ? '*' : '') + '：' + item.description).join('；') || '—',
          capability.outputs.map((item) => item.name + (item.required ? '*' : '') + '：' + item.description).join('；') || '—',
          capability.technicalValidationRequired ? '是' : '否',
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
  const lines = header('概念建模', data, context);
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
  const lines = header('技术验证', data, context);
  lines.push(
    '本产物只从已批准 Use Case 与系统边界中提取标记为需要技术验证的关键能力，并将技术选型结论映射到源代码哈希一致的真实代码测试通过结论。代码位于本目录 `cases/`，凭据只通过环境变量注入。',
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
      ['Experiment ID', 'Decision', 'Candidate', '假设', 'Source', 'Source SHA-256', 'Command', '结果'],
      data.experiments.map((item) => [
        item.id,
        item.decision,
        item.candidate,
        item.hypothesis,
        item.source,
        text(item.result.sourceSha256),
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

const RENDERERS = {
  'architecture-package-markdown': renderArchitecturePackage,
  'system-boundary-markdown': renderSystemBoundary,
  'conceptual-model-markdown': renderConceptualModel,
  'technical-validation-markdown': renderTechnicalValidation,
};

function structuredHash(data, format) {
  const content = stringifyStructured(data, format);
  return createHash('sha256').update(content).digest('hex');
}

function outputsForArtifact(registry, paths, data, allArtifacts, project, sourceSha256) {
  const renderer = RENDERERS[registry.renderer];
  if (!renderer) throw new Error('未知 renderer：' + registry.renderer);
  return paths.outputs.map((output) => {
    const target = output.path;
    return {
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
        sourceSha256,
      }),
    };
  });
}

export function preparedArtifactOutputs(project, manifest, stageId, artifactId, data, sourceSha256 = null) {
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
    sourceSha256 || structuredHash(data, registry.format),
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
      structuredHash(data, registry.format),
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
