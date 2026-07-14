# Repository-level AI Coding Harness

本文件只定义执行协议。路径绑定由仓库根目录 psp.project.yaml 提供；每个 Artifact binding 明确区分隐藏的 `internalModel`、可阅读的 Markdown `user-artifact` 和仅供机器消费的 `generated-support`。逻辑 Scope、Profile、命令与 blocker catalog 的机器事实来源是 harness.manifest.json。

## Discover

1. 读取适用的 AGENTS.md 指令链。
2. 读取 psp.project.yaml、本协议和 harness.manifest.json。
3. 收集预计变更路径并保留用户已有改动。

Manifest 的 `runtime` 与每个 command/operation 的 `executor` 绑定全局 `pre-sdd` 运行时。工作区 npm scripts 只能通过 `.psp/harness/scripts/invoke-pre-sdd.mjs` 调用该运行时，不得要求工作区安装 `node_modules`。

## Resolve

调用：

    node .psp/harness/scripts/resolve-validation.mjs --path <path> --intent change|readiness --json

普通实现使用 change；只有正式 readiness 或交付判断使用 readiness。resolver 返回 BLOCKED 时停止目标写入，只执行 blocker 允许的恢复动作。

## Change

只修改请求覆盖的最小范围。内部结构化模型发生变化后，通过阶段对应的 render operation 更新全部 output。Markdown `user-artifact` 是正式、可阅读的用户产物；`generated-support` 是机器支撑，二者都不得脱离内部模型单独维护。实际路径超出预计范围时必须重新解析。

## Initialize

纯脚手架使用 manifest 声明的 initialize-workspace operation 初始化工作区：先运行 `npm run init:workspace -- --dry-run`，确认目标后运行 `npm run init:workspace`。该 operation 必须从 psp.project.yaml 派生全部非 unavailable 阶段根目录，只创建 workspace Scope 声明的 `.gitkeep` 标记，并保持所有阶段为 uninitialized；它不得创建任何产品或架构用户实例。该操作可重复执行，但发现 active 阶段或用户文件时必须阻断。

uninitialized 表示目录骨架和路径绑定有效，但用户实例不存在；`.gitkeep` 不属于用户文件，也不得列入用户交付。普通 Harness 变更和 Hook 不得创建用户文件。只有用户明确开始某阶段时，才能执行 manifest 为该阶段声明的 stage operation；先使用 --dry-run 审核目标，stage operation 必须预检上游 readiness 与用户改动碰撞、原子创建完整 Package，并在最后将阶段切换为 active。产品设计使用 `npm run init:product`；架构设计使用 `npm run init:architecture`，且只能在产品 strict Profile 通过后初始化。

## Verify

对实际变更路径重新调用 resolver，按返回顺序执行所有 commands。Schema 验证内部模型结构，Contract 声明语义，领域 validator 判断用户产物所表达的内容是否有效，output drift check 判断 Markdown 用户产物及机器支撑是否与内部模型一致。uninitialized 的结构校验可以 PASS，但 readiness 必须以 AIH_STAGE_UNINITIALIZED 阻断；下游阶段还必须执行依赖阶段的 readiness Profile。

## Handoff

按 manifest 的 handoff 字段报告 Scope、Changes、Validation 和 Residuals。每条命令只能标记 PASS、FAIL、BLOCKED 或 NOT_RUN，并为失败提供稳定 blocker code。

## Codex 生命周期

.codex 和 .agents 下的文件只是适配器，不拥有路由、Schema 或 readiness 规则。Hook 只做轻量 Harness 自检，不能替代任何阶段的严格门禁。
