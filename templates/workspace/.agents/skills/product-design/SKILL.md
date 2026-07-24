---
name: product-design
description: 在 PSP 仓库中编写、审查或验证原子 Use Cases、provider-neutral Visual Spec 或 Canonical UI Prototype 时使用，包括维护产品行为与正式状态、形成不依赖设计提供方的确定视觉输入，以及将视觉规格与产品语义汇合为可执行界面原型。该领域 Skill 拥有领域工作流、Contract、Schema、模板、渲染器、领域 Validator 与浏览器验收，并将 Figma 来源处理、正常 HTML/Lit 实现和实现修复分别路由到独立技能；通过项目绑定和 Harness 完成输入输出治理、工程门禁与 handoff，不补写未就绪的上游事实，也不定义下游平台映射。
---

# Product Design

## 边界

本 Skill 是 Product Design Domain（产品设计领域）的仓库级封装，拥有产品设计工作流和本目录中的领域资源。Harness 只拥有输入输出绑定、路径与 Scope、工程命令、依赖、生命周期、阻断码协议和确定执行的 handoff；不要把产品语义写入 Harness。

## 资源路由

只读取当前产物所需资源：

- Atomic Use Cases（原子用例）：`capabilities/contract.yaml`、`capabilities/schema.json`、`capabilities/template.yaml`；`use-cases.yaml` 同时拥有 Product Behavior、与 UC 步骤可追溯的正式 Interaction Flow、以及内部 Low-Fi UI Blueprint；`UC.md` 是从 YAML 确定生成的唯一人类视图。非 UI 用例必须显式 `not-applicable`，UI 用例必须同时具备完整流程与 Low-Fi 建议
- Interaction Flow 拥有状态、迁移、Guard、分支、重试、恢复与返回；用户动作、系统响应、失败语义从所追溯的 Use Case 场景步骤派生，不重复手填。Low-Fi UI Blueprint 表达 IA、Screen、Region、Layout 与 Control 建议；交互 Control 通过 `transitionRefs` 追溯正式 Transition，但不构成 Screen、Control、路由、组件或 DOM 的实现约束
- Visual Spec Intake（视觉规格输入）：`visual-spec/contract.yaml`、`visual-spec/schema.json`、`visual-spec/template.yaml`；`visual-spec.yaml` 是提供方中立的机器权威模型，固定 Runtime、Viewport、Page、Rendering、Layout、Typography、Paint、Effect、组件状态 × Variant 完整组合，以及资源路径、来源版本和 SHA-256；`Visual-Spec.md` 是只读用户投影
- UI HTML：`canonical-ui-prototype/contract.yaml`、`canonical-ui-prototype/schema.json` 与 `canonical-ui-prototype/template/`；`Canonical-UI-Prototypes/<ACTOR-ID>/` 消费同 Actor 的 ready UC 与 ready Visual Spec，并在 `draft.inputs` 固定两者版本和内容哈希。HTML、CSS、组件与资源共同构成用户 Artifact；`canonical-ui.ts` 只保留机器索引和实现映射，不是独立用户 Artifact。`dist`、Review 地址与过程证据由运行器和 Validator 管理，不是新的 SSOT（唯一事实来源）
- 来源整理：Canonical UI 任务开始时必须读取 `references/input-mapping.md`、`references/source-reconciliation.md` 与 `references/visual-validation.md`
- Figma 工作流：`designSources[].kind` 为 `figma` 时，本 Skill 提供 `sourceId`、业务范围、视觉策略、Canonical UI Area 并记录两个人工决策点，再路由到 `$figma-workflow`；本 Skill 校验其 Component Abstraction Proposal、Capture Plan、Ingest Receipt 与 Registration Packet（登记包），并拥有 `canonical-ui.ts` 的来源、Asset Manifest（资源清单）、组件契约和消费目标登记，不复制 Figma 连接器操作、节点写回、采集或资源下载步骤
- 正常实现：本 Skill 准备并登记产品语义、视觉策略、来源证据和 `canonical-ui.ts` 后，将首次创建及 Reopen、上游版本或正式规格变化后的 HTML、CSS 与 Lit 实现统一路由到 `$implement-canonical-ui`。该技能覆盖 `autonomous`、`guided`、`exact` 和 `figma`、`screenshot`、`export`、`other` 来源；只有 Figma 来源需要先经过 `$figma-workflow`
- 组件实现契约：所有视觉模式和来源类型都必须在 `canonical-ui.ts` 中为每个 Canonical Component 登记唯一 Component Contract（组件契约）、State Matrix（状态矩阵）、页面实例与实现路径；Figma 范围再额外登记 Component Inventory（组件清单）、Figma ↔ Lit Component Mapping（组件映射）、Variant Definition 与 Usage Coverage。`/__review/components` State Gallery（状态画廊）由同一矩阵生成
- Review Shell 提供中性的 Review Extension Host（评审扩展宿主）与公开 DOM 身份标记；`canonical-ui.ts.reviewTools` 只声明不一致标记、MockCase 切换器和交互分支驱动器的 Review Tool 分类、单一 URL 开关与排除边界。它们不属于真实产品需求、功能、页面、控件或下游实现范围，不得修改 Use Case、Interaction Flow 或 Visual Spec 的产品事实；可选旁路扩展的领域模型、运行事务、工具 UI 和证据仍不属于 Product Design
- 运行预览：UI 可运行后调用 Manifest 登记的 `canonical-ui-dev` Preview Operation（预览操作），读取它输出的 `?review=0` 真实 HTTP 地址并立即交给用户。该地址只是正式产品 UI 的临时预览入口，不是正式 Review Evidence（评审证据），不以前置修复或正式 readiness 为条件
- 正式评审：正式 Review、Feedback Packet（反馈包）路由、Publish 与 Reopen 生命周期由本 Skill 拥有；`canonical-ui-review` 只在用户结束反馈且登记门禁通过后生成 Review Evidence，不能由临时预览地址替代
- 组件契约测试：`test:canonical-ui-components` 使用 Playwright 隔离页面从 Component Contract 与 State Matrix 生成 Property、Attribute、Slot、Variant、Event、状态、可访问名称、焦点、Disabled 与 ARIA 测试，不维护第二份测试清单
- 增量校验：普通实现迭代可调用 `validate:canonical-ui-incremental -- --actor <ACTOR-ID> --changed-path <Area 内路径>`；它使用 `implementationPaths`、Asset 消费目标和页面映射选择受影响 Component/Route/State/Viewport，缓存只写操作系统临时目录。正式 readiness、Review 与 Publish 必须继续使用完整 Profile
- 实现修复：用户明确请求后调用 `canonical-ui-repair --new-session`；返回 `AIH_UI_REPAIR_REQUIRED` 时路由到 `$repair-canonical-ui`，本 Skill 不复制具体 HTML、CSS 或组件修改算法
- 可执行能力：渲染器和 Validator 位于 `scripts/`；Canonical UI 专用投影与浏览器能力位于 `canonical-ui-prototype/scripts/`

