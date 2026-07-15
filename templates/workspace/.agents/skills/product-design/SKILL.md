---
name: product-design
description: 在 PSP 仓库中编写、审查或验证 Product Package、Capabilities、Interactions、Wireflow 或 Canonical UI Prototype 时使用，包括将 Figma 节点、截图或导出资源转为可执行界面原型。该领域 Skill 合并来源采集工作流、Contract、Schema、模板、渲染器、领域 Validator 与浏览器验收；通过项目绑定和 Harness 完成路径路由、输入输出治理、工程门禁与 handoff，不补写未就绪的上游事实，也不定义下游平台映射。
---

# Product Design

## 边界

本 Skill 是 Product Design Domain（产品设计领域）的仓库级封装，拥有产品设计工作流和本目录中的领域资源。Harness 只拥有输入输出绑定、路径与 Scope、工程命令、依赖、生命周期、阻断码协议和确定执行的 handoff；不要把产品语义写入 Harness。

## 资源路由

只读取当前产物所需资源：

- Product Package：`product-package/contract.yaml`、`product-package/schema.json`、`product-package/template.yaml`
- Capabilities / Use Cases：`capabilities/contract.yaml`、`capabilities/schema.json`、`capabilities/template.yaml`
- Interactions / Wireflow：`interactions/contract.yaml`、`interactions/schema.json`、`interactions/template.yaml`
- Canonical UI Prototype：`canonical-ui-prototype/contract.yaml`、`canonical-ui-prototype/schema.json` 与 `canonical-ui-prototype/template/`
- 来源整理：Canonical UI 任务开始时读取 `references/input-mapping.md`；`designSources.kind` 为 `figma` 时读取 `references/figma-ingestion.md`；发生来源冲突时读取 `references/source-reconciliation.md`；视觉实现与验收时读取 `references/visual-validation.md`
- 可执行能力：渲染器和 Validator 位于 `scripts/`；Canonical UI 专用投影与浏览器能力位于 `canonical-ui-prototype/scripts/`

## 工作流

1. 读取 `AGENTS.md`、`.psp/harness/HARNESS.md`、`psp.project.yaml` 和项目绑定的 Manifest。
2. 使用 `$apply-repository-harness` 解析用户明确请求的当前产物、实际路径、上游依赖与初始化状态。Resolver 返回 `BLOCKED` 时停止目标写入并报告原始阻断码。
3. 从 Manifest 登记位置读取当前产物的 Contract、Schema 和模板；不得从目录名推断用户产物路径，不在本文件复制字段定义。
4. 只将 source-backed facts（有来源支撑的事实）写入当前产物。Figma 来源必须先采集为 Area 内可复现的本地证据并计算内容哈希；上游缺失、来源矛盾、连接器不可用或证据不足时记录 gap，不得补写 Product Package、Use Cases 或 Wireflow。
5. 使用本 Skill 的渲染器、投影器和领域 Validator 迭代产物。设计来源证据属于 Canonical UI Area 的正式输入；浏览器运行截图只能写入操作系统临时目录。
6. 对全部实际变更路径重新调用 Resolver，并按 Manifest 返回顺序执行所有验证命令；Skill 不维护静态命令清单，也不自行判断 readiness。
7. 只有用户请求移交且本次 readiness 全部通过时，调用 Manifest 登记的 handoff operation。只有新鲜 `PASS` 凭证允许提示移交；不得初始化下游。

## 领域约束

- Canonical UI Prototype 的静态语义入口和可执行界面共同构成界面规格唯一事实来源；README 与隐藏 JSON 是生成投影。
- Figma Code Connect 只可作为已有组件映射证据，不负责整页转换；本 Skill 不创建 `.figma.ts`、不回写 Figma。
- 具体 Screen、Component、State、Event、Action、追溯、视觉和无障碍规则只由本 Skill 内的 Contract、Schema 与 Validator 定义。
- 不从实现便利性、Figma 图层名或现有代码反推产品事实。
- 不定义 SwiftUI、Android、生产 Web 映射或代码生成规则。
- 不把单项结构校验、构建成功或视觉抽查等同于交付 readiness。

## 交付

按 Manifest 的 evidence report 规范报告 Scope、Changes、Validation 和 Residuals。正式产物、机器投影与临时运行证据必须保持各自的输入输出角色。
