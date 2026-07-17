# PSP 生成工作区 User Harness（使用者治理层）

本文件只定义生成工作区的硬治理执行协议，不治理 `pre-sdd` 脚手架源仓库。路径绑定由工作区根目录 psp.project.yaml 提供；Artifact binding 明确区分输入、权威入口、用户产物、机器投影和临时证据。逻辑 Scope、Domain Registry（领域注册表）、Profile、工程命令、生命周期、内部移交边与 blocker catalog 的机器事实来源是 harness.manifest.json。产品与架构的 Agent 工作流、Contract、Schema、模板、投影器和领域 Validator 封装在 Manifest 登记的仓库领域 Skill 中；Harness 只检查登记结构、路径边界和执行结果，不解释产品或架构语义。

Harness 与 Agent、领域 Skill 和正式产物之间的完整职责判定规则见 [HARNESS-BOUNDARY.md](./HARNESS-BOUNDARY.md)。

## Discover

1. 读取适用的 AGENTS.md 指令链。
2. 读取 psp.project.yaml、本协议和 harness.manifest.json。
3. 收集预计变更路径并保留用户已有改动。

## Resolve

调用：

    node .psp/harness/scripts/resolve-validation.mjs --path <path> --intent change|readiness --json

普通实现使用 change；只有正式 readiness 或交付判断使用 readiness。resolver 返回 BLOCKED 时停止目标写入，只执行 blocker 允许的恢复动作。已登记 Domain Skill 根目录优先归入对应 Domain Scope，宽泛的 repository Scope 只接收未被领域声明的治理路径。`upstreamScopes` 与 `upstreamCommands` 表达机器依赖和门禁；`downstreamConsumers` 只返回 Manifest 显式声明且当前可用的 handoff consumer（移交候选），不代表用户已经选择下一步。

## Change

只修改请求覆盖的最小范围。权威入口发生变化后，通过阶段对应的 render operation 更新全部 projection。`user-artifact` 是正式用户输出；`generated-support` 是机器支撑；`runtime-evidence` 只能临时生成。Artifact binding 可以声明内部模型或可执行 Area 作为权威入口，所有 projection 都不得脱离权威入口单独维护。实际路径超出预计范围时必须重新解析。

## Initialize

纯脚手架使用 manifest 声明的 initialize-workspace operation 初始化工作区：先运行 `npm run init:workspace -- --dry-run`，确认目标后运行 `npm run init:workspace`。该 operation 必须从 psp.project.yaml 派生全部非 unavailable 阶段根目录，只创建 workspace Scope 声明的 `.gitkeep` 标记，并保持所有阶段为 uninitialized；它不得创建任何产品或架构用户实例。该操作可重复执行，但发现 active 阶段或用户文件时必须阻断。

uninitialized 表示目录骨架和路径绑定有效，但用户实例不存在；`.gitkeep` 不属于用户文件，也不得列入用户交付。普通 Harness 变更和 Hook 不得创建用户文件。只有用户明确开始某阶段时，才能执行 Manifest 为该阶段声明的 stage operation。通用 `initialize-stage` 先执行 `upstreamScopes` 声明的 readiness，再复制已登记模板、保护目标路径、执行已登记领域命令并在失败时回滚，不解释模板内容；具体命令、上游依赖、可选 handoff 和模板只能从当前 Manifest 解析，不在协议中硬编码。

## Dependency Evidence / 依赖证据

Manifest 使用 `dependencies` 声明 Artifact Scope 的机器依赖，并使用 `handoffConsumers` 声明工作区内部移交边。依赖不自动构成 handoff：例如 Architecture Design 依赖 Use Cases readiness，但 Use Cases 的唯一 handoff consumer 是 Wireflow。本模板不声明工作区外消费者。正式内部移交必须执行 `npm run handoff -- --from <source-scope> --to <consumer-scope> --json`。Harness 按 Manifest 顺序实际执行来源 readiness 与全部上游命令，失败后其余命令标为 `NOT_RUN`，并返回不持久化的移交凭证。Harness 不保存用户确认、不拥有当前会话步骤，也不初始化或运行下游工作。

## Verify

对实际变更路径重新调用 resolver，按返回顺序执行所有 commands。Harness 只执行并汇总命令，并治理输入输出角色、工程命令登记、失败状态与阻断码；对应仓库领域 Skill 的 Schema、Contract 和 Validator 解释领域内容，projection drift check 判断投影是否与权威入口一致。uninitialized 的结构校验可以 PASS，但 readiness 必须以 AIH_STAGE_UNINITIALIZED 阻断；下游阶段还必须执行依赖阶段的 readiness Profile。

## Evidence Report / 技术证据报告

按 manifest 的 `evidenceReport` 字段报告 Scope、Changes、Validation 和 Residuals。每条命令只能标记 PASS、FAIL、BLOCKED 或 NOT_RUN，并为失败提供稳定 blocker code。移交凭证属于本次命令执行结果，不持久化用户确认；面向用户的移交提示仍由 Agent 在取得 `PASS` 后生成。

## Codex 生命周期

.codex Hook 与 `apply-repository-harness` Skill 只是治理适配器，不拥有路由、领域 Schema 或 readiness 规则。Manifest 登记的 Product Design 与 Architecture Design 仓库领域 Skill 拥有各自工作流和领域资源；它们不得拥有路径绑定、工程门禁结果或 handoff 决策。Hook 只做轻量 Harness 自检，不能替代任何阶段的严格门禁。
