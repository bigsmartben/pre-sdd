# pre-sdd 脚手架仓库说明（Scaffold Repository Instructions）

## 仓库身份

- 当前根目录是 `pre-sdd` 脚手架源仓库（Scaffold Repository），负责维护、测试和发布用于生成工作区的工具；它不是产品或架构交付工作区。
- `templates/workspace/` 是生成工作区模板（Workspace Template）的唯一事实来源；`runtime/` 与 `bin/` 是打包运行时（Packaged Runtime）；`pre-sdd init` 生成的目标目录才是业务工作区（Generated Workspace）。
- 根目录与工作区模板使用不同的项目绑定、Harness 和 Agent 说明。不得用模板的产品交付规则治理根脚手架，也不得用根脚手架规则替代生成工作区的本地治理。

## 行为边界

- 根仓库只处理脚手架工程：模板、通用运行时、命令行入口、初始化、打包、发布准备、脚手架测试和根 Harness。
- 根仓库禁止绑定或初始化 Product Design（产品设计）和 Architecture Design（架构设计）用户阶段，禁止执行产品交付链、领域 readiness（就绪）或领域 handoff（移交）。
- Product Design 与 Architecture Design 领域 Skill 只存在于 `templates/workspace/.agents/skills/` 及生成工作区中；根 `.agents/skills/` 不得保存或自动发现这些领域 Skill。
- 面向用户的命令操作只有安装 `pre-sdd`、更新 `pre-sdd` 和执行 `pre-sdd init .`。`pre-sdd harness` 只供 Agent 与 Harness 内部调度，不是用户接口。
- 全局 `pre-sdd` 只负责生成新工作区；既有工作区不提供更新、升级或同步操作。生成后由工作区本地 `package.json` 与 `package-lock.json` 固定运行配置，全局 `pre-sdd` 更新不得改变既有工作区的可用性。
- Manifest 声明的模块或测试执行器必须从目标工作区本地路径执行；不得改用包内模板副本。
- 脚手架测试必须在操作系统临时目录中的模板副本或生成工作区上运行，不得在 `templates/workspace/` 原位创建用户实例、`node_modules`、构建输出或浏览器证据。
- 修改前识别并保留用户已有改动；不得覆盖、回退或删除无关内容。

## Harness 接入

- 任务开始时读取 `.psp/harness/HARNESS.md`、`psp.project.yaml` 和 `.psp/harness/harness.manifest.json`。
- 使用根 Repository Skill `apply-repository-harness` 调用统一 resolver（解析器），按返回顺序执行全部验证命令。
- 根项目绑定必须是 `PSPScaffoldProject`；模板项目绑定必须是 `PSPProject`。任何上下文混用都以稳定 blocker code（阻断码）失败。
- `AGENTS.md` 只保留身份、行为边界和 Harness 入口；结构化不变量、路径范围、工程命令、验证顺序和阻断码由根 Manifest、Schema（结构定义）和 Validator（校验器）拥有。
- 根 Harness 没有领域移交边。完成脚手架变更后只报告工程门禁结果，不提示产品或架构下游移交。

## 交付报告

- 最终报告必须包含 Scope（范围）、Changes（实际变更）、Validation（逐项验证）和 Residuals（剩余阻断）。
- 验证状态只使用 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`；不得把结构通过、失败或未运行表述为业务就绪。
