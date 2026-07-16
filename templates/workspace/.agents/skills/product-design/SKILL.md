---
name: product-design
description: 在 PSP 仓库中编写、审查或验证 Product Package、Capabilities、Interactions、Wireflow 或 Canonical UI Prototype 时使用，包括将已采集的设计来源证据与产品语义汇合为可执行界面原型。该领域 Skill 拥有领域工作流、Contract、Schema、模板、渲染器、领域 Validator 与浏览器验收，并将提供方采集和实现修复路由到独立技能；通过项目绑定和 Harness 完成输入输出治理、工程门禁与 handoff，不补写未就绪的上游事实，也不定义下游平台映射。
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
- 来源整理：Canonical UI 任务开始时必须读取 `references/input-mapping.md`、`references/source-reconciliation.md` 与 `references/visual-validation.md`
- 提供方采集：`designSources[].kind` 为 `figma` 时路由到 `$capture-figma-design-source`；本 Skill 校验其 Registration Packet（登记包）并拥有 `canonical-ui.ts` 的来源、资源与使用目标登记，不复制 Figma 连接器操作、节点采集或资源导出步骤
- 组件抽象：Figma 证据包含组件相关节点时，本 Skill 在 `canonical-ui.ts` 中登记 Component Inventory（组件清单）、Figma ↔ Lit Component Mapping（组件映射）与 Variant Coverage Matrix（变体覆盖矩阵）；抽象模型由 `$figma-component-from-design` 提出并经用户确认，最终节点身份只读取重新采集后的本地证据
- 实现修复：`canonical-ui-repair` 返回 `AIH_VISUAL_REPAIR_REQUIRED` 时路由到 `$repair-canonical-ui-visual`；本 Skill 不复制具体 HTML、CSS 或组件修改算法
- 可执行能力：渲染器和 Validator 位于 `scripts/`；Canonical UI 专用投影与浏览器能力位于 `canonical-ui-prototype/scripts/`

## 工作流

1. 读取 `AGENTS.md`、`.psp/harness/HARNESS.md`、`psp.project.yaml` 和项目绑定的 Manifest。
2. 使用 `$apply-repository-harness` 解析用户明确请求的当前产物、实际路径、上游依赖与初始化状态。Resolver 返回 `BLOCKED` 时停止目标写入并报告原始阻断码。
3. 从 Manifest 登记位置读取当前产物的 Contract、Schema 和模板；不得从目录名推断用户产物路径，不在本文件复制字段定义。
4. 生成或修改 Canonical UI Prototype、UI HTML、CSS 或界面组件前，先确认界面主要在哪里使用。若用户已经明确说明则直接采用；否则必须先用日常说法给出可直接选择的答案，例如“电脑网页（推荐）”“15 寸平板”“手机”“我说具体设备”。平板只在需要时继续问“横屏”或“竖屏”。确认前停止界面写入，不先做草稿。
5. 同一次确认中只问与本次范围有关的附加项。默认只做用户选中的运行环境，不自动增加手机、电脑、响应式、多尺寸或横竖屏适配；键盘操作、读屏、焦点、触控尺寸和减少动画等额外检查也不默认启用。需要询问时使用“要不要额外检查键盘操作和读屏等使用方式？不需要（推荐）/需要”这类普通说法，不向用户抛出标准编号或校验器名。
6. 写界面前必须先确定 `visualPolicy.mode`。无视觉输入使用 `autonomous`（自主设计）；用户明确说风格参照、局部参照或只参考部分内容时使用 `guided`（部分参考）；用户提供完整 Figma Frame（画框）、整页截图或明确要求视觉还原时默认使用 `exact`（完全实现），并把 `repairPolicy.enabled` 设为 `true`。`autonomous`、`guided` 与 `unresolved` 必须保持 `repairPolicy.enabled: false`。只有用户明确说“仅作风格参考”才能把完整视觉输入降为 `guided`。视觉输入含义不明确时先确认，保持 `unresolved` 并停止界面写入。
7. 业务语义始终遵循已就绪的 Use Case（用例）与 Wireflow（线框流程）：目标、权限和业务规则来自 Product Package / Capabilities；Screen、Control、状态和分支来自 Interactions。`guided` 与 `exact` 覆盖范围内的页面骨架、尺寸、资源、字体和视觉层级来自指定视觉来源；不得为实现便利重新设计，也不得把视觉来源中的业务暗示反写为上游事实。
8. 只将 source-backed facts（有来源支撑的事实）和用户刚确认的界面范围写入当前产物。设计来源必须先由对应 Source Adapter（来源适配器）采集为 Area 内可复现的本地证据并计算内容哈希；Figma 来源必须调用 `$capture-figma-design-source`，校验其 `source-registration.schema.json` 登记包后，由本 Skill 创建 Canonical UI Asset ID 并写入 `designSources`、`assets` 与使用目标。上游缺失、来源矛盾、连接器不可用或证据不足时记录 gap，不得补写 Product Package、Use Cases 或 Wireflow。设计来源包含更多设备画面时，也不得自动扩大用户确认的运行环境。
   - Figma `design-context.components` 中每个节点必须在 `componentInventory` 中得到且只得到一个决定：`shared-component`、`primitive-only` 或 `local-structure`。
   - `shared-component` 必须绑定一个 Canonical Component、一个 Figma ↔ Lit 映射，以及覆盖全部使用中 Instance 的 Variant 覆盖行。
   - 语义职责与复用决定来自用户确认；Component Key、Component Set、Main Component、Instance 与 Variant 属性来自最终 Figma 证据。二者缺一时以 `AIH_COMPONENT_ABSTRACTION_UNRESOLVED` 停止实现。
