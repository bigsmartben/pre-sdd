# Figma 最终来源采集

## 目录

- [输入门禁](#输入门禁)
- [Capture Plan](#capture-plan)
- [设计上下文](#设计上下文)
- [截图变量与字体](#截图变量与字体)
- [资源采集与导入](#资源采集与导入)
- [证据封存](#证据封存)
- [登记包](#登记包)

## 输入门禁

开始正式采集前校验：

- Figma 链接包含 `node-id`，并把 `123-456` 规范化为 `123:456`。
- `sourceId`、Canonical UI Area、Screen、Viewport、Scenario、State 和证据覆盖由 Product Design 提供。
- `scopeConfirmation` 完整记录扫描时的 `sourceVersion`、根节点、`scanInventory`、`screenBindings`、包含项、排除项、逐类数量、确认人和时间；包含与排除项必须精确分区扫描清单。
- 对每个 `(screenId, figmaRootNodeId)` 分组，`screenBindings` 必须恰好包含 `scopeConfirmation.viewportIds × scopeConfirmation.scenarioIds` 的每个组合一次；组合缺失、重复或引用范围外的 Viewport、Scenario、Figma Root、State 时停止。
- `highImpactConfirmation` 重新读取并固定同一 `sourceVersion`，通过 `scopeConfirmationSha256` 引用同一范围，包含组件抽象、有限 Variant、资源歧义、写回清单和逐个 Detach 批准。
- `writebackBoundary` 通过 `highImpactConfirmationSha256` 绑定第二次确认，操作 ID 与高影响确认一一对应，记录写回前后来源版本，全部写回早于冻结时间。
- 节点已冻结，`formalCapture={ordinal:1,startedAt,completedAt,sourceVersionBefore,sourceVersionAfter}`；正式采集前后版本都必须等于最终 `sourceVersion`。
- 可以取得 `figma-file-version`、`remote-last-modified` 或 `node-fingerprint` 之一作为可比较的 `sourceVersion`。

缺少任何事实时停止并返回 Product Design 或写回阶段，不得补做、猜测或伪造确认。

两次确认的 `sha256` 都按同一规则重算：复制完整确认对象，只移除该对象自身的 `sha256` 字段，使用 RFC 8785 JSON Canonicalization Scheme（JSON 规范化方案）编码为 UTF-8，再计算 SHA-256 并加 `sha256:` 前缀。对象键顺序不影响结果，数组顺序保留；候选提交确认前先稳定排序集合型数组。确认人、确认时间、ID、来源版本和全部业务内容都进入哈希。

临时下载、转换结果和候选 Packet 只能写入本次会话创建并记录的操作系统临时目录。只清理该会话拥有的目录，不得删除来源不明、其他会话或 Canonical UI Area 内的文件。

## Capture Plan

在会话临时目录生成符合 `capture-plan.schema.json` 的 Capture Plan：

- 枚举确认范围内全部候选视觉节点，不只枚举已有 `Export/*` 标记。
- 每个 `nodeId` 必须且只能选择 `asset`、`dom-css`、`dynamic` 或 `ignored` 一种 strategy。
- `asset` 必须冻结格式、比例、裁切范围、透明边距、预期尺寸、正式目标路径、专用下载操作和消费目标。
- `ignored` 必须记录原因。
- `candidateVisualNodes.nodeId` 必须与 `scopeConfirmation.includedNodes[kind=visual]` 完全相等，既不得越界也不得遗漏。
- `componentProposals[].nodeIds` 分组必须互斥，并集与 `scopeConfirmation.includedNodes[kind=component]` 完全相等；每项包含组件边界、尺寸行为和接口提案。
- 重复、未分类、缺少导出参数或确认引用不闭合时以 `AIH_ASSET_CLASSIFICATION_INCOMPLETE` 或 `AIH_SOURCE_CAPTURE_BLOCKED` 停止。

采集过程中不得整理图层、创建组件、修改变量或执行任何 Figma 写回。发现仍需写回时废弃本轮计划，重新执行整个工作流。

## 设计上下文

先加载 `$figma:figma-design-to-code` 并调用 `get_design_context`，把原始响应单独落盘并计算原始字节 SHA-256，不先转写为主观 CSS 结论。规范化 Design Context 的 `rawCapture` 必须记录 `provider`、`operation`、请求节点、采集时间、来源版本、Capture Plan 哈希、原始文件路径和哈希：

- geometry：Frame 尺寸、位置、宽高、约束、Auto Layout、间距和对齐。
- typography：字体族、字号、字重、行高、字距、换行和文本样式引用。
- paint：填充、透明度、描边、圆角和渐变。
- effects：阴影、模糊、混合模式和效果引用。
- components：Component Set、Main Component、Instance、Variant、变量绑定和资源引用。
- assets：视觉候选、strategy、来源节点和使用目标。

设计上下文必须符合 `figma-design-context.schema.json`，并明确记录六类参数的检查结果。

每个组件相关节点必须记录 `name`、`componentKey`、`componentSetNodeId`、`mainComponentNodeId`、`structureSignature` 与 `variantProperties`；连接器明确返回不存在时写 `null`。Instance 还必须记录 `screenRootNodeId`，解析到本次上下文中的 Main Component，并沿 Capture Plan 的 `screenBindings` 解析到唯一 Product Screen，否则停止登记。

`componentSetCatalog` 必须为每个 Component Set 恰好登记一个 Catalog，包含全部轴、每个轴的有限值和全部 `definitionNodeIds`。Definition 的 Variant 属性必须恰好覆盖 Catalog 轴，值必须属于 Catalog，属性组合不得重复；Catalog 值集合必须与全部 Definition 的实际值集合一致。Instance 必须解析到同一 Set 中、具有相同 Variant 属性的 Main Component。允许 Figma 使用稀疏组合，不要求轴值笛卡尔积中的每个组合都存在。

`structureSignature` 使用规范化结构的 SHA-256：按子节点顺序保留节点类型、内容角色、容器关系、Slot 边界和嵌套组件边界；排除文字值、颜色、尺寸、坐标和当前 Variant 值。

## 截图变量与字体

- 使用确认的同一节点、Viewport 和设备像素比获取截图。
- 截图只作为来源一致性基线，不得登记为页面或组件实现资源。
- 保存节点实际可用的变量定义；明确无变量时保存空结果，不得从截图发明变量名。
- 记录节点实际使用的字体；字体不可访问时保留缺口，不得静默替换后声明来源一致。
- 已存在的 Code Connect 映射可以保存为 `code-connect-map` 证据；不得创建 `.figma.ts` 文件或要求组件已经发布。

## 资源采集与导入

只下载 Capture Plan 中 `strategy: asset` 的节点：

- SVG 用于无损缩放矢量；需要透明度的位图使用 PNG。
- 动态文字、用户数据、真实控件、交互结构和完整页面截图不得作为 Asset。
- Capture Plan、Acquisition Packet、Ingest Receipt、Evidence 与 Registration Packet 都必须逐项记录并闭合 `sourceNodeId`、`assetKind`、`captureScope`、格式、比例、裁切、透明边距、预期尺寸、用途和 `containsDynamicContent: false`。
- `captureScope` 只允许单个 `layer` 或不含动态内容的 `artwork-subtree`。
- 下载结果只写会话临时目录，并生成符合 `acquisition-packet.schema.json` 的 Acquisition Packet。
- `downloadedAt` 必须位于 `formalCapture.startedAt` 与 `formalCapture.completedAt` 之间；正式 Design Context、Ingest Receipt 和 Evidence 也使用同一时间边界。

对要求透明背景的 PNG 运行：

```text
node .agents/skills/figma-workflow/scripts/validate-png-assets.mjs <png>...
```

PNG 缺少可见内容或真实透明像素时停止；可见内容接触边缘时人工确认裁切风险。

调用 Manifest 登记的受控 Ingest：

```text
npm run ingest:figma-assets -- --actor ACTOR-NNN --capture-plan <temp-plan> --acquisition <temp-packet>
```

Operation 必须在正式写入前校验 Packet、临时目录边界、唯一分类、来源版本、格式、比例、裁切、透明边距、尺寸、SHA-256 和目标冲突。失败时保留 `AIH_ASSET_MISSING`、`AIH_ASSET_HASH_MISMATCH`、`AIH_ASSET_CLOSURE_FAILED` 或 `AIH_ASSET_INGEST_CONFLICT`。

## 证据封存

- 原始上下文、规范化 Design Context、截图和变量写入 `design-sources/<source-id>/`。
- 已导入资源写入 `public/assets/<source-id>/`。
- `evidence.json` 记录规范化 `nodeId`、`sourceVersion`，并为每个文件记录 Area 相对 POSIX 路径、角色、Schema 和 SHA-256。
- 原始上下文、规范化上下文、正式 Capture Plan、Ingest Receipt 和每个导出资源分别以 `raw-design-context`、`design-context`、`capture-plan`、`ingest-receipt` 和 `asset` 角色登记。
- 每个 Asset 证据项登记完整导出参数、下载操作、消费目标和状态；只存在于 `public/assets/` 或 `canonical-ui.ts.assets` 不构成来源证据。
- Component Set、Main Component 和 Instance 关系必须闭合，同一 `nodeId` 不得重复。

所有文件落盘后重新计算证据项哈希，再计算最终 `evidence.json` 哈希。哈希完成前不得标记 `available`。

最后重新读取或计算同一种 `sourceVersion`。版本变化时丢弃本会话候选，回到范围扫描并重新完成两次确认；不得登记混合版本证据。

## 登记包

在会话临时目录生成符合 `source-registration.schema.json` 的 Registration Packet：

- 包含 `sourceId`、`sourceVersion`、证据清单、正式 Capture Plan、Design Context、Ingest Receipt、`componentHandshake`、已验证资源事实和显式缺口。
- 每个已确认组件提案恰好形成一个握手项；所有 `finalNodeIds` 互斥且并集等于正式 Design Context 的全部组件相关节点。
- 握手项以 `proposalId` 引用提案，并原样携带相同 `interfaceProposal`。
- `shared-component` 分别登记 `variantDefinitionNodeIds` 和 `variantUsageInstanceNodeIds`。前者必须覆盖全部 Figma Definition，即使没有页面 Instance；后者为空时显式记录 `[]`。
- `usageBindings=[{instanceNodeId,screenId}]` 的 Instance 集合必须精确等于 `variantUsageInstanceNodeIds`，每项沿 Instance 的 `screenRootNodeId` 解析到相同 Screen。
- `baselineEvidenceItemIds` 至少引用一个本次正式 `screenshot` 或 `design-context` Evidence Item。
- 使用 Canonical UI Artifact Contract 登记的 `design-source-evidence.schema.json` 校验证据清单。
- 返回登记包、组件抽象提案、来源状态、变量和字体给 Product Design。
- Product Design 校验后登记 `designSources[].evidence.sha256`、Asset Manifest、消费目标、Component Inventory、Figma ↔ Lit Mapping 与 Variant Coverage。

交给 Product Design 前运行只读 Registration 闭包校验：

```text
node .agents/skills/figma-workflow/scripts/ingest-assets.mjs --actor ACTOR-NNN --registration <temp-registration> --json
```

该模式不写正式文件，读取 Packet 引用的正式 Capture Plan、Design Context、Raw Capture、Ingest Receipt 和 `evidence.json`，重算全部哈希，并校验 Component Set Catalog、组件唯一分区、Variant Definition Coverage、Instance Usage Coverage 与 Asset 双向闭包。

不得直接编辑 `canonical-ui.ts`、创建 Canonical UI Asset ID、决定视觉覆盖或来源一致性断言。禁止先登记资源事实、后补来源证据；资源清单必须引用同一来源 `evidence.json` 中的 `asset` 项。

完成后执行 Resolver 返回的全部验证命令。资源文件、证据项、哈希或消费目标不一致时保留 `AIH_SOURCE_INTEGRITY_FAILED` 或原始 blocker code。
