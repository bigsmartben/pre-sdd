# pre-sdd 快速开始（Quickstart）

本文采用使用者视角（User View）：你只需要安装或更新脚手架、初始化自己的工作区，然后明确告诉智能代理当前要完成哪个产物。若要修改脚手架本身，请改读 [README.md](README.md)。

## 用户命令只有三项

| 用户操作 | 命令 |
|---|---|
| 安装 `pre-sdd` | `npm install --global git+https://github.com/bigsmartben/pre-sdd.git` |
| 更新 `pre-sdd` | `npm update --global pre-sdd` |
| 初始化工作区 | `pre-sdd init .` |

其他解析、阶段初始化、校验和移交命令由智能代理根据目标工作区本地配置执行，不是用户命令。

## 你将得到什么

```mermaid
flowchart LR
    I["安装或更新 pre-sdd"] --> D["创建一个已存在的目标目录"]
    D --> W["pre-sdd init"]
    W --> G["生成工作区<br/>Generated Workspace"]
    G --> A["明确请求一个当前产物"]
    A --> V["执行本地产物门禁"]
    V --> H["由你决定是否开始下游工作"]
```

生成工作区包含产品设计（Product Design）与架构设计（Architecture Design）的空目录骨架、项目绑定、执行控制体系（Harness）和仓库领域 Skill。初始化不会自动创建产品事实、架构事实或下游产物。

## 1. 检查环境

需要：

| 工具 | 要求 | 检查命令 |
|---|---|---|
| Node.js | `20.19.0` 及以上的兼容版本，或 `22.12.0` 及以上版本 | `node --version` |
| npm | 随 Node.js 安装 | `npm --version` |
| Git | 用于从 GitHub 安装 | `git --version` |

例如，`node --version` 输出 `v22.12.0` 即满足要求。

## 2. 安装或更新

推荐全局安装（Global Installation），适合持续使用：

```bash
npm install --global git+https://github.com/bigsmartben/pre-sdd.git
```

已经安装后，更新全局工具：

```bash
npm update --global pre-sdd
```

更新只影响以后初始化的新工作区。既有工作区不自动更新，也不需要与新版全局命令行工具兼容；它继续使用初始化时写入的本地 `package.json` 与 `package-lock.json`。

## 3. 初始化工作区

创建一个空的、已存在的真实目录，然后在其中初始化：

```bash
mkdir my-product
cd my-product
pre-sdd init .
```

`.` 表示当前目录。成功时会看到类似输出：

```text
[PASS] pre-sdd 纯工作区已初始化：<你的目录>
  产品设计：uninitialized
  架构设计：uninitialized
```

初始化规则：

| 情况 | 结果 | 例子 |
|---|---|---|
| 目标目录不存在 | 停止，不创建目录 | 直接运行 `pre-sdd init missing-dir` |
| 目标是文件或符号链接 | 停止，不写入 | 把文件路径传给 `pre-sdd init` |
| 脚手架归属路径发生碰撞 | 整体停止，不覆盖已有文件 | 目标目录已经有 `README.md` |
| 没有碰撞 | 复制纯工作区并先完成结构校验 | 新建空目录后运行 `pre-sdd init .` |

## 4. 认识初始化结果

```text
my-product/
├─ AGENTS.md                    # 智能代理行为边界
├─ README.md                    # 生成工作区说明
├─ psp.project.yaml             # 项目与产物路径绑定
├─ package.json                 # 工作区命令入口
├─ .psp/harness/                # 本地执行控制体系和 Manifest
├─ .agents/skills/              # 本地产品与架构领域 Skill
├─ 01-product-design/.gitkeep   # 未初始化的产品设计骨架
└─ 02-architecture-design/.gitkeep # 未初始化的架构设计骨架
```

目标工作区本地文件是执行事实来源。`package.json` 与 `package-lock.json` 固定运行配置；Manifest、Skill、Contract（契约）、Schema（结构定义）和 Validator（校验器）固定治理与领域执行事实。全局 `pre-sdd` 更新不会替换它们，也不会读取安装包里的模板副本来代替它们。

例如，你在自己的工作区修正了产品 Validator，下一次产品校验就会采用这份本地修改；它不会自动改变其他新建工作区。

## 5. 明确开始一个产物

在生成工作区中打开支持仓库指令的智能编码工具，然后一次只提出一个明确请求。

推荐的第一次请求示例：

```text
请开始产品概览（Product Overview）。
产品想法：为小型团队提供一个按项目汇总客户反馈的工具。
本轮只完成产品概览，不要自动扩展到用例或架构设计。
```

智能代理应先读取本地项目绑定和 Harness，再初始化当前所需阶段、修改当前产物，并执行 Resolver 返回的全部门禁。当前产物通过后，它只能提示可选的下一步；是否继续由你确认。

这些内部命令由智能代理负责。用户不需要直接运行 Harness、Validator 或 Node.js 包管理器脚本。

交付关系如下，但不会自动推进：

```text
Product Overview / 产品概览
  → Use Cases / 用例
      ├─→ Wireflow / 页面流程
      │    → Canonical UI Prototype / 规范界面原型
      └─→ Architecture Design / 架构设计
```

本脚手架不绑定工作区外的下游框架或生命周期。架构设计通过本地门禁后，本轮即结束；后续如何消费由使用者在新的明确范围中决定。

例如，产品概览通过后，你可以停下评审，也可以在下一轮明确回复“开始用例（Use Cases）”。没有这句确认，智能代理不应自动创建用例。

## 常见错误

| 错误码 | 含义 | 处理方式 |
|---|---|---|
| `PRE_SDD_TARGET_INVALID` | 目标不是已存在的真实目录 | 先用 `mkdir` 创建目录，再运行初始化 |
| `PRE_SDD_PATH_COLLISION` | 目标中已有脚手架归属路径 | 换一个新目录；不要让初始化覆盖已有工作区 |
| `AIH_STAGE_UNINITIALIZED` | 智能代理在明确开始阶段前运行了阶段命令 | 先明确请求当前产物，让智能代理按 Manifest 初始化阶段 |

如果问题来自脚手架源码、模板或发布包，请到脚手架源仓库按 [README.md](README.md) 的开发者流程处理；不要在自己的生成工作区里修改包内模板。
