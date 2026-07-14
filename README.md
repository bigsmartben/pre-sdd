# PSP 工作区

本仓库把产品想法逐步整理为可评审、可验证、可供后续 Spec-Kit 迭代消费的设计产物。

日常使用只需要关注两个编号目录：

1. `01-product-design/`：产品行为与交互设计。
2. `02-architecture-design/`：上位架构设计；只有阶段 1 通过严格门禁后才会初始化。

当前状态：

- `01-product-design/`：已初始化，处于 draft。
- `02-architecture-design/`：尚未初始化，等待阶段 1 ready。

## 01-product-design

建议按以下顺序阅读：

    PSP.md → UC.md → wireflow-mid.md → HTML-Mock/README.md → 可运行 HTML Mock

### PSP.md

阶段 1 的总目录，说明产品目标、目标用户、核心价值、产物阅读顺序、完成门禁和显式缺口。

### UC.md

记录产品行为事实：Actor、目标、触发条件、前后置条件、主成功场景、备选/异常场景、业务规则及可观察验收条件。UC 不定义页面、组件和实现技术。

### wireflow-mid.md

把 UC 场景转换为中保真交互决策：Screen、区域、语义 Control、页面状态、guard、流转和可见反馈。它不定义代码组件或技术架构。

### HTML-Mock/README.md

说明 HTML Mock 的实现与验收范围，包括路由、Screen 映射、可操作场景、Mock 行为、必测视口、视觉约束和无障碍要求。

`HTML-Mock/` 中的代码是该 Markdown 规格的可执行证据，不是生产前端。

### HTML-Mock/components/README.md

归纳 HTML Mock 的复用组件、职责、输入输出、状态、变体和无障碍约束；不得新增 UC 或交互分支。

## 02-architecture-design

该目录初始化后，建议按以下顺序阅读：

    README.md → 系统边界.md → 概念建模.md → 技术验证/README.md

### README.md

阶段 2 的总目录，记录上游产品版本基线、架构目标、适用范围、阅读协议、门禁和显式缺口。

### 系统边界.md

从 Actor 与 UC 抽象系统及子系统边界，说明系统做什么、不做什么，以及各子系统的职责、参与者、UC、依赖、能力和语义化输入输出。

### 概念建模.md

提取跨迭代稳定的关键对象，说明对象名称、字段、唯一键、业务约束、状态、对象关系，以及对象在不同 UC 中的生命周期和数据流。这里描述“是什么”，不描述数据库表、DTO 或代码类。

### 技术验证/README.md

针对需要选型的系统能力，记录输入输出模型、候选方案、判断标准、最终选择、代码实验、证据和适用限制，使后续迭代无需重复选型验证。

## 使用原则

- 正式用户规格均为 Markdown。
- YAML/JSON 是隐藏的内部结构化模型，不属于用户产物，也不需要用户直接理解或维护。
- HTML Mock 与技术验证代码只用于证明对应 Markdown 规格可执行。
- 架构设计只能消费产品设计，不得为了实现便利反向改变产品事实。
- 遇到 draft、gap 或 blocker 时，先补齐上游内容，再继续下游阶段。

## 常用操作

查看当前产品结构是否有效：

    npm run validate:product

检查阶段 1 是否可以交付给架构设计：

    npm run validate:product:strict

产品 ready 后初始化阶段 2：

    npm run init:architecture -- --dry-run
    npm run init:architecture

运行 HTML Mock：

    npm run dev

<details>
<summary>内部维护入口</summary>

`.psp/`、`.agents/` 与 `.codex/` 是隐藏基础设施目录；普通规格阅读和评审无需进入。`psp.project.yaml` 只负责阶段及产物路径绑定，根 `package.json` 提供稳定命令入口。

维护者可运行：

    npm run validate:harness
    npm run test:harness
    npm run test:product
    npm run test:architecture

</details>
