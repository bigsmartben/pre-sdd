# pre-sdd

`pre-sdd` 是一个通过 npm 从 GitHub 安装的产品与架构工作区脚手架。本仓库根目录是脚手架源仓库（Scaffold Repository），负责模板、通用运行时、初始化、测试和打包；它不是产品或架构交付工作区。

`templates/workspace/` 是工作区模板（Workspace Template）的唯一事实来源，`runtime/` 与 `bin/` 是打包运行时（Packaged Runtime）。只有 `pre-sdd init` 创建的目标目录才是生成工作区（Generated Workspace），并由目标目录本地 Manifest、Harness 与领域 Skill 拥有执行事实。

## 安装与初始化

```bash
npm install --global git+https://github.com/bigsmartben/pre-sdd.git
mkdir my-product
cd my-product
pre-sdd init .
```

`.` 表示直接初始化当前目录。目标必须是已存在的目录；任何脚手架归属路径发生碰撞都会整体阻断，已有文件不会被覆盖。

一次性执行方式：

```bash
npm exec --yes \
  --package=git+https://github.com/bigsmartben/pre-sdd.git \
  -- pre-sdd init .
```

初始化生成 `README.md`、`AGENTS.md`、项目绑定、Harness、Repository Skills（仓库技能）、Codex Adapter（Codex 适配器）和两个阶段目录。工作区不生成 `HANDOFF.md`、`currentStep`（当前步骤）或用户确认记录。

| Stage / 阶段 | Initial Status / 初始状态 | Initial Content / 初始内容 |
|---|---|---|
| Product Design / 产品设计 | `uninitialized` | `.gitkeep` |
| Architecture Design / 架构设计 | `uninitialized` | `.gitkeep` |

## Weak Workflow / 弱工作流

Agent 每轮只处理用户明确指定的当前产物。它在当前对话中经历 `WORKING`（处理中）→ `VALIDATING`（验证中）→ `READY_TO_HANDOFF`（可移交）→ `WAITING_FOR_USER`（等待用户），这些状态不会写入仓库。

```text
Product Overview / 产品概览
  → Use Case / 用例
  → Wireflow / 交互流程
  → Canonical UI Prototype / 规范界面原型
  → Architecture Design / 架构设计
  → Spec-Kit / 规格工具包（仓库外）
```

Harness 只治理输入输出规范、路径范围、上游依赖、生命周期、工程命令、阻断协议和确定移交；Screen、Component、State、Event、Action 等规则由 Product Design Domain Skill（产品设计领域技能）实现。Harness 不保存用户确认、不推荐下一步，也不自动初始化下游。Agent 只有取得本次 `PASS` 移交凭证后才能提示移交，用户决定是否发起新的下游任务。

例：用户明确要求开始 Use Case 后，Agent 先执行 Resolver（路径解析器）返回的 Product Overview 上游命令，只修改 Capabilities（能力模型）与 `UC.md`，验证通过后提示“如需继续，请回复‘开始 Wireflow’”，然后停止。

## Artifact Gates / 产物门禁

```bash
npm run validate:product-overview
npm run validate:use-cases
npm run validate:wireflow
npm run validate:canonical-ui-input
npm run validate:canonical-ui-runtime
npm run validate:product:strict
npm run validate:architecture:strict
npm run handoff -- --from use-cases --to architecture-design --json
```

Resolver 根据 `psp.project.yaml` 的 Artifact Binding（产物绑定）定位实际路径：

```bash
npm run harness:resolve -- --intent change --path <实际变更路径> --json
```

其 `upstreamCommands`（上游命令）必须在修改下游前执行，`commands`（完整命令）必须在当前产物完成后全部执行。结构校验通过只表示结构合法；只有 readiness Profile（就绪验证配置）和本次 handoff（移交）操作全部通过，Agent 才能声明可移交。

## Responsibility Separation / 职责分离

| Owner / 所有者 | Owns / 负责 | Does Not Own / 不负责 |
|---|---|---|
| Agent / 智能代理 | 用户意图、单轮范围、产物编写、证据解释、对话式移交 | 机器门禁、自动启动下游 |
| Harness Adapter Skill / 治理适配技能 | 调用 Resolver、执行返回命令、解释治理结果和停止条件 | 路径绑定、领域规则、用户审批 |
| Harness / 执行治理框架 | 输入输出角色与路径绑定、Scope、依赖拓扑、生命周期、工程命令、阻断协议和移交凭证 | 对话状态、用户决定、产品与架构语义、下游初始化 |
| Repository Domain Skill / 仓库领域技能 | Agent 领域工作流、Contract、Schema、模板、投影器、追溯规则、领域 Validator 与专用运行能力 | 路径推断、工程门禁判定、用户审批、阶段推进、移交决策 |
| Canonical UI Prototype / 规范界面原型 | 可执行界面及 `canonical-ui.ts` 语义事实 | 下游平台映射、代码生成规则 |
| User / 用户 | 是否开始新的下游任务 | 手工伪造机器验证结果 |

## 软件包维护

```bash
npm run validate:harness
npm run test:harness
npm run test:package
npm run pack:check
```

GitHub Actions 持续集成（Continuous Integration）不复制上述命令列表。工作流只调用 `.psp/harness/scripts/run-ci-validation.mjs`；该执行器扫描仓库路径、调用 Resolver，并按 Manifest 顺序实际执行返回的全部命令。可在本地只查看执行计划：

```bash
node .psp/harness/scripts/run-ci-validation.mjs --plan --json
```

根目录只保留脚手架工程 Harness 与治理适配 Skill；Product Design 和 Architecture Design 领域 Skill 只存在于 `templates/workspace/` 及生成工作区。`runtime/` 为无本地 `node_modules` 的工作区提供执行依赖，但实际执行 Manifest 声明的目标工作区本地文件。