9. 对 Product Package、Capabilities 和 Interactions，先在工作区外临时位置准备候选 YAML，再解析 Manifest 登记的 artifact transaction；先运行同一 operation 的 `--dry-run`，使用返回的 `currentSha256` 提交。该事务从同一候选数据生成目标 YAML 与 Markdown；不得直接编辑两者，也不得在日常更新中运行 `render:product`。Canonical UI Prototype 仍按其 TypeScript 权威入口与专用投影规则执行。设计来源证据属于 Canonical UI Area 的正式输入；浏览器运行截图只能写入操作系统临时目录。
10. 对全部实际变更路径重新调用 Resolver，并按 Manifest 返回顺序执行所有验证命令；Skill 不维护静态命令清单，也不自行判断 readiness。
11. `exact` 的来源一致性验收出现 `AIH_VISUAL_SOURCE_PARITY_FAILED` 或 `AIH_VISUAL_STYLE_BINDING_FAILED` 时，先调用 Manifest 登记的 `canonical-ui-repair` operation。返回 `AIH_VISUAL_REPAIR_REQUIRED` 和符合 Schema 的 Repair Packet 后，必须路由到 `$repair-canonical-ui-visual`；本 Skill 不直接规定代码修改步骤。不得把 `exact` 降为 `guided`，不得修改设计来源、截图基线、视觉策略、Canonical UI 业务语义、Use Cases 或 Wireflow。出现其他阻断码、`AIH_VISUAL_REPAIR_SCOPE_VIOLATION` 或 `AIH_VISUAL_REPAIR_EXHAUSTED` 时停止并保留差异包。
12. Canonical UI Prototype 的 repair operation 与 readiness 全部通过后，下一步必须通过 Manifest 登记的 `canonical-ui-dev` 命令启动可持续运行的本地 HTTP Server（超文本传输协议服务器）。`npm run dev` 也会先执行修复门禁；只有修复闭环和全部评审门禁返回 `PASS` 才能启动预览。读取服务器实际输出的 `[READY] Canonical UI Prototype 评审地址`，请求该地址并确认返回成功后，再把可点击地址提供给用户；不得根据默认端口猜测或伪造地址。默认地址必须带 `?annotate=1`，让不一致标记工具随可执行 HTML 一起开启；只有用户明确要求干净预览时才提供不带该参数的基础地址。服务未启动、地址未输出或地址无法访问时，以 `AIH_CANONICAL_UI_SERVER_FAILED` 阻断，不把文件路径代替 HTTP 地址。
13. 当前产物 readiness 全部通过且 Manifest 为当前产物声明了移交边时，必须调用登记的 handoff operation。只有新鲜 `PASS` 凭证允许提示移交；移交不得初始化或编写下游。Manifest 未声明消费者时，在完成适用的运行服务交付后结束当前范围。

## 领域约束

- Canonical UI Prototype 的静态语义入口和可执行界面共同构成界面规格唯一事实来源；README 与隐藏 JSON 是生成投影。
- `autonomous` 允许 Agent 自主确定视觉；`guided` 只约束 `visualPolicy.aspects` 与 `coverage` 声明的部分；`exact` 要求所有已确认路由、场景和视口都有来源截图一致性门禁。不得把 `exact` 描述成视觉灵感或重新设计任务。
- `repairPolicy` 只允许 `exact` 启用，固定最多 3 次；`autonomous` 与 `guided` 不进入整页像素修复循环。Repair Packet 位于操作系统临时目录，只作为 Agent 修复证据，不写入用户产物。
- 提供方连接器只负责生成来源证据，不拥有产品语义、视觉策略、readiness 或 handoff；Figma 写回和 Code Connect（代码连接）由独立 Figma 技能负责。
- 具体 Screen、Component、State、Event、Action、追溯、视觉和无障碍规则只由本 Skill 内的 Contract、Schema 与 Validator 定义。
- 组件抽象的机器事实只由 Canonical UI Contract、Schema 与 Validator 定义；Figma 技能提出模型、来源适配器采集身份、Lit 实现技能消费映射，均不得另建平行事实来源。
- `viewports` 只登记用户确认的运行环境；`accessibility` 只登记用户明确选择的额外检查。字段未声明时，Validator 不得代替用户增加默认检查。
- HTTP 评审地址是当前运行会话的临时交付入口，不写入 `canonical-ui.ts`、README 或隐藏 JSON，也不作为产品事实。
- 不从实现便利性、Figma 图层名或现有代码反推产品事实。
- 不定义 SwiftUI、Android、生产 Web 映射或代码生成规则。
- 不把单项结构校验、构建成功或视觉抽查等同于交付 readiness。

## 交付

按 Manifest 的 evidence report 规范报告 Scope、Changes、Validation 和 Residuals。正式产物、机器投影与临时运行证据必须保持各自的输入输出角色。
