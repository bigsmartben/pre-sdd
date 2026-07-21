---
name: capture-figma-design-source
description: 将带 node-id 的 Figma 节点采集为 Canonical UI Prototype（规范界面原型）可复现的本地设计来源证据，包括节点上下文、截图、变量、字体、图层参数、Export/ 静态资源、PNG 校验和内容哈希。用户提供 Figma 节点并需要绑定视觉来源、导出标记资源、精准还原或补全来源证据时使用；本技能只采集与封存来源，不决定产品语义、视觉策略或 readiness（就绪）。
---

# 采集 Figma 设计来源

## 边界

本技能是 Figma Source Adapter（Figma 来源适配器），只把用户确认的 Figma 节点转换为 Product Design（产品设计）拥有的 provider-neutral design-source evidence（提供方中立设计来源证据）。开始前必须加载 `$product-design` 与 `$apply-repository-harness`，由 Product Design 提供 `sourceId`、节点链接、覆盖范围和 Manifest 绑定的 Canonical UI Area。

本技能不得选择或改变 `visualPolicy.mode`，不得创建 Screen、Control、State、Use Case 或 Interaction Flow，不得把图层名和视觉外观解释为业务规则，也不得直接判定当前产物 readiness 或执行 handoff（移交）。

需要通过 Figma 文件上下文执行唯一读取或资源导出时，必须先加载 `$figma:figma-use`。Figma 连接器、权限或节点不可用时停止采集，将来源标记为 `blocked`，报告 `AIH_SOURCE_CAPTURE_BLOCKED`；不得根据链接、相邻节点、图层名或截图猜测缺失内容。

## 输入条件

- 只接受 `https://www.figma.com/design/...?...node-id=...` 节点链接。
- 将链接中的 `node-id=123-456` 规范化为证据中的 `123:456`。
- `sourceId`、目标 Screen、State、Viewport（视口）和证据覆盖由 Product Design 提供；本技能不自行扩大设备、页面或状态范围。
- 必须取得第一次人工确认形成的完整 `scopeConfirmation`：确认人和时间、根节点、包含和排除的 Page / Component / Visual Node、Viewport、Scenario、State 及逐类数量。缺少任何范围事实时停止并返回上游范围确认；本技能不得补做或伪造 Scope Confirmation（范围确认）。
- 必须取得第二次人工确认形成的完整 `highImpactConfirmation`：组件抽象提案、有限 State / Variant 轴、资源分类歧义的最终选择、合并后的 Figma 写回清单，以及逐个阻断 Instance 的 Detach 批准。空写回与空 Detach 也必须显式记录；Agent 不得代替用户确认。
- `writebackBoundary` 必须引用两次确认，且操作 ID 与第二次确认一一对应。全部写回完成后才允许冻结节点并执行 `formalCaptureOrdinal: 1` 的唯一一次正式采集。
- 写入路径只从 `psp.project.yaml` 与 Manifest 解析，不根据示例目录猜测。
- 开始采集前必须确认 `$organize-figma-assets`、`$figma-component-from-design` 或其他 Figma 写入已经完成，并冻结本轮节点范围。采集后发生的任何 Figma 节点、变量、组件或图层修改都会使本轮证据失效，必须从同一节点重新采集。
- 临时下载、转换结果和候选清单只能写入本次采集会话创建并记录的操作系统临时目录。清理时只允许删除该会话拥有的目录；不得删除来源不明、其他会话或 Canonical UI Area 内的文件。

## 采集工作流

1. 校验两次人工确认与有限写回边界，再冻结来源节点并生成 Capture Plan（采集计划）。
   - 记录最终节点链接、规范化 `nodeId`、本轮 `sourceId` 和完整确认范围；候选视觉节点不得越出 `scopeConfirmation.includedNodes`。
   - 校验 Scope Confirmation 的逐类数量与清单一致，High-impact Confirmation（高影响确认）引用同一范围，全部写回目标都在确认范围内。
   - 不默认 Detach Instance。只有 `kind: detach-instance` 的具体目标同时出现在 `detachApprovals` 且具有阻断原因时才允许执行；禁止“确认整个 Frame 后全量分离”。
   - 把获批操作合并为一次有限写回批次。操作 ID、完成时间和两次确认身份写入 `writebackBoundary`；没有写回时也登记空操作清单。
   - 读取连接器可验证的来源版本，按 `figma-file-version`、`remote-last-modified` 或 `node-fingerprint` 之一登记 `sourceVersion`。无法取得任何可重复比较的版本值时停止并报告 `AIH_SOURCE_CAPTURE_BLOCKED`。
   - 不在采集过程中整理图层、创建组件、修改变量或执行其他 Figma 写回。
   - 若发现仍需写回，停止采集并返回第二次人工确认；写回清单重新确认并合并执行后，才从头开始唯一一次正式采集。
   - 枚举确认范围内的全部候选视觉节点，不只枚举已有 `Export/*` 标记；每个 `nodeId` 必须且只能选择 `asset`、`dom-css`、`dynamic` 或 `ignored` 一种 strategy（策略）。
   - `asset` 必须预先冻结格式、比例、裁切范围、透明边距、预期尺寸、正式目标路径、专用下载操作和消费目标；`ignored` 必须记录原因。
   - 在本次会话拥有的操作系统临时目录生成符合 `capture-plan.schema.json` 的 Capture Plan。重复节点、未分类节点或缺少 asset 导出参数时以 `AIH_ASSET_CLASSIFICATION_INCOMPLETE` 停止。

