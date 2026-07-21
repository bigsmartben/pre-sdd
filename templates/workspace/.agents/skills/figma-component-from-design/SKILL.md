---
name: figma-component-from-design
description: 分析 Figma 选区或设计区域，先确认组件名称、属性、变体、变量和嵌套边界，再创建可复用 Figma 组件，并输出到 Lit 自定义元素接口的交接映射。用户要求把设计区域制作成 Figma Component（组件）、Component Set（组件集）或 Variant（变体）时使用。
---

# 从设计创建 Figma 组件

## 边界

本技能负责 Figma 组件写回，不修改 Product Design（产品设计）事实、Canonical UI Prototype（规范界面原型）或 Handoff（移交）状态。直接读写 Figma 前必须同时加载 `$figma:figma-use` 与 `$figma:figma-generate-library`；前者约束 Figma 文件上下文操作，后者约束变量、组件、Variant（变体）和库结构的创建顺序。连接器、权限或节点不可用时报告 `BLOCKED`。

设计含多个状态、主题或嵌套边界时，读取 `references/confirmation-checklist.md`。

## 工作流

1. 分析源设计。
   - 确认准确选区、Frame、图层组或区域。
   - 记录容器、插槽、文本角色、控件、图标、状态、间距、尺寸、约束和重复部分。
   - 区分结构差异、内容覆盖和纯视觉差异。

2. 提出组件模型。
   - 判断使用单组件、组件集还是父组件加嵌套组件。
   - 对分析范围内每个重复或组件相关节点提出唯一抽象决定：`shared-component`、`primitive-only` 或 `local-structure`；记录语义职责、结构签名、复用依据和反例。
   - 结构或状态差异使用 Variant；文本、布尔开关、Instance Swap 和插槽使用 Component Property（组件属性）。
   - Variant 轴必须是有限集合；不得使用 `isHomePage`、`specialCheckoutCase`、页面路径或单屏 CSS 补丁表达实例差异。
   - 优先复用已有变量与组件；需要新变量时列出颜色、排版、间距、圆角、效果和尺寸名称。

3. 写入前完成第二次人工确认。
   - 把组件名、Variant 轴、属性、变量、嵌套边界、复用来源、资源歧义和具体写回影响合并到 High-impact Confirmation（高影响确认）。
   - 本确认必须引用已冻结的 Scope Confirmation（范围确认）；任何新增目标节点都要先返回第一次范围确认。
   - 未确认前不创建或实质修改 Figma 组件；Agent 不得代填确认人、确认时间或确认哈希。

4. 作为合并写回批次的一部分创建并验证。
   - 先创建确认过的变量和嵌套组件，再创建父组件与组件集。
   - 使用 Auto Layout（自动布局）、约束、最小或最大尺寸和清晰图层名。
   - 同一尺寸下所有状态保持相同 Frame 宽高。
   - 按状态分组排列 Variant，并逐项切换属性和 Variant 验证。
   - 核对间距、尺寸、字体、层级、变量绑定和主题切换。

5. 输出 Lit 交接映射。
   - 输出 Component Abstraction Proposal（组件抽象提案），逐项包含抽象决定、语义职责、结构签名、Figma 属性、有限 Variant 值、Lit Property / Attribute / Slot / Event 对应关系。
   - 本提案只保存用户确认的抽象意图，不把创建前 Node ID 当作最终来源事实，也不修改规范界面工程。
   - 本技能创建或修改组件、变量、Variant 或节点后，将同一来源已有证据视为失效。
   - 全部 Figma 写回完成后冻结最终节点，并只调用一次 `$capture-figma-design-source` 执行正式采集；不得把创建前的截图、上下文或清单继续作为实现依据。
   - Product Design 必须把用户确认的提案与重新采集后的最终 Component Set、Main Component、Instance 和 Variant 身份汇合到 Canonical UI 的 `componentInventory`、`componentMappings` 与 `componentVariantCoverage`。Schema 与 Validator 通过前不得交给 `$implement-figma-lit-page`。

| Figma 能力 | Lit 接口 |
|---|---|
| Text Property（文本属性） | 响应式字符串属性或 Slot（插槽） |
| Boolean Property（布尔属性） | 布尔属性与条件模板 |
| Instance Swap（实例替换） | 命名 Slot 或元素属性 |
| Variant `state` / `size` | 联合类型属性及反射 Attribute（特性） |
| 交互事件 | 带类型的 CustomEvent（自定义事件） |
| Design Variable（设计变量） | CSS Custom Property（自定义属性） |

## 完成条件

- 用户已确认组件模型。
- 组件属性、Variant 和变量均可实际切换。
- 同尺寸状态的外框尺寸一致。
- 没有把视觉来源中的业务暗示写成产品事实。
- 最终报告包含 Figma 结果和 Lit 接口映射。
- 分析范围内每个组件相关节点都有且只有一个抽象决定，Variant 轴与值是有限集合。
- 组件写回后的最终节点已经明确要求重新采集，旧来源证据没有继续流入实现。
