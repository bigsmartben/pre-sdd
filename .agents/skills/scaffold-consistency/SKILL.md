---
name: scaffold-consistency
description: 在 pre-sdd 脚手架根仓库中执行只读一致性分析，检查 Maintainer Harness、工作区模板、打包运行时、Manifest、Schema 与 package 投影是否仍共同实现 Harness Standard v3。仅在用户显式请求脚手架一致性报告，或 Maintainer CI/CD Profile 明确登记时使用；不得读取真实用户实例、修改文件、执行 handoff 或发布。
---

# Scaffold Consistency

## 工作流

1. 确认根项目绑定为 `PSPScaffoldProject`，且协议为 `pre-sdd-harness/v3`。
2. 运行：

       npm run check:scaffold-consistency -- --json

3. 以根 Manifest 的 `standardProjectionRegistry` 为投影注册合同，核对上位规范 clause marker、下游目标、必需/禁止文本以及 Schema、Validator、Test 执行所有者。
4. 缺失条款、重复条款、缺失投影、重复规范权威或相互矛盾的投影统一报告 `AIH_SCAFFOLD_CONSISTENCY_FAILED`。
5. 原样报告 `scope`、`dependencies`、`diagnostics`、`acceptedRisks` 与 `suggestedOperations`。
6. 保持 `changes` 为空；发现问题时只建议显式维护操作，不自动修复。

## 权限边界

- 只读取当前脚手架源仓库和 `templates/workspace/`。
- 不读取生成后脱离仓库的用户工作区。
- 不初始化阶段、不创建 Handoff Receipt、不生成发布凭证。
- `PASS` 只表示本次只读投影检查未发现不一致，不表示允许发布。
