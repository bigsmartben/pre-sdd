# PSP 生成工作区说明（Generated Workspace Instructions）

当前目录是生成工作区（Generated Workspace），由 `pre-sdd init` 创建；项目绑定类型必须是 `PSPProject`。本地 Harness、Manifest 与领域 Skill 是本工作区的执行唯一事实来源；这里不是 `pre-sdd` 脚手架源仓库。

## 沟通语言

- 与用户沟通、编写规格和说明性文档时，优先使用中文。
- 代码标识符、协议名、技术名词和业界通用缩写可保留英文。

## 行为边界

- 仓库交付关系为 Product Idea → Use Cases；Use Cases → Wireflow → Canonical UI Prototype；Use Cases → Architecture Design → Spec-Kit。Architecture Design 只依赖通过严格门禁的 Use Cases，不依赖 Canonical UI Prototype。Agent 每轮只处理用户明确请求的当前产物，不得把“一句话”自动扩展成全部分支产物。
- 当前产物 readiness 全部通过后，Agent 必须执行 Manifest 声明的 handoff（移交）操作；只有取得本次 `PASS` 凭证，才能在回复中提示移交并结束本轮。只有用户后续明确请求下游工作时，才建立新的执行范围。
- Harness 只拥有与产品语义和内容效果无关的硬治理：输入输出角色与路径绑定、Scope、上下游依赖、生命周期、工程命令规范与执行、readiness Profile、blocker code 协议和确定的 handoff；不拥有用户对话、审批、`currentStep`、领域语义或自动推进状态。
- 架构设计单向依赖产品设计；不得从实现便利性反向推导、静默改变或伪造产品事实。
- 除 Canonical UI Prototype 外，面向用户阅读、评审和交付的正式规格产物必须是 Markdown。Canonical UI Prototype 的可执行界面及 `src/spec/canonical-ui.ts` 是正式界面规格和唯一事实来源；README 是面向人的评审投影。
- YAML/JSON 只作为领域能力使用的隐藏结构化模型或机器投影，必须位于项目绑定声明的 `.psp/models/` 路径，不属于用户产物。
- `user-artifact` 是正式用户产物；`generated-support` 只供机器消费，不得列入用户交付清单。用户目录不得放置 Contract、Schema、Validator、Harness 测试或通用模板。
- 具体用户目录与产物路径只从 psp.project.yaml 读取，不得从目录名称猜测。
- 工作区初始化必须创建所有已绑定且非 unavailable 的阶段根目录；空目录骨架不等于用户实例。
- 纯脚手架初始状态下，所有非 unavailable 阶段必须为 uninitialized，阶段根目录只能包含 manifest 声明的工作区标记。
- status 为 uninitialized 的阶段只有目录骨架，不拥有用户实例；只有用户明确开始该阶段时才能执行 manifest 声明的初始化 operation。
- status 为 unavailable 的阶段禁止写入；下游只能记录缺口，不得把架构假设写成上游事实。

## Harness 接入

- 任务开始时读取 `.psp/harness/HARNESS.md`、`psp.project.yaml` 和 `.psp/harness/harness.manifest.json`；这些隐藏基础设施不构成用户阅读路径。
- 使用 Repository Skill apply-repository-harness 调用统一 resolver，并执行返回的全部 validation commands。
- 初始化纯脚手架工作区时只使用 manifest 声明的 initialize-workspace operation；它不得创建产品或架构用户实例。
- AGENTS.md 只拥有行为边界；执行协议与机器路由由 Harness protocol 和 Manifest 拥有。产品与架构的 Agent 工作流、Contract、Schema、模板、投影器、追溯规则和领域 Validator 分别由 `.agents/skills/product-design/` 与 `.agents/skills/architecture-design/` 仓库领域 Skill 拥有。
- 只有当前产物的独立 readiness Profile 全部通过，Agent 才能提示可移交给下游；结构校验通过也可能只表示 uninitialized 空状态或 draft 结构有效。

## 变更保护与交付

- 修改前识别并保留用户已有改动；不得覆盖无关内容。
- 路径变更必须同步维护项目绑定、内部模型、用户产物、机器生成支撑和追溯关系。
- 不得绕过机器门禁，或把 FAIL、BLOCKED、NOT_RUN 表述为 PASS。
- 最终交付必须报告 Scope、实际变更、逐项验证状态和剩余 blocker。
