# PSP 可复用纯脚手架

本仓库是一个不包含具体产品事实和架构决策的纯脚手架。它提供完整目录骨架、阶段模板和 Agent 执行治理 Harness，用于把后续工作稳定地推进为：

    Product Idea → Product Design → Architecture Design → Spec-Kit

## 初始状态

| 阶段 | 状态 | 目录 | 用户实例 |
|---|---|---|---|
| 产品设计 | `uninitialized` | `01-product-design/` | 不存在 |
| 架构设计 | `uninitialized` | `02-architecture-design/` | 不存在 |

两个阶段根目录只包含 `.gitkeep` 工作区标记。该标记只用于持久化空目录，不属于用户产物。

工作区不需要执行 `npm install`，也不会生成 `node_modules/`。根 `package.json` 的 scripts 通过 `pre-sdd` 全局运行时执行 Harness；全局命令不存在时，适配器按 Manifest 声明的 GitHub 包使用 `npm exec` 回退。

## 三层职责

| 层级 | 负责内容 | 不负责内容 |
|---|---|---|
| 脚手架（Scaffold） | 创建 Harness、Agent 入口、项目绑定和阶段目录骨架 | 创建产品事实或架构决策 |
| Harness | 为 Agent 解析 Scope、Profile、命令和 blocker | 替用户批准需求或技术选型 |
| 阶段实例 | 保存产品设计或架构设计的内部模型、Markdown 与验证证据 | 定义 Agent 治理规则 |

## 生命周期

### 1. 初始化纯工作区

初始化操作只确保所有项目绑定的阶段根目录存在，不创建业务实例。该命令可安全重复执行。

    npm run init:workspace -- --dry-run
    npm run init:workspace
    npm run validate:workspace

### 2. 明确开始产品设计

只有用户明确开始产品设计时，才创建完整产品 Package，并把产品阶段切换为 `active`。

    npm run init:product -- --dry-run
    npm run init:product

创建后，用户阅读和评审以下 Markdown：

    01-product-design/PSP.md
    01-product-design/UC.md
    01-product-design/wireflow-mid.md
    01-product-design/HTML-Mock/README.md

Agent 维护隐藏的内部结构化模型，再由 renderer 同步生成 Markdown 用户产物和机器支撑；不得只修改生成结果。

### 3. 产品达到下游可消费状态

    npm run validate:product:strict

严格门禁失败时，Agent 必须报告具体 gap 或 blocker，不得初始化架构阶段。

### 4. 明确开始架构设计

只有产品严格门禁通过后，才允许创建完整架构 Package，并把架构阶段切换为 `active`。

    npm run init:architecture -- --dry-run
    npm run init:architecture

创建后，用户阅读和评审以下 Markdown：

    02-architecture-design/README.md
    02-architecture-design/系统边界.md
    02-architecture-design/概念建模.md
    02-architecture-design/技术验证/README.md

### 5. 架构达到 Spec-Kit 可消费状态

    npm run validate:architecture:strict

只有严格门禁通过，才能声明架构产物可被 Spec-Kit 消费。

## Agent 治理流程

每次任务都必须经过同一条执行链：

    读取 AGENTS.md 与 Harness
      → 根据预计路径调用 resolver
      → READY 才执行最小变更
      → 根据实际变更路径再次调用 resolver
      → 按顺序运行全部返回命令
      → 报告 Scope、Changes、Validation、Residuals

主要入口：

- `AGENTS.md`：轻量行为边界和 Harness 入口。
- `.psp/harness/HARNESS.md`：执行协议。
- `psp.project.yaml`：项目阶段、目录和产物绑定。
- `.psp/harness/harness.manifest.json`：Scope、Profile、operation、命令和 blocker 的机器事实来源。
- `.psp/harness/schemas/`、`contracts/`、`scripts/`：结构、语义和领域验证实现。

## 目录结构

    .agents/                    Repository Skills
    .codex/                     Codex 轻量适配器
    .psp/harness/               Harness 协议、模型、模板、脚本与测试
    01-product-design/          产品设计目录骨架
    02-architecture-design/     架构设计目录骨架
    AGENTS.md                   Agent 行为入口
    psp.project.yaml            项目绑定

## 维护验证

    npm run validate:harness
    npm run validate:workspace
    npm run test:harness
    npm run test:product
    npm run test:architecture

结构校验通过只表示脚手架或当前实例结构合法；只有对应 strict 命令通过，才能声明阶段 ready、可消费或可交付。
