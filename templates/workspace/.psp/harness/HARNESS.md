# PSP User Harness v3 执行协议

本文件把根 Harness Standard v3 投影到生成工作区。职责边界见 [HARNESS-BOUNDARY.md](./HARNESS-BOUNDARY.md)；运行计划只从本地 `psp.project.yaml` 与 Manifest 解析。

## Discover / 发现

1. 读取适用的 `AGENTS.md`、本协议、项目绑定和 Manifest。
2. 确认项目与 Manifest 都声明 `pre-sdd-harness/v3`。
3. 保留已有改动，收集预计变更的 POSIX 仓库相对路径。

## Resolve / 解析

普通编辑调用：

    node .psp/harness/scripts/resolve-validation.mjs --path <path>... --context local-edit --json

`local-edit` 只调度当前直接 Scope 的 quick 检查，不沿 Dependency 或 Handoff 扩展。显式一致性、Handoff、PR、main 和 release 只能由对应显式 Operation/Adapter 请求；Planner 必须返回选择原因、范围扩展路径、成本、超时、输入摘要和缓存状态。

## Change / 修改

只修改用户请求的 Artifact 或 Area。权威入口变化后通过登记的 Artifact Operation 原子更新 projection；不得单独维护生成投影。`published` 阶段必须先显式 Reopen。阶段未初始化时，只有用户明确开始该阶段才能执行登记的初始化 Operation；初始化、Publish、Reopen、Repair 和 Handoff 互不隐含。

## Consistency / 一致性

`project-consistency` 是只读能力，只把 `dependency` 当数据边。用户直接激活同名 Skill 必须来自显式请求；Manifest 登记的同名 Command 可以由 Handoff Profile 或 CI/CD 严格 Profile 调度。两者都不进入 Hook、保存或普通编辑，也不授予修改权限。报告包含 `dependencies`、`diagnostics`、`acceptedRisks` 与 `suggestedOperations`，但不修改任何产物。

## Handoff / 授权移交

正式 Handoff 必须经过 preflight、展示、用户 confirm/reject 与 Receipt Schema 校验。Receipt 在写入、查询和撤销前都必须通过登记 Schema；验证状态、用户决定和 Receipt 状态分别记录。Domain Diagnostic 可由用户逐项接受，Safety/Structure Blocker 永不可覆盖。Receipt 绑定来源、Dependency、Manifest、Profile 和 Standard 的版本与哈希；Profile 版本或 handoff 边变化后也必须标记为 `STALE`。无论结果如何，`downstreamAction` 都是 `NOT_RUN`。

## Verify / 验证

对全部实际变更路径重新解析并按 `plan` 顺序执行。一次 Operation 内按 `commandId + inputDigest + profileVersion` 去重；cache key 另行绑定 Standard、Profile、Executor、Source、Dependency 与 Runtime 六类摘要。失败后剩余命令为 `NOT_RUN`；超时以稳定 blocker code 失败。最终 Evidence Report 必须通过共享 Schema，只使用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`，并报告 Scope、Changes、Validation、Residuals 和耗时/缓存指标。

## Stop / 停止

请求完成、出现不可恢复 blocker、需要新用户决定或发现范围外修复时立即停止。不得自动修复、Handoff、Reopen、初始化、发布或开始下游工作。
