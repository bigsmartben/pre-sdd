# PSP Repository Instructions

## 沟通语言

- 与用户沟通、编写规格和说明性文档时，优先使用中文。
- 代码标识符、协议名、技术名词和业界通用缩写可保留英文。

## 行为边界

- 仓库交付链为 Product Idea → Product Design → Architecture Design → Spec-Kit。
- 架构设计单向依赖产品设计；不得从实现便利性反向推导、静默改变或伪造产品事实。
- 面向用户阅读、评审和交付的正式规格产物必须是 Markdown；HTML Mock 与技术验证代码只作为相应 Markdown 产物的可执行证据。
- YAML/JSON 只作为 Harness 内部结构化模型，必须位于项目绑定声明的隐藏 `.psp/models/` 路径，不属于用户产物。
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
- AGENTS.md 只拥有行为边界；执行协议、机器路由、合法结构和领域判断分别由 Harness protocol、manifest、Schema 和 validator 拥有。
- 只有 strict Profile 全部通过才能声明 ready、可消费或可交付；结构校验通过也可能只表示 uninitialized 空状态或 draft 结构有效。

## 变更保护与交付

- 修改前识别并保留用户已有改动；不得覆盖无关内容。
- 路径变更必须同步维护项目绑定、内部模型、用户产物、机器生成支撑和追溯关系。
- 不得绕过机器门禁，或把 FAIL、BLOCKED、NOT_RUN 表述为 PASS。
- 最终交付必须报告 Scope、实际变更、逐项验证状态和剩余 blocker。
