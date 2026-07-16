# PSP 生成工作区说明（Generated Workspace Instructions）

当前目录是生成工作区（Generated Workspace），由 `pre-sdd init` 创建；项目绑定类型必须是 `PSPProject`。本地 Harness、Manifest 与领域 Skill 是本工作区的执行唯一事实来源；这里不是 `pre-sdd` 脚手架源仓库。

本地 `.psp/harness/` 是 User Harness（使用者治理层），只治理当前生成工作区。它不继承脚手架根目录的 Maintainer Harness，也不得反向控制脚手架模板、运行时或发布流程。

## 沟通语言

- 与用户沟通、编写规格和说明性文档时，优先使用中文。
- 代码标识符、协议名、技术名词和业界通用缩写可保留英文。

## 行为边界

- 仓库内部交付关系为 Product Idea → Use Cases；Use Cases → Wireflow → Canonical UI Prototype；Use Cases → Architecture Design。Architecture Design 只依赖通过严格门禁的 Use Cases，不依赖 Canonical UI Prototype。当前工作区不绑定任何外部框架生命周期。Agent 每轮只处理用户明确请求的当前产物，不得把“一句话”自动扩展成全部分支产物。
- Use Cases 是产品设计的首个权威产物和产品事实唯一来源；`PSP.md` 是从同一 Use Cases 内部模型确定性生成的只读 Product Package 摘要，不拥有独立事实、readiness、依赖或 handoff，也不得反向更新 Use Cases。
- 当前产物 readiness 全部通过且 Manifest 为当前产物声明了 handoff（移交）边后，Agent 必须执行登记的 handoff 操作；只有取得本次 `PASS` 凭证，才能在回复中提示移交并结束本轮。Manifest 未声明消费者时，当前范围在 readiness 通过后结束。只有用户后续明确请求下游工作时，才建立新的执行范围。
- Harness 只拥有与产品语义和内容效果无关的硬治理：输入输出角色与路径绑定、Scope、上下游依赖、生命周期、工程命令规范与执行、readiness Profile、blocker code 协议和确定的 handoff；不拥有用户对话、审批、`currentStep`、领域语义或自动推进状态。
- 架构设计单向依赖产品设计；不得从实现便利性反向推导、静默改变或伪造产品事实。
- 除 Canonical UI Prototype 外，面向用户阅读、评审和交付的正式规格产物必须是 Markdown。Canonical UI Prototype 的可执行界面及 `src/spec/canonical-ui.ts` 是正式界面规格和唯一事实来源；README 是面向人的评审投影。
- YAML/JSON 只作为领域能力使用的隐藏结构化模型或机器投影，必须位于项目绑定声明的 `.psp/models/` 路径，不属于用户产物。对 authorityKind 为 `internal-model` 的产物，Agent 不得直接写目标 YAML 或对应 Markdown；必须通过 Manifest 登记的 artifact transaction（产物事务）从同一候选数据一次生成两者。
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
- 日常更新内部模型产物时，先在工作区外的临时位置准备候选数据，运行对应 artifact transaction 的 `--dry-run` 取得 `currentSha256`，再带该哈希提交。`render:product` 与 `render:architecture` 只允许由阶段初始化 operation 调用，不是日常更新入口。
- AGENTS.md 只拥有行为边界；执行协议与机器路由由 Harness protocol 和 Manifest 拥有。产品与架构的 Agent 工作流、Contract、Schema、模板、投影器、追溯规则和领域 Validator 分别由 `.agents/skills/product-design/` 与 `.agents/skills/architecture-design/` 仓库领域 Skill 拥有。
- 只有当前产物的独立 readiness Profile 全部通过，Agent 才能提示可移交给下游；结构校验通过也可能只表示 uninitialized 空状态或 draft 结构有效。

## 变更保护与交付

- 修改前识别并保留用户已有改动；不得覆盖无关内容。
- 路径变更必须同步维护项目绑定、内部模型、用户产物、机器生成支撑和追溯关系。
- 不得绕过机器门禁，或把 FAIL、BLOCKED、NOT_RUN 表述为 PASS。
- 最终交付必须报告 Scope、实际变更、逐项验证状态和剩余 blocker。
