# Figma 有限写回

## 目录

- [范围扫描](#范围扫描)
- [写回提案](#写回提案)
- [组件抽象](#组件抽象)
- [第二次确认](#第二次确认)
- [合并执行](#合并执行)
- [交接提案](#交接提案)

## 范围扫描

只读盘点 Product Design 指定的 Page、Section、Frame、组件或选区：

- 用 `scanInventory={scannedAt,sourceVersion,rootNodeId,nodes}` 保存只读全量盘点；每个节点记录 `kind`、`nodeId`、`name` 和可选 `parentNodeId`。
- 记录根节点、包含和排除的 Page / Component / Visual Node、名称、Node ID 与逐类数量；两组必须按 `kind + nodeId` 互斥且精确分区盘点节点。
- 用 `screenBindings=[{screenId,figmaRootNodeId,viewportId,scenarioId,stateIds}]` 记录目标 Viewport、Scenario 和 State；同一 Figma Root 可有多行，但只能归属一个 Product Screen。
- 记录 Instance 数量、嵌套层级和可能受影响的 Override（覆盖值）。
- 识别容器、背景、媒体、图标、文本、控件、状态层、装饰和静态 Artwork（视觉作品）。
- 记录已有组件、Component Set、Variant、Variable、Auto Layout、约束和当前 Export 设置。
- 读取并记录扫描时的 `sourceVersion`，只形成 `scopeConfirmation` 候选；用户确认并由 Product Design 记录前不得写入。

范围扩大、根节点变化或新增目标节点时，废弃候选并重新确认。

## 写回提案

把全部写回合并到一个可确认清单：

- 图层重命名、分组、排序和 Auto Layout 调整。
- 可一一映射的已有组件替换。
- 新组件、Component Set、有限 Variant、Component Property 和 Variable 创建。
- 静态 Artwork 的 `Export/kebab-case-name` 标记。
- 资源分类歧义及其最终 `asset`、`dom-css`、`dynamic` 或 `ignored` 建议。
- 真正阻断写回的具体 Instance 及逐个 Detach 理由。

不得把动态文本、用户数据、内容图片、真实控件或交互结构压入静态资源。普通布局、文字、控件、单色基础形状和可由现有设计令牌表达的效果不得标记为导出资源。

## 组件抽象

对范围内每个重复或组件相关节点给出唯一决定：

| 决定 | 含义 |
|---|---|
| `shared-component` | 语义职责和结构一致，需要一个共享 Figma 组件及唯一 Lit 接口 |
| `primitive-only` | 只复用低层视觉或结构 Primitive，不合并业务组件 |
| `local-structure` | 保留为页面或父组件局部结构 |

`componentProposals` 是真正的抽象分组：每项以唯一 `id` 拥有一个或多个 `nodeIds`；不同分组互斥，并集必须精确等于范围中的全部 `kind=component` 节点。为每项记录 `semanticRole`、`structureSignatures`、作为复用依据的 `reason` 和具体 `counterexample`。结构签名忽略文字值、颜色、尺寸、坐标和当前 Variant 值，保留节点类型、内容角色、容器、Slot 和嵌套组件边界。

每个提案必须显式记录：

- `componentBoundary={kind,rootNodeId,nestedComponentNodeIds}`：单组件、组件集或嵌套组件的所有权边界。
- `sizeBehavior={width,height,wrap}`：固定、Hug（内容自适应）、Fill（填充）、内容驱动或混合尺寸，以及最小/最大值。
- `interfaceProposal={properties,slots,events}`：Figma Property 到 Lit Property / Attribute 的映射、内容 Slot 和交互 Event；Variant Property 必须逐值映射。

组件模型遵守以下规则：

- 结构或状态差异使用有限 Variant；文本、布尔开关、Instance Swap 和内容区域使用 Component Property 或 Slot。
- 不得使用 `isHomePage`、路由、页面名、特殊间距或单屏 CSS 补丁表达实例差异。
- 优先复用已有组件和变量；新变量只覆盖确认过的颜色、排版、间距、圆角、描边、阴影、效果和尺寸。
- 先创建获批的变量和嵌套组件，再创建父组件与 Component Set。
- 同一尺寸的不同状态保持相同 Frame 宽高；逐项切换属性和 Variant 验证。

创建组件前按实际需要确认：

- 组件名称以及单组件、组件集或嵌套组件边界。
- 固定、内容自适应、填充、换行和最小/最大尺寸。
- Text、Boolean、Instance Swap、Slot 和 Event。
- 每个 Variant 轴的有限值和使用该组合的 Instance。
- 颜色、排版、间距、圆角、描边、阴影、尺寸、主题及复用来源。
- 哪些实例应随公共部分同步变化，哪些必须保持独立。

## 第二次确认

High-impact Confirmation（高影响确认）必须：

- 重新读取同一种 `sourceVersion`，必须与 Scope Confirmation 完全相同；不同即废弃范围并重新扫描。
- 引用已冻结的 `scopeConfirmation`，且使用不同确认 ID，并记录 `scopeConfirmationSha256`。
- 包含组件抽象提案、有限 State / Variant 轴、变量、资源歧义、复用来源和全部拟写回操作。
- 每个有限轴通过 `proposalId` 和 `kind` 明确归属；同一提案的 `kind + name` 不得重复。
- `kind=variant` 的轴名和值必须与同一提案 `interfaceProposal.properties[kind=variant]` 完全一致。
- 明确记录空写回或空 Detach，不允许省略。
- 对每个 Detach Instance 记录具体 Node ID、阻断原因和用户批准。
- 不把“已确认 Frame”解释为全量 Detach 授权。

任何新增目标节点都必须返回第一次范围确认。Agent 不得代填确认人、确认时间或确认哈希。Product Design 对移除自身 `sha256` 后的完整确认对象执行 RFC 8785 JSON 规范化 SHA-256；High-impact Confirmation 的哈希还覆盖 `scopeConfirmationSha256`。

## 合并执行

1. 保存目标范围截图和节点盘点。
2. 从最深层开始执行获批 Detach，保留位置、尺寸、约束、Auto Layout、可见性和全部非默认 Override。
3. 按根节点、布局区域、内容、控件、状态层和 Export 标记整理图层。
4. 替换已有组件前逐项核对角色、Variant、Component Property、Override、文字、图标、图片、状态、Frame 尺寸、约束和 Auto Layout；任一未知或缺失都停止该替换。
5. 创建确认过的变量、嵌套组件、父组件和 Component Set，并核对主题与全部属性组合。
6. 使用 `Export/kebab-case-name` 标记静态 Artwork；透明资源排除画布背景并保留透明边距，贴边时记录裁切风险。
7. 使用同一范围重新截图和盘点，只接受确认清单内的差异。
8. 把完成时间、操作 ID、`highImpactConfirmationSha256`、`sourceVersionBefore` 与 `sourceVersionAfter` 写入 `writebackBoundary`；操作 ID 必须与第二次确认一一对应。无写回时前后版本必须相等。

命名约定：

| 对象 | 约定 | 示例 |
|---|---|---|
| 可复用根节点 | PascalCase | `PricingCard` |
| 内部角色 | 简短英文语义名 | `Header`、`Action` |
| 状态 | `State/名称` | `State/Loading` |
| 导出目标 | `Export/kebab-case` | `Export/empty-state-art` |

## 交接提案

输出 Component Abstraction Proposal，逐项包含：

- 抽象决定、语义职责、结构签名和复用依据。
- Figma 组件名、属性、有限 Variant 值、Variable 和嵌套边界。
- Figma Text / Boolean / Instance Swap / Variant 到 Lit Property / Attribute / Slot / Event / CSS Custom Property 的建议映射。
- 每个使用中 Figma Instance 到 Lit Attribute 值的覆盖建议。
- 每个 Instance 的 Figma Screen Root，以及它解析到的唯一 Product Screen。
- 全部 Variant Definition 与使用中 Instance 分开列出；未被页面使用的 Definition 仍属于定义覆盖，零使用必须显式记录。
- 跳过的替换、未解决歧义和裁切风险。

该提案只保存用户确认的抽象意图，不把写回前 Node ID 当作最终来源事实。全部写回完成后必须冻结并重新采集，最终 Component Set、Main Component、Instance 和 Variant 身份只来自正式设计上下文。
