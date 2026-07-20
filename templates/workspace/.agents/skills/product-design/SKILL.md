---
name: product-design
description: 在 PSP 仓库中编写、审查或验证 Use Cases、Interactions、Wireflow 或 Canonical UI Prototype 时使用，包括将已采集的设计来源证据与产品语义汇合为可执行界面原型。该领域 Skill 拥有领域工作流、Contract、Schema、模板、渲染器、领域 Validator 与浏览器验收，并将提供方采集和实现修复路由到独立技能；通过项目绑定和 Harness 完成输入输出治理、工程门禁与 handoff，不补写未就绪的上游事实，也不定义下游平台映射。
---

# Product Design

## 边界

本 Skill 是 Product Design Domain（产品设计领域）的仓库级封装，拥有产品设计工作流和本目录中的领域资源。Harness 只拥有输入输出绑定、路径与 Scope、工程命令、依赖、生命周期、阻断码协议和确定执行的 handoff；不要把产品语义写入 Harness。

## 资源路由

只读取当前产物所需资源：

- Capabilities / Use Cases：`capabilities/contract.yaml`、`capabilities/schema.json`、`capabilities/template.yaml`；`use-cases.yaml` 是机器权威视图，`UC.md` 是唯一人类视图；简单范围和参与关系用文本，复杂关系才生成图示，用例标题保留可搜索 ID
- Interactions / Wireflow：`interactions/contract.yaml`、`interactions/schema.json`、`interactions/template.yaml`；“关键参与者”严格指 `capabilities.useCases[].actor` 的去重集合。按该集合维护 `.psp/models/wireflows/<ACTOR-ID>/wireflow-mid.yaml`，每份模型只拥有该参与者的 Sitemap、User Flow 与 Wireframe；`wireflows/README.md` 只做导航，`wireflows/<ACTOR-ID>/wireflow-mid.md` 是同源人类评审投影。单页 Sitemap 用文本，多页层级与 User Flow 用 Mermaid，Wireframe 用支持中英文对齐的 ASCII 页面线框并附页面状态摘要
- User Flow 图面只显示“页面 + 当前状态”、业务结果判断、用户操作或系统结果、简短分支标签及入口/终止节点；机器 ID、完整 Guard、事件名和追踪引用仅保留在对应参与者的 `wireflow-mid.yaml`
- Canonical UI Prototype：`canonical-ui-prototype/contract.yaml`、`canonical-ui-prototype/schema.json` 与 `canonical-ui-prototype/template/`；`Canonical-UI-Prototypes/<ACTOR-ID>/` 与 Wireflow 分区一一对应，每个目录拥有独立源码、`package.json`、构建配置和语义入口。`dist`、HTTP 评审地址与临时证据由运行器和 Validator 管理，不是产品事实
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
7. 业务语义始终遵循已就绪的 Use Case（用例）与 Wireflow（线框流程）：目标、权限和业务规则来自 Use Cases 的机器权威视图，`UC.md` 只供人类阅读。Screen、Control、状态和分支只读取当前 `ACTOR-ID` 的 Interactions；禁止跨参与者消费。`guided` 与 `exact` 覆盖范围内的页面骨架、尺寸、资源、字体和视觉层级来自指定视觉来源；不得为实现便利重新设计，也不得把视觉来源中的业务暗示反写为上游事实。
8. 只将 source-backed facts（有来源支撑的事实）和用户刚确认的界面范围写入当前产物。设计来源必须先由对应 Source Adapter（来源适配器）采集为 Area 内可复现的本地证据并计算内容哈希；Figma 来源必须调用 `$capture-figma-design-source`，校验其 `source-registration.schema.json` 登记包后，由本 Skill 创建 Canonical UI Asset ID 并写入 `designSources`、`assets` 与使用目标。上游缺失、来源矛盾、连接器不可用或证据不足时记录 gap，不得补写 Use Cases 或 Wireflow。设计来源包含更多设备画面时，也不得自动扩大用户确认的运行环境。
   - Figma `design-context.components` 中每个节点必须在 `componentInventory` 中得到且只得到一个决定：`shared-component`、`primitive-only` 或 `local-structure`。
   - `shared-component` 必须绑定一个 Canonical Component、一个 Figma ↔ Lit 映射，以及覆盖全部使用中 Instance 的 Variant 覆盖行。
   - 语义职责与复用决定来自用户确认；Component Key、Component Set、Main Component、Instance 与 Variant 属性来自最终 Figma 证据。二者缺一时以 `AIH_COMPONENT_ABSTRACTION_UNRESOLVED` 停止实现。
