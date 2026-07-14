# pre-sdd

`pre-sdd` 是一个通过 npm 从 GitHub 安装的纯工作区脚手架。它只创建 Harness（执行治理框架）、Agent（智能代理）入口和两个未初始化阶段，不预置产品事实或架构决策。

## 安装与初始化

```bash
npm install --global git+https://github.com/bigsmartben/pre-sdd.git
mkdir my-product
cd my-product
pre-sdd init .
```

`.` 表示直接初始化当前目录，不额外创建项目目录。目标必须是已存在的目录；允许已有 `.git/` 等无关内容，但任何脚手架归属路径发生碰撞都会整体阻断，已有文件不会被覆盖。

一次性执行方式：

```bash
npm exec --yes \
  --package=git+https://github.com/bigsmartben/pre-sdd.git \
  -- pre-sdd init .
```

## 生成结果

初始化生成 `README.md`、`AGENTS.md`、项目绑定、Harness、Repository Skills、Codex Adapter 和两个阶段目录：

| 阶段 | 初始状态 | 初始内容 |
|---|---|---|
| Product Design（产品设计） | `uninitialized` | `.gitkeep` |
| Architecture Design（架构设计） | `uninitialized` | `.gitkeep` |

工作区不生成 `node_modules/`。工作区 npm scripts 优先调用全局 `pre-sdd`；全局命令不存在时，适配器使用 Manifest 声明的 GitHub 包执行一次性回退。

## 生命周期

```text
pre-sdd init .
  → 用户明确运行 npm run init:product
  → 产品严格门禁通过
  → 用户明确运行 npm run init:architecture
  → 架构严格门禁通过
  → Spec-Kit
```

结构校验通过只表示空脚手架或当前实例结构合法。未初始化阶段的严格校验必须以 `AIH_STAGE_UNINITIALIZED` 阻断，不能描述为 ready（就绪）或 deliverable（可交付）。

## 软件包维护

```bash
npm run validate:harness
npm run test:harness
npm run test:package
npm run pack:check
```

根目录是软件包源码和开发 Harness；`templates/workspace/` 是生成工作区的唯一模板，`runtime/` 为无本地 `node_modules` 的工作区提供执行依赖。
