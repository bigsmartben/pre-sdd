# Harness Standard v3 — User Harness Profile

本文件是根 Harness Standard v3 的 User Harness（使用者治理层）投影，不是新的平行上位规范。规范标识为 `pre-sdd-harness/v3`；当前生成工作区的运行权威是本地 `psp.project.yaml`、Manifest、`.psp/runtime/pre-sdd/`、`package.json`、锁文件和已登记 Skill/Executor。

## 责任边界

| 责任方 | 拥有 | 不拥有 |
|---|---|---|
| Agent（智能代理） | 用户对话、当前授权范围、内容实施与结果解释 | 路径猜测、隐式审批、自动推进 |
| Harness（执行控制体系） | 路径、Scope、命令计划、Gate、生命周期、关系登记与证据 | 产品/架构语义、用户决定 |
| Domain/Consistency Skill（领域/一致性 Skill） | 领域 Contract、Schema、语义 Validator 与只读 Dependency 分析 | 项目绑定、Handoff 授权、隐式写权限 |
| Artifact Operation（产物操作） | 用户显式授权的原子产物写入 | 自动修复其他 Scope |

例如，“路径越出仓库”是不可接受的 Safety/Structure Blocker；“视觉覆盖仍有缺口”是 Domain Diagnostic，可在本地 Handoff 中逐项接受，但 PR/main/release 的严格 Profile 仍可失败。

## Dependency 与 Handoff

- `dependency` 是数据关系，只进入 Dependency 闭包、拓扑和 `project-consistency`。
- `handoff` 是用户授权关系，只提供合法消费者候选。
- 边身份是 `from + to + type`；同一节点对可同时存在两类边。
- 普通 `local-edit` 不执行 Dependency 一致性分析，Handoff 边也不进入数据影响闭包。

例如，Use Cases → Visual Spec 同时有 dependency 和 handoff：前者说明数据输入，后者要求用户确认；任何一条都不能替代另一条。

## Handoff 状态机

1. 用户显式请求 `npm run handoff -- --from <source> --to <consumer> --json`。
2. Harness 执行 preflight，固定来源和 Dependency 哈希，展示验证、不可覆盖 blocker、可接受风险和 token，然后停止。
3. 用户拒绝时使用 `--reject --actor <主体>`，不生成 Receipt。
4. 用户确认时使用 `--confirm --actor <主体> --preflight-token <token>`，并对每个风险重复提供 `--accept-risk <code>`。
5. Receipt 在写入、查询和撤销前都必须通过登记 Schema。有效 Receipt 原子写入 `.psp/handoffs/receipts/`；来源、Manifest、Standard、Profile 版本或 handoff 边变化后查询为 `STALE`，摘要被改写为 `INVALID`，显式 `--revoke --receipt <path> --actor <主体> --reason <原因>` 后为 `REVOKED`。

所有返回都保持 `downstreamAction: NOT_RUN`。Handoff 不初始化、不修改、不执行下游。

## 本地运行事实

Manifest 的 Executor 必须相对于当前生成工作区解析；不得执行包内 `templates/workspace/` 副本，也不得回退到后来更新的全局工具。依赖按本地锁文件准备到操作系统临时缓存，不在工作区创建 `node_modules`。旧协议工作区不在 v3 支持范围内，运行时以 `AIH_PROTOCOL_UNSUPPORTED` 阻断且不迁移。
