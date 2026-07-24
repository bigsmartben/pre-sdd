---
name: figma-workflow
description: 将用户确认的 Figma 页面、Frame（画框）、组件或选区按一个受控工作流完成范围扫描、图层整理、组件与有限 Variant（变体）建模、合并写回、最终节点冻结、设计上下文采集、静态资源导入和来源证据封存。用户要求清理或组件化 Figma、为 Lit + Vite 规范界面准备设计来源、导出标记资源、精准还原 Figma 或补全 Figma 来源证据时使用；本技能止于向 Product Design 返回可登记的证据与组件抽象提案，不实现 Lit 页面。
---

# Figma 工作流

## 职责边界

把本技能作为 Figma Source Workflow Adapter（Figma 来源工作流适配器）使用。开始前加载 `$product-design` 与 `$apply-repository-harness`：

- Product Design 拥有 `sourceId`、业务范围、`visualPolicy.mode`、Canonical UI Area、两次人工确认、来源与组件契约登记以及 readiness（就绪）。
- 本技能拥有 Figma 范围扫描、获批写回、最终冻结、来源采集、资源 Ingest（导入）和 Registration Packet（登记包）。
- `$implement-canonical-ui` 独立拥有已登记事实对应的 Lit 组件与页面正常实现，以及路由和运行验证；本技能不得写 Lit、HTML、CSS、路由或运行状态。
- `$repair-canonical-ui` 独立消费 Repair Packet；本技能不得执行实现修复。
- Harness 拥有路径、Operation（操作）、验证顺序和 blocker code（阻断码）。

不得创建 Screen、Control、State、Use Case 或 Interaction Flow，不得从图层名和视觉外观推断业务规则，不得选择或改变视觉策略，不得直接编辑 `canonical-ui.ts`，也不得判定正式就绪或执行 Handoff（移交）。

## Figma 工具路由

- 直接读取或写入 Figma 文件前加载 `$figma:figma-use`。
- 创建或修改 Component、Component Set、Variant 或 Variable 前同时加载 `$figma:figma-generate-library`。
- 正式采集时，调用 `get_design_context` 前必须先加载 `$figma:figma-design-to-code`；不得用截图、`get_metadata` 或 `use_figma` 代替设计上下文。
- 连接器、权限、节点或可比较的来源版本不可用时停止，报告 `AIH_SOURCE_CAPTURE_BLOCKED`，不得猜测缺失内容。

## 资源路由

- 范围扫描、图层整理、组件抽象、有限写回或 Detach Instance（分离实例）时，完整读取 `references/figma-writeback.md`。
- 最终写回完成并准备冻结、采集、导出或封存证据时，完整读取 `references/source-capture.md`。
- Lit 实现与视觉运行验证只由 `$implement-canonical-ui` 处理，不在本技能复制。

## 固定工作流

1. **接收输入并只读扫描**
   - 只接受带 `node-id` 的 `https://www.figma.com/design/...` 链接。
   - 从 Product Design 取得 `sourceId`、Canonical UI Area、目标 Screen、Viewport、Scenario、State 和证据覆盖；不得自行扩大。
   - 只扫描 Page、Component、Instance 和候选视觉节点，形成 Scope Confirmation（范围确认）候选，不执行写入或 Detach。

2. **取得第一次人工确认**
   - 向 Product Design 返回 `scanInventory`、包含项、排除项、数量、名称、Node ID，以及把 Figma Root 与 Screen、Viewport、Scenario、State 相连的 `screenBindings`。
   - Product Design 记录扫描时的 `sourceVersion`，并对移除自身 `sha256` 后的完整确认记录执行 RFC 8785 规范化 SHA-256；随后冻结范围。
   - `includedNodes` 与 `excludedNodes` 必须按 `kind + nodeId` 互斥且精确分区 `scanInventory.nodes`；每个 `screenId + figmaRootNodeId` 的 `screenBindings` 分组必须恰好覆盖全部已确认 `Viewport × Scenario` 组合，且整体覆盖全部已确认 State。
   - `includedNodes[kind=visual]` 与候选视觉节点形成双向闭包；组件提案的 `nodeIds` 分组互斥且并集精确等于 `includedNodes[kind=component]`。新增或遗漏节点必须重新确认。

