---
name: apply-repository-harness
description: 在 pre-sdd 脚手架源仓库中实施或审查模板、运行时、初始化、打包、测试及根治理变更时使用。通过根 PSPScaffoldProject 绑定调用 Harness resolver，执行全部工程门禁，并阻止根仓库被误当成产品或架构工作区。
---

# 应用脚手架仓库 Harness

## 工作流

1. 读取适用的 `AGENTS.md`、`psp.project.yaml`、`.psp/harness/HARNESS.md` 和项目绑定的 Manifest。
2. 确认根项目 `kind` 为 `PSPScaffoldProject`。若出现业务阶段绑定，以 `AIH_SCAFFOLD_CONTEXT_INVALID` 阻断，不初始化或移交任何领域阶段。
3. 保留无关用户改动，收集全部预计变更的仓库相对 POSIX 路径。
4. 运行：

       node .psp/harness/scripts/resolve-validation.mjs --path <path>... --context local-edit|explicit-consistency|pull-request|main|release --json

   编辑使用 `local-edit`；只有用户显式请求时使用 `explicit-consistency`；PR、main 与 release 由各自 Adapter 显式请求，不得隐式升级。

5. resolver 返回 `BLOCKED` 时停止对应写入；否则只实施用户要求的脚手架工程变更。
6. `local-edit` 只允许 quick 成本；PR 最多 standard；main/release 才允许 full。不得让普通编辑自动执行 `scaffold-consistency`、全仓或包级慢测试。
7. 对全部实际变更路径重新解析，按 `plan` 顺序执行每条命令；报告选择原因、范围扩展、缓存和耗时。只有隔离的 `release` PASS 可以形成 `validated-scaffold-change`。
8. 只报告脚手架工程门禁，不运行产品或架构 handoff。

## 证据

- 固定报告 Scope、Changes、Validation、Residuals。
- 每条命令只使用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`。
- 报告精确命令和稳定 blocker code；不得把模板结构有效描述为业务内容就绪。