## 工作流

1. 读取 `AGENTS.md`、`.psp/harness/HARNESS.md`、`psp.project.yaml` 和项目绑定的 Manifest。
2. 使用 `$apply-repository-harness` 解析用户明确请求的当前产物、实际路径、上游依赖与初始化状态。Resolver 返回 `BLOCKED` 时停止目标写入并报告原始阻断码。
3. 从 Manifest 登记位置读取当前产物的 Contract、Schema 和模板；不得从目录名推断用户产物路径，不在本文件复制字段定义。
4. 编写 Visual Spec 或生成、修改 Canonical UI Prototype、UI HTML、CSS、界面组件前，先确认界面主要在哪里使用。若用户已经明确说明则直接采用；否则必须先用日常说法给出可直接选择的答案，例如“电脑网页（推荐）”“15 寸平板”“手机”“我说具体设备”。平板只在需要时继续问“横屏”或“竖屏”。确认前停止视觉规格或界面写入，不先做草稿。
5. 同一次确认中只问与本次范围有关的附加项。默认只做用户选中的运行环境，不自动增加手机、电脑、响应式、多尺寸或横竖屏适配；键盘操作、读屏、焦点、触控尺寸和减少动画等额外检查也不默认启用。需要询问时使用“要不要额外检查键盘操作和读屏等使用方式？不需要（推荐）/需要”这类普通说法，不向用户抛出标准编号或校验器名。
6. 写界面前必须先确定 `visualPolicy.mode`。无视觉输入使用 `autonomous`（自主设计）；用户明确说风格参照、局部参照或只参考部分内容时使用 `guided`（部分参考）；用户提供完整 Figma Frame（画框）、整页截图或明确要求视觉还原时默认使用 `exact`（完全实现）。只有用户明确说“仅作风格参考”才能把完整视觉输入降为 `guided`。视觉输入含义不明确时先确认，保持 `unresolved` 并停止界面写入。用户显式调用 Repair operation 即构成一次 Agent 修复授权，不把授权状态写入 Canonical UI 模型。
7. 业务语义始终遵循已就绪的原子 Use Case：目标、权限、业务规则、正式状态和分支来自 `use-cases.yaml`，`UC.md` 只供人类阅读。Visual Spec 必须引用这些稳定 UC 与 Interaction State 身份；缺失或未就绪时以 `AIH_UPSTREAM_NOT_READY` 阻断，不得静默补写。Canonical UI 同时消费当前 `ACTOR-ID` 的 UC、Interaction Flow 和已就绪 Visual Spec；Low-Fi UI Blueprint 只作建议，允许按可用性拆分或合并 Screen 与 Control，但必须保持正式行为可达，并保留可观察结果与恢复路径。
8. 只将 source-backed facts（有来源支撑的事实）和用户刚确认的界面范围写入当前产物。来源可来自 Figma、Design System、资源文件或用户输入，但正式 Visual Spec 必须统一转换为 provider-neutral 结构；每个资源固定 `assets/` 相对路径、来源 ID、来源版本、Role、使用位置和 SHA-256。Figma 来源必须调用 `$figma-workflow` 并校验其登记包，再写入 Visual Spec；连接器字段和节点操作不得泄漏为 Visual Spec 的提供方专用执行协议。上游缺失、来源矛盾、连接器不可用或证据不足时记录 gap，不得补写 Use Cases 或 Interaction Flow。
   - 第一次人工确认前只扫描 Page、Component、视觉候选节点、目标 Viewport、主要 Scenario 和 State；向用户展示包含项、排除项、数量、名称和 Node ID。用户确认后冻结 `scopeConfirmation`，扩大范围必须重新确认。
   - 冻结范围内生成组件抽象提案、有限 State / Variant 轴、资源分类歧义和拟写回影响，再取得独立的 `highImpactConfirmation`。Agent 不得代替用户确认范围或高影响抽象。
   - 默认不执行全范围 Detach Instance；只有用户逐个批准且记录阻断原因的具体 Instance 可进入有限写回。所有获批 Figma 写回必须合并执行，全部结束后才允许进行一次正式来源采集。
   - 范围变化、来源版本变化或冻结后的任意 Figma 写回都会确定性废弃 Capture Plan、来源证据及下游登记，必须回到范围扫描并重新完成两次确认。
   - 首次 UI HTML、CSS 或组件代码写入前，必须验证确认范围内每个视觉候选只有一种 strategy，且全部 `asset` 节点已经通过受控 Ingest。
   - `canonical-ui.ts.assets` 必须逐项登记 `sourceNodeId`、`sourceVersion`、`strategy`、格式、比例、裁切、透明边距、预期尺寸、SHA-256、下载操作、消费目标和 `verified` 状态，并与 Capture Plan、Ingest Receipt 和来源证据双向闭合。
   - 未分类、缺少文件、哈希不一致或闭包不完整时分别保留 `AIH_ASSET_CLASSIFICATION_INCOMPLETE`、`AIH_ASSET_MISSING`、`AIH_ASSET_HASH_MISMATCH` 或 `AIH_ASSET_CLOSURE_FAILED`，不得先写代码后补证据。
   - Figma `design-context.components` 中每个节点必须在 `componentInventory` 中得到且只得到一个决定：`shared-component`、`primitive-only` 或 `local-structure`。
   - `shared-component` 必须绑定一个 Canonical Component、一个 Figma ↔ Lit 映射、一个 Component Contract，以及覆盖全部使用中 Instance 的 Variant 覆盖行。Contract 必须完整声明 Lit Tag、Slot、Property、Attribute、Event、默认矩阵状态和页面实例。
   - `stateAxes` 必须把 Variant、Runtime State、Interaction State 与 Content Override 分成不同机器类型并列出有限值；`stateMatrix` 必须对全部笛卡尔组合逐项标记为 `legal`、`mutually-exclusive` 或 `unreachable`。只有合法组合可进入 State Gallery，默认状态也必须合法。
   - 每个 Contract 的 `implementationPaths` 是增量影响分析的唯一组件代码归属；共享入口、未知路径或未登记 Asset 变化必须保守失效全部相关 Route，不得猜测后跳过门禁。
   - 语义职责与复用决定来自用户确认；Component Key、Component Set、Main Component、Instance 与 Variant 属性来自最终 Figma 证据。二者缺一时以 `AIH_COMPONENT_ABSTRACTION_UNRESOLVED` 停止实现。
   - 所有模式在路由到 `$implement-canonical-ui` 前，都必须只读核对当前入口、Router、已注册 Lit Tag、App/Feature Shell、共享布局、样式 Token、状态与 Mock 层。已有组件可满足公开接口时，Contract 必须沿用其 `litTagName` 与 `implementationPaths`；不得通过登记近义新组件来规避复用。
   - 每个 Screen 必须由一个统一 App Shell 或 Feature Shell 承载；该 Shell 必须作为 Canonical Component 进入 Component Contract，并通过 `pageInstances` 与 Screen 闭合。出现多个候选根或现有 Router 与 Contract 不一致时保留 gap，不得把选择权下放给实现技能。
   - Token 必须用 `targetIds` 和 `cssProperty` 绑定消费范围；同一设计语义已有 Token 时不得登记近义变量或允许实现使用字面量旁路。布局、字体、颜色、间距、圆角和阴影的复用事实来自 Visual Spec 与 Token，不由实现者重新设计。
   - 只有现有组件、Shell、布局/样式基础件和 Slot 组合都不能满足正式语义时，才登记新 Component Contract；新增 Router、全局状态、API/Mock 层、样式根或依赖必须先成为明确的上游决定。
