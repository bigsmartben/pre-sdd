---
name: product-design
description: 在 PSP 工作区中开始、编写、审查或验证原子 Use Cases（用例）、提供方中立的 Visual Spec（视觉规格），并把 Figma + UC 路由到 Mapping.html 确认主链。
---

# Product Design

## 边界

本 Skill 拥有 Product Design（产品设计）的初始化、Use Cases、Visual Spec 和进入 Lit UI 交付前的领域路由。路径来自 `psp.project.yaml`，结构由本目录的 Contract（契约）、Schema（模式）和 Validator（验证器）定义。

具体例子：

- UC 规定“订单提交失败后允许重试”，这是业务事实。
- Figma 显示一个红色错误卡片，这是视觉事实。
- 两者是否表示同一个失败状态，必须进入 `Mapping.html` 澄清，不能由 Agent 自行合并。

## 资源路由

- Atomic Use Cases（原子用例）：`capabilities/`。`use-cases.yaml` 是机器权威，`UC.md` 是确定生成的人类视图。
- Visual Spec（视觉规格）：`visual-spec/`。它保存提供方中立的视觉事实，`Visual-Spec.md` 是人类视图。
- Figma 来源：调用 `$figma-workflow`，只接收已冻结的 Acquisition Packet（获取包）与来源证据。
- Figma + UC 澄清：调用 `$lit-ui-workflow`，唯一用户确认载体是 `Mapping.html`。
- 已确认的实现：调用 `$implement-lit-ui`，真实权威是 `src/ui/` 下的 Lit/TypeScript 模块。
- 实现修复：仅在用户明确授权后调用 `$repair-lit-ui`。
- 两层验证用例：调用 `$use-case-generation`。

## 工作流

1. 读取 `AGENTS.md`、`.psp/harness/HARNESS.md` 与 `psp.project.yaml`，确认当前生成工作区。
2. 用户明确开始产品设计时，在后台运行领域初始化脚本；不要要求用户执行内部命令。
3. Use Case 的目标、Actor（参与者）、前置条件、主/备选/异常流程和业务结果只来自用户或已确认业务输入。未知事实保留 gap（缺口）。
4. Visual Spec 只保存有来源的视觉决定。Figma 采集必须先经过 `$figma-workflow`；连接器操作不写进正式产品模型。
5. 需要交付界面时，把当前 UC 与 Figma 精确版本交给 `$lit-ui-workflow`：
   - Figma 只提供视觉/来源事实；
   - UC 只提供业务事实；
   - 每个歧义绑定 `conceptId` 并进行多轮澄清；
   - 任一 gap 或 open question（待回答问题）都会阻止确认；
   - 来源或 Mapping 内容变化会使确认 stale（过期）。
6. 只有 `authorize-implementation` 返回 `PASS` 后才能调用 `$implement-lit-ui`。确认前不得创建业务 `src/ui`、UIHTML 或公开代码计划。
7. UIHTML 由真实 Lit 模块直接构建；默认产品 Bundle（构建包）不得包含 Mapping、Review Tool、Mock Adapter 或 Cases。
8. 报告实际修改、检查状态和剩余问题。不得把 `FAIL`、`BLOCKED` 或 `NOT_RUN` 说成通过。

## 约束

- 不创建 `Preview.html`、映射 JSON、隐藏 UI 投影或集中式 UI 总表。
- `Mapping.html` 只记录 Page、Component、State、Event、Route、Motion、Port 等可感知概念，不记录源码路径、类、函数、Lit Tag 或 DOM Selector。
- Review Tools 只能通过稳定 `conceptId` 定位、观察和受控驱动，不拥有产品 Route、State 或 Port。
- Business Case（业务用例）与 Component Case（组件用例）是验证数据，不是 UIHTML 运行模型。
- 不从实现便利性、Figma 图层名称或现有代码反推业务事实。
- 不自动开始 Architecture Design（架构设计）、发布或其他领域。