3. **形成有限写回并取得第二次人工确认**
   - 读取 `references/figma-writeback.md`，提出图层整理、组件抽象、有限 State / Variant 轴、资源分类歧义、复用来源和具体写回影响。
   - 默认不 Detach Instance。只有逐个记录阻断原因且经用户批准的 Instance 才能进入 `detachApprovals`。
   - Product Design 重新读取同一种 `sourceVersion`，记录引用 Scope ID 与 `scopeConfirmationSha256` 的 `highImpactConfirmation`；空写回和空 Detach 也必须显式记录。
   - High-impact Confirmation 同样对移除自身 `sha256` 后的完整记录执行 RFC 8785 规范化 SHA-256。

4. **执行一个合并写回批次**
   - 只执行第二次确认中的操作；把重命名、分组、已有组件替换、获批 Detach、变量和组件创建合并为一个批次。
   - 保存同范围写入前后截图和节点盘点，核对预期外差异。
   - 完成后登记 `writebackBoundary`，其操作 ID 必须与确认清单一一对应，并用 `highImpactConfirmationSha256` 绑定获批内容。

5. **冻结并执行唯一一次正式采集**
   - 写回全部完成后冻结最终节点，读取 `references/source-capture.md`。
   - 取得可重复比较的 `sourceVersion`，设置 `formalCapture.ordinal: 1` 及开始、完成、前后版本边界，分类全部候选视觉节点，再采集 Raw Capture（原始采集）、规范化上下文、截图、变量、字体和静态资源。
   - `formalCapture.sourceVersionBefore` 与 `sourceVersionAfter` 必须都等于最终来源版本；Design Context、Asset 下载、Ingest Receipt 与 Evidence 时间必须位于同一正式采集边界内。
   - Design Context 必须保存 `rawCapture` provenance（来源凭据）及完整 `componentSetCatalog`；每个 Component Set 的轴、有限值和全部 Variant Definition 必须闭合。
   - 只由 Manifest 登记的 `ingest-figma-assets` Operation 写入正式 Asset、Capture Plan 和 Ingest Receipt。

6. **封存并交回 Product Design**
   - 输出 Component Abstraction Proposal（组件抽象提案）、正式 Capture Plan、Ingest Receipt、`evidence.json` 与通过 Schema 及只读闭包校验的 Registration Packet。
   - `componentHandshake` 以 `proposalId` 绑定获批提案，原样携带 `interfaceProposal`，唯一分区正式组件节点，并分别完整列出 Variant Definition 与使用中的 Instance；未使用 Definition 也不能省略。
   - 每个 Instance 的 `screenRootNodeId` 必须解析到 `screenBindings` 中唯一 Product Screen；`usageBindings` 必须精确覆盖 Instance 集合，`baselineEvidenceItemIds` 必须解析到正式截图或 Design Context。
   - Product Design 负责把来源、资源、组件清单、Figma ↔ Lit Mapping 和 Variant Coverage 登记到 Canonical UI；本技能不得代写。

## 确定性失效规则

在冻结或正式采集后发生任何 Figma 节点、图层、变量、组件、Variant 或来源版本变化时：

1. 立即把 Capture Plan、来源证据和下游登记视为失效。
2. 丢弃本次会话拥有的临时候选。
3. 返回只读扫描，重新完成两次人工确认、合并写回和唯一一次正式采集。

不得追加第二次正式采集、混合不同版本证据或沿用旧 `capturedAt`、哈希、截图和组件身份。

## 完成条件

- 两次人工确认的 RFC 8785 内容哈希、来源版本、有限写回、冻结和正式采集顺序可由 Capture Plan 机器校验。
- 实际写回没有越出确认范围，所有 Detach 都逐个获得批准。
- 最终来源上下文、截图、变量、字体、组件身份、资源和哈希来自同一 `sourceVersion`。
- 范围内每个 Visual Node 只有一种 `asset`、`dom-css`、`dynamic` 或 `ignored` strategy，范围内每个 Component Node 只有一个抽象决定。
- 每个组件提案明确组件边界、尺寸行为及 Lit Property / Attribute / Slot / Event 接口；Variant Property 与有限 Variant Axis 的名称和值完全闭合。
- 所有正式 Asset 都通过受控 Ingest，并在 Ingest Receipt、`evidence.json` 和 Registration Packet 中闭合。
- Raw Capture、Design Context、Component Set Catalog、Component Abstraction Proposal 与最终重新采集的组件身份闭合后一起交回 Product Design。
- Registration Packet 同时证明 Variant Definition Coverage（定义覆盖）与 Instance Usage Coverage（使用覆盖）。
- 没有修改产品事实、`canonical-ui.ts`、Lit 实现、视觉基线、容差、readiness 或 Handoff 状态。