9. 对原子 Use Cases 和 Visual Spec，先在工作区外分别准备完整候选 YAML，再使用各自 Manifest operation。`apply-product-artifact` 原子更新 `use-cases.yaml` 与 `UC.md`；`apply-visual-spec` 在确认 Use Cases 已就绪并解析候选引用后，原子更新 `visual-spec.yaml` 与 `Visual-Spec.md`。`--dry-run` 只预检 Schema、上游和目标路径；不得直接编辑目标，也不得在日常更新中运行 `render:product`。旧参与者 Wireflow 目录只允许作为 Use Cases 一次性迁移输入。Canonical UI Prototype 仍按每个参与者应用的 TypeScript 权威入口与专用投影规则执行。
10. 创建或更新 UI HTML Draft 前，先运行 UC 与 Visual Spec 的严格门禁；两者必须为 `ready` 且无 gap。把它们的 `metadata.version` 与权威文件 SHA-256 写入每个 Actor 的 `draft.inputs`。任何版本或内容变化都以 `AIH_CANONICAL_UI_INPUT_DRIFT` 阻断，不得继续沿用原 Draft。完成当前 Draft 的语义、视觉策略与来源登记后，统一调用 `$implement-canonical-ui` 执行首次或规格驱动的正常实现；`unresolved` 不得写实现，非 Figma 路径不得被 Figma Capture Plan、Mapping 或 Instance 身份阻断。
11. 每个正式 Interaction Transition（交互迁移）必须被 `scenarios[].transitionIds` 覆盖；有 `failureResponse.returnToState` 的失败分支还必须有场景声明并实际运行 `recoveryStateIds`。所有正式状态、分支、返回/恢复路径和使用中的组件 Variant 都要通过浏览器门禁；浏览器还必须验证 `/__review/components` 精确呈现所有合法 State Matrix 组合。
12. UI HTML 与已确认交互达到可运行状态后，立即调用 Manifest 登记的 `canonical-ui-dev` Preview Operation 并读取其 `?review=0` 真实 HTTP 地址，把可点击地址提供给用户；这一步不得等待视觉修复、Product strict Profile 或正式 readiness。URL 只允许 `review` 一个 Review 开关：未设置或 `review=0` 不加载 Review Tool，正式 Review、MockCase 和场景门禁使用 `review=1`。不得根据默认端口猜测或伪造地址；服务未启动、地址未输出或无法访问时以 `AIH_CANONICAL_UI_SERVER_FAILED` 阻断。地址交付后暂停正式 Review，等待用户发送 Feedback Packet，或明确表示结束反馈并生成正式 Review。
13. 地址交付后执行 Resolver 返回的门禁，并接收标记工具按页面导出的 Schema 有效 Feedback Packet。`interaction` 路由到 Use Cases，`visual` 路由到 Visual Spec，`position-size` 与 `text` 路由到 Canonical UI 实现。Feedback Packet 只是用户反馈，不是 Repair Packet，也不构成 Repair 授权。实现反馈必须先运行登记门禁：能形成机器可判定 Repair Diagnostic 时，等待用户明确请求后调用 `canonical-ui-repair --new-session` 并路由到 `$repair-canonical-ui`；不能形成有效 Repair Packet 时保留为未解析反馈，要求补充 Visual Spec 或确定性预期，不得主观修改。`exact` 的整页像素比较只生成 `AIH_VISUAL_PIXEL_DIAGNOSTIC` 非阻塞诊断，不作最终裁决；多轮修复机制已废弃。
14. 只有用户明确表示结束反馈并要求生成正式 Review，且修复和固定 Review Profile 全部通过后，才调用 Manifest 登记的 `canonical-ui-review` operation，并为每个页面重复传入 `--feedback <packet.json>`。它验证 Packet Schema、Actor、Draft 版本和固定路由，使用 Validator 返回的真实本地地址与机器截图，把 Draft、源码哈希、构建输入哈希、Packet 哈希和结构化 Marker 绑定成 Review Evidence 2.0.0。没有反馈时写入空 `feedbackPackets` 与 `markers`。Review Marker、用户 PNG、机器截图和 Review Evidence 都只是过程证据，不得成为平行规格；用户 PNG 不替代正式机器截图。
15. `exact` Review 通过后，必须由用户亲自调用 `accept-canonical-ui-visual` 并提供 `--accepted-by user:<identity> --confirm HUMAN_VISUAL_ACCEPTED`。Agent 不得代填或代执行。来源版本、实现、Asset、确认范围、Component Contract、State Matrix 或 Review 变化会使记录确定性变为 `stale`。
16. Review 通过后只报告“可发布”并停止；只有用户另行明确请求 Publish 时才调用 `publish-product-design`。Publish 会再次执行完整固定 Profile；`exact` 还必须匹配当前 Human Visual Acceptance，`autonomous` 与 `guided` 不新增人工视觉接受。随后同一事务写入 01 发布凭证、把阶段改为 `published`，锁定 UC、Visual Spec、Asset、UI HTML 源码、构建输入、Review、视觉接受版本和 01 阶段身份。成功返回 `downstreamAction: NOT_RUN`；不得自动初始化 02、调用外部平台或执行 handoff。
17. `published` 只允许读取和校验；Resolver、产物事务与 Repair 统一以 `AIH_STAGE_LOCKED` 拒绝修改。任何手工漂移都会让原凭证以 `AIH_PUBLISH_CREDENTIAL_STALE` 稳定失效。需要变更时先调用 `reopen-product-design`，再创建更高的新 Draft 版本、重新 Review 和 Publish；不得覆盖原发布历史。