2. 读取节点设计上下文。
   - 保存原始节点上下文，不先转写为主观 CSS 结论。
   - 明确记录 Frame 尺寸、图层位置、宽高、约束、自动布局、间距和对齐。
   - 明确记录字体族、字号、字重、行高、字距、文本换行和文本样式引用。
   - 明确记录填充、透明度、描边、圆角、阴影、模糊、渐变、混合模式和效果引用。
   - 明确记录组件、Instance（实例）、Variant（变体）、状态、变量绑定和资源引用。
   - 每个组件相关节点必须显式记录 `name`、`componentKey`、`componentSetNodeId`、`mainComponentNodeId`、`structureSignature` 与 `variantProperties`；连接器明确返回不存在时写 `null`，不得省略字段或用自由文本 `componentId` 代替关系。
   - `structureSignature` 是规范化结构记录的 SHA-256：按子节点顺序保留节点类型、内容角色、容器关系、Slot 边界与嵌套组件边界；排除文字值、颜色、尺寸、坐标和 Variant 当前值。相同规范化结构必须得到相同签名，结构不同必须得到不同签名。
   - `instance` 必须解析到 `mainComponentNodeId`；无法解析时保留来源缺口并报告 `AIH_SOURCE_CAPTURE_BLOCKED`，不得把未绑定实例交给组件映射门禁。

3. 获取同一节点截图。
   - 使用用户确认的节点、Viewport 和设备像素比。
   - 截图作为来源一致性机器比较和人工复核基线，不得登记为页面实现资源。

4. 读取变量和字体。
   - 保存节点可用的设计变量定义；连接器明确返回无变量时保存空结果。
   - 只有节点实际使用的变量才能交给 Product Design 映射为 `tokens`，不得凭截图发明变量名。
   - 字体不可访问时记录缺口，不得静默替换后仍声明来源一致。
   - 已存在的 Code Connect（代码连接）映射可以保存为 `code-connect-map` 证据；本技能不得创建 `.figma.ts` 文件，也不得要求组件已经发布。

5. 下载并验证来源资源候选。
   - 只下载 Capture Plan 中 `strategy: asset` 的节点；不得把已有 `Export/*` 标记当作完整候选清单。
   - 为每个目标记录来源节点、预期格式、资源用途和目标 Screen 或 Component。
   - 优先复用 Figma 已有 SVG、PNG、组件 Artwork（视觉作品）和复杂效果资源。
   - SVG 用于需要无损缩放的矢量；需要透明度的位图使用 PNG。
   - 动态文字、用户数据、真实控件和交互结构不得栅格化。
   - 复杂视觉资源应保留透明边距、裁切范围、导出比例和来源节点引用。
   - 页面或组件的完整截图不得伪装成 `asset` 资源。
   - 使用 Figma 专用资源下载能力把候选文件写入本次会话拥有的操作系统临时目录；采集阶段不得直接写 Canonical UI Area、模板、`dist/` 或 `.vite/`。
   - 生成符合 `acquisition-packet.schema.json` 的 Acquisition Packet（采集包），逐项登记 Capture Plan 哈希、来源版本、下载操作、相对临时路径、正式目标路径、格式、比例、裁切、透明边距、尺寸和 SHA-256。
   - 对要求透明背景的 PNG 运行：

     ```text
     node .agents/skills/capture-figma-design-source/scripts/validate-png-assets.mjs <png>...
     ```

   - PNG 缺少可见内容或真实透明像素时以 `FAIL` 停止；可见内容接触边缘时必须人工确认是否发生裁切。
   - 每个 `asset` 证据项必须登记 `sourceNodeId`、`assetKind`、`captureScope` 和 `containsDynamicContent: false`；`captureScope` 只允许单个 `layer` 或不包含动态内容的 `artwork-subtree`。

6. 执行受控 Asset Ingest（资源导入）。
   - 调用 Manifest 登记的 `ingest-figma-assets` operation：

     ```text
     npm run ingest:figma-assets -- --actor ACTOR-NNN --capture-plan <temp-plan> --acquisition <temp-packet>
     ```

   - Operation 必须先完整校验两个 Packet、临时目录边界、唯一分类、来源版本、格式、比例、裁切、透明边距、实际尺寸、SHA-256 和目标冲突，再写入 `public/assets/<source-id>/`、正式 Capture Plan 与 Ingest Receipt（导入回执）。
   - 任一检查失败时不得产生正式 Asset；保留 `AIH_ASSET_MISSING`、`AIH_ASSET_HASH_MISMATCH`、`AIH_ASSET_CLOSURE_FAILED` 或 `AIH_ASSET_INGEST_CONFLICT`。

