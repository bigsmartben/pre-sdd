# pre-sdd 生成工作区（Generated Workspace）

此目录由 `pre-sdd init` 创建，是业务交付工作区，不是 `pre-sdd` 脚手架源仓库。本地 `psp.project.yaml`、`.psp/harness/` 与 `.agents/skills/` 是本工作区的治理和领域执行唯一事实来源。

本地 `.psp/harness/` 是 User Harness（使用者治理层）：它只约束当前生成工作区，不负责脚手架模板维护，也不与其他工作区共享生命周期或运行事实。

## 初始状态

工作区初始化只创建两个阶段的空目录骨架，不创建任何用户实例或业务事实。

| Stage / 阶段 | Initial Status / 初始状态 | Initial Content / 初始内容 |
|---|---|---|
| Product Design / 产品设计 | `uninitialized` | `.gitkeep` |
| Architecture Design / 架构设计 | `uninitialized` | `.gitkeep` |

只有用户明确开始某一阶段时，Agent 才能执行 Manifest 登记的初始化 operation（操作）。`uninitialized` 结构通过不表示产物内容就绪。

## 交付链

```text
Product Overview / 产品概览
  → Use Case / 用例
      ├─→ Wireflow / 页面流程
      │    → Canonical UI Prototype / 规范界面原型
      └─→ Architecture Design / 架构设计
```

每轮只处理用户明确要求的当前产物。当前产物 readiness Profile（就绪配置）全部通过后，Harness 才能执行本次 handoff（移交）门禁；它不保存用户确认，也不自动启动下游。

当前模板只声明工作区内部移交边，不绑定工作区外框架。架构设计通过本地门禁后即形成当前范围的验证结果，后续消费必须由用户另行明确。

## 架构阶段工程结构

执行 `npm run init:architecture` 后，架构阶段按项目绑定创建固定结构：

```text
02-architecture-design/
├─ inputs/
│  ├─ architecture-package/
│  ├─ system-boundary/
│  ├─ conceptual-model/
│  └─ technical-validation/
├─ .psp/models/                  # 权威结构化模型
├─ 技术验证/cases/EXP-NNN.case.mjs # 真实代码实验
├─ README.md
├─ 系统边界.md
├─ 概念建模.md
└─ 技术验证/README.md
```

`inputs/` 是非权威支撑输入，`.psp/models/` 是领域权威模型，Markdown 是正式用户产物；三者不得混用。Architecture Design 只读取通过门禁的 Use Cases，不依赖 Canonical UI Prototype。

## Agent 内部命令

以下命令由 Agent（智能代理）和 Harness Adapter（执行控制适配器）根据用户意图调用，不是用户命令：

```bash
npm run harness:resolve -- --intent change --path <实际变更路径> --json
npm run validate:harness
npm run validate:product
npm run validate:architecture
npm run handoff -- --from <source-scope> --to <consumer-scope> --json
```

工作区本地 `package.json` 与 `package-lock.json` 固定运行配置，命令执行器从当前工作区本地 Manifest 声明的路径加载。本地领域 Skill、Contract、Schema、模板、渲染器和 Validator 不由包内模板副本替代。

本工作区不提供更新、升级、迁移或同步操作。全局 `pre-sdd` 后续更新只影响新初始化的工作区，不得改变当前工作区的运行配置；当前工作区也不依赖新版全局命令行工具兼容旧工作区。

## 职责边界

| Owner / 所有者 | Owns / 负责 | Does Not Own / 不负责 |
|---|---|---|
| Agent / 智能代理 | 用户对话、当前范围、产物编写、结果解释 | 绕过门禁、自动推进 |
| Harness / 执行控制体系 | 输入输出、路径、Scope、依赖、生命周期、命令、状态与移交 | 产品或架构语义 |
| Domain Skill / 领域 Skill | 领域工作流、Contract、Schema、模板、追溯、渲染器和领域 Validator | 用户审批、阶段推进、路径推断 |
| Canonical UI Prototype / 规范界面原型 | 可执行界面和 `canonical-ui.ts` 语义事实 | 下游平台映射和代码生成规则 |