9. 对 Capabilities / Use Cases 和 Interactions，先在工作区外准备候选再解析 Manifest 登记的 artifact operation；`--dry-run` 只预检 Schema 与目标路径，正式写入不要求旧版本 hash。Capabilities 输入是一份 YAML；Interactions 输入是完整参与者目录集合，每个 `ACTOR-ID/` 必须且只能包含 `wireflow-mid.yaml`，目录名必须等于 `metadata.actor`。operation 一次更新整组 YAML、索引和 Markdown；不得直接编辑目标，也不得在日常更新中运行 `render:product`。Canonical UI Prototype 仍按每个参与者应用的 TypeScript 权威入口与专用投影规则执行。
10. 每个 Canonical UI Prototype 达到可运行状态后，必须通过 Manifest 登记的 `canonical-ui-dev` 命令并用 `--actor ACTOR-NNN` 启动该独立应用的 HTTP Server（超文本传输协议服务器）。读取服务器实际输出的 `[READY] <ACTOR-ID> 独立应用评审地址`，请求该地址并确认返回成功后立即提供可点击地址；多个参与者不得共享一个运行入口。不得等待视觉修复或正式 readiness，也不得根据默认端口猜测或伪造地址。普通评审地址默认开启不一致标记工具；只有用户明确要求干净预览时才提供带 `?annotate=0` 的地址。服务未启动、地址未输出或无法访问时，以 `AIH_CANONICAL_UI_SERVER_FAILED` 阻断。
11. 地址交付后，对全部实际变更路径重新调用 Resolver，并按 Manifest 返回顺序执行所有验证命令；Skill 不维护静态命令清单，也不自行判断 readiness。任何 FAIL、BLOCKED 或 NOT_RUN 都作为 residual（剩余问题）报告并阻止正式 ready（就绪）或 handoff（移交），但只要评审服务本身仍可访问，就不得撤回或隐瞒已经提供的地址。
12. `exact` 的来源一致性验收出现 `AIH_VISUAL_SOURCE_PARITY_FAILED` 或 `AIH_VISUAL_STYLE_BINDING_FAILED` 时，先调用 Manifest 登记的 `canonical-ui-repair` operation。返回 `AIH_VISUAL_REPAIR_REQUIRED` 和符合 Schema 的 Repair Packet 后，路由到 `$repair-canonical-ui-visual`；Repair Packet 中的允许路径是修改建议，不是 hash 写入许可。代码修改后直接重新运行同一 operation，由当前运行结果判断是否修复。外部设计证据缺失或内容 hash 不匹配仍以 `AIH_SOURCE_INTEGRITY_FAILED` 阻断。每轮修复完成后必须确认现有地址仍可访问；若服务重启，则提供新的实际地址。
13. 当前产物 readiness 全部通过且 Manifest 为当前产物声明了移交边时，必须调用登记的 handoff operation。只有新鲜 `PASS` 凭证允许提示移交；移交不得初始化或编写下游。Manifest 未声明消费者时，在完成运行地址交付并如实报告 residual 后结束当前范围。

## 领域约束

- 每个参与者 Canonical UI Prototype 的静态语义入口和可执行界面共同构成该参与者界面规格唯一事实来源；README 与隐藏 JSON 是生成投影。参与者改名只更新显示名称，不改变稳定 `ACTOR-ID` 目录键。
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