## 领域约束

- 每个参与者的可执行 UI HTML 是界面 Artifact；`canonical-ui.ts` 是该应用内部的机器索引和实现映射，隐藏 JSON 只是生成支撑，不得把它们提升为独立用户 Artifact。参与者改名只更新显示名称，不改变稳定 `ACTOR-ID` 目录键。
- `autonomous` 允许 Agent 自主确定视觉；`guided` 只约束 `visualPolicy.aspects` 与 `coverage` 声明的部分；`exact` 要求所有已确认路由、场景和视口都有来源截图一致性门禁。不得把 `exact` 描述成视觉灵感或重新设计任务。
- `repairPolicy` 只登记当前应用的建议实现路径；单次尝试、可修复缺陷和门禁由 Artifact Contract 与 Manifest 唯一拥有。`autonomous`、`guided`、`exact` 均可在显式调用后进入一次 HTML/CSS/Lit 修复，`exact` 额外执行完整来源一致性。Repair Packet 与 Repair Action Report 位于操作系统临时目录，只作为 Agent 修复证据，不写入用户产物。
- 提供方连接器只负责生成来源证据，不拥有产品语义、视觉策略、readiness 或 handoff；Figma 写回、正式采集和 Code Connect（代码连接）由 `$figma-workflow` 负责。
- Visual Spec 是提供方中立的视觉交接唯一事实来源；Figma、Design System、资源文件和用户输入只是来源类型，不能把各自的采集步骤、插件字段或 Agent 修复循环写进正式模型。
- 具体 Screen、Component、State、Event、Action、追溯、视觉和无障碍规则只由本 Skill 内的 Contract、Schema 与 Validator 定义。
- 组件抽象的机器事实只由 Canonical UI Contract、Schema 与 Validator 定义；Figma 工作流提出模型并采集最终身份，`$implement-canonical-ui` 只在 Figma 分支消费映射，均不得另建平行事实来源。
- Component Contract 同时拥有复用边界：`implementationRole` 明确 App Shell、Feature Shell、共享组件、布局基础件或页面局部结构，`litTagName` 决定组件身份，`pageInstances` 决定页面使用，`implementationPaths` 决定代码所有权，Token `targetIds`/`cssProperty` 决定样式绑定。每个 Screen 必须且只能有一个 `app-shell` Page Instance；正常实现只能消费这些决定，不得创建等价组件、平行 Shell、重复 Router、状态层、API/Mock 层或样式根。
- `viewports` 只登记用户确认的运行环境；`accessibility` 只登记用户明确选择的额外检查。字段未声明时，Validator 不得代替用户增加默认检查。
- `canonical-ui-dev` 输出的 `?review=0` HTTP 地址是当前运行会话的临时正式预览入口；它不是正式 Review Evidence，不写入 `canonical-ui.ts`、README 或隐藏 JSON，也不作为产品事实。
- Feedback Packet 只记录用户在临时预览中的结构化反馈；它不是 Repair Packet、正式规格或发布授权。每次正式 Review 只消费当前 Actor 与 Draft 的 Packet，过期 Packet 以 `AIH_CANONICAL_UI_FEEDBACK_STALE` 阻断。
- 不从实现便利性、Figma 图层名或现有代码反推产品事实。
- 不定义 SwiftUI、Android、生产 Web 映射或代码生成规则。
- 不把单项结构校验、构建成功或视觉抽查等同于交付 readiness。

## 交付

按 Manifest 的 evidence report 规范报告 Scope、Changes、Validation 和 Residuals。正式产物、机器投影与临时运行证据必须保持各自的输入输出角色。