7. 封存正式来源证据。
   - 原始上下文、截图和变量写入 `design-sources/<source-id>/`。
   - 可执行界面需要的导出资源写入 `public/assets/<source-id>/`。
   - 生成 `evidence.json`，记录规范化 `nodeId`、`sourceVersion`，并为每个文件记录 Area 相对 POSIX 路径、角色和 `sha256` 内容哈希。
   - 正式 Capture Plan 与 Ingest Receipt 必须分别以 `role: capture-plan`、`role: ingest-receipt` 出现在同一来源的 `evidence.json` 中，并登记各自 Schema 与 SHA-256。
   - 每个导出资源必须以 `role: asset` 出现在同一来源的 `evidence.json` 中，并完整登记 Ingest Receipt 的导出参数、下载操作、消费目标和状态；只存在于 `public/assets/` 或 `canonical-ui.ts.assets` 不构成来源证据。
- `design-context` 必须符合本技能拥有的 `figma-design-context.schema.json`，并在证据项的 `schema` 字段登记其 `$id`。
- Schema 要求明确登记 geometry、typography、paint、effects、components 和 assets 六类参数检查结果；只保存一张截图不构成完整 Figma 证据。
- `components` 中的 Component Set、Main Component 与 Instance 关系必须闭合；同一 `nodeId` 不得重复，Instance 引用的 Main Component 必须存在于本次 `design-context`。
   - 所有文件落盘后重新计算每个证据项哈希，再计算最终 `evidence.json` 哈希；未完成最终清单哈希前，证据状态不得标记为 `available`。
   - 完成哈希后再次读取或计算同一种 `sourceVersion`；若与步骤 1 不一致，丢弃本次会话拥有的候选结果并重新扫描、重新完成两次人工确认后采集，不得登记混合版本证据。

8. 生成登记包并交回 Product Design。
   - 使用 Canonical UI Artifact Contract（产物契约）登记的 `design-source-evidence.schema.json` 校验证据清单。
   - 在本次会话拥有的操作系统临时目录中生成符合 `source-registration.schema.json` 的 Registration Packet（登记包），包含 `sourceId`、`sourceVersion`、证据清单、正式 Capture Plan、Ingest Receipt、已验证资源事实和显式缺口。
   - 返回登记包路径、来源状态、变量和字体；由 Product Design 校验登记包后，将来源、最终 `designSources[].evidence.sha256`、资源和使用目标写入 `canonical-ui.ts`。
   - 本技能不得直接编辑 `canonical-ui.ts`，不得创建 Canonical UI Asset ID，也不得决定视觉覆盖或来源一致性断言。
   - Product Design 登记的 `canonical-ui.ts.assets[*].sourceIds` 只能引用证据清单中包含同一路径的来源；禁止先登记资源事实、后补来源证据。
   - 执行 Resolver 返回的全部验证命令；资源文件、证据项、清单哈希或使用目标不一致时保留 `AIH_SOURCE_INTEGRITY_FAILED` 或原始 blocker code（阻断码）。

## 完成条件

- 节点链接与证据 `nodeId` 一致。
- 同时存在通过哈希校验的 `design-context` 与 `screenshot` 证据项。
- 设计上下文包含可用于实现的明确尺寸、排版、形状、效果和资源参数。
- 截图基线没有作为页面或组件资源使用。
- 动态内容和交互结构没有被错误栅格化。
- 所有导出资源均存在对应 `role: asset` 证据项，文件哈希和最终清单哈希匹配。
- 确认范围内每个候选视觉节点在正式 Capture Plan 中只有一个 strategy；每个 `asset` 节点在 Acquisition Packet、Ingest Receipt、证据项与正式文件中一一对应。
- 透明 PNG 包含可见内容和真实透明像素，边缘裁切风险已经确认。
- `sourceVersion` 在 `design-context`、`evidence.json` 和 Registration Packet 中完全一致。
- Registration Packet 已通过 Schema 校验，资源候选均引用同一证据清单中的 `role: asset` 项。
- 所有下载和候选验证只发生在操作系统临时目录，正式写入只由 `ingest-figma-assets` operation 完成。
- 最终证据采集时间晚于本轮全部 Figma 写入；后续发生 Figma 写入时不继续复用旧证据。
- 两次人工确认、有限写回和正式采集顺序可由 Capture Plan 机器校验；范围变化、来源版本变化或冻结后的写回都必须废弃本轮计划并重新确认、重新采集。
- 来源不可访问或参数缺失时保留明确 gap 和原始 blocker code（阻断码）。
- 没有新增 Python 或其他运行依赖。
