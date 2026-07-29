# pre-sdd 脚手架仓库说明

当前目录是 `pre-sdd` 脚手架源仓库（Scaffold Repository），不是产品或架构交付工作区。

## 仓库边界

- `templates/workspace/` 是新工作区模板的唯一事实来源。
- `runtime/sdd_pre/` 是 Python 打包运行时；公开命令只有 `sdd-pre init .`。
- 根 `.psp/harness/HARNESS.md` 只保存维护者行为原则；它不是解析器、清单或命令控制面。
- 模板 `.psp/harness/HARNESS.md` 只保存生成工作区的用户原则。两层治理互不调用。
- 根仓库不得初始化或交付 Product Design（产品设计）、MockCase 或 Architecture Design（架构设计）实例。
- 生成后的工作区不提供更新、升级或同步；全局工具更新只影响未来创建的工作区。
- 脚手架测试必须使用操作系统临时目录，不得在模板原位产生依赖、构建输出或运行证据。
- 修改前识别并保留已有改动，不得覆盖无关内容。

## 工作方式

1. 先确认请求属于模板、Python CLI、领域 Skill、测试、打包或普通 CI。
2. 直接读取相关文件并实施最小变更，不寻找 Harness Manifest、Resolver、Profile、Scope、Gate、Handoff 或 Receipt。
3. 领域脚本由对应 Skill 自己拥有。通用原子文件事务可放在 `.agents/runtime/`，但不得重新形成中央控制面。
4. 维护者可在仓库内部使用 Python、Node.js 与 npm 执行工程测试；这些不是脚手架使用者的操作入口。

## 交付报告

最终报告包含 Scope（范围）、Changes（实际变更）、Validation（逐项验证）和 Residuals（剩余阻断）。验证状态只使用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`。
