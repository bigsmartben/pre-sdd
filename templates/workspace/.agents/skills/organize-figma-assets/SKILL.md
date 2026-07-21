---
name: organize-figma-assets
description: 整理 Figma 页面、Frame（画框）、组件或选区中的图层结构，确认范围和 Detach Instance（分离实例）影响后，重命名、分组、排序、复用现有组件并标记 Export/ 资源。用户要求清理 Figma 图层、准备 Lit + Vite 规范界面资源、统一命名或为来源采集准备导出目标时使用；本技能不得创建新组件。
---

# 整理 Figma 资源

## 边界

本技能只修改用户确认的 Figma 范围，不编写产品事实、Canonical UI Prototype（规范界面原型）或领域产物。直接读写 Figma 前必须加载 `$figma:figma-use`；连接器、权限或节点不可用时停止并报告 `BLOCKED`，不得伪造结果。

不得创建 Component（组件）、Component Set（组件集）、Variant（变体）或 Variable（变量）。用户要求创建组件时，改用 `$figma-component-from-design`。

## 工作流

1. 检查目标范围。
   - 明确页面、Section（区段）、Frame、组件或选区。
   - 盘点范围内 Instance 数量、嵌套层级和可能受影响的 Override（覆盖值）。
   - 本步骤只生成 Scope Confirmation（范围确认）候选，不执行写入或 Detach。记录包含项、排除项、数量、名称、Node ID、Viewport、主要 Scenario 和 State；用户确认后冻结范围，扩大范围必须重新确认。

2. 提出有限写回并取得第二次人工确认。
   - 先报告组件抽象、State / Variant 轴、资源分类歧义、所有拟写回影响，以及真正阻断整理的具体 Instance。
   - 默认不执行 Detach Instance。只有用户在 High-impact Confirmation（高影响确认）中逐个批准具体阻断 Instance 后，才把该节点加入合并写回清单。
   - 对获批 Instance 从最深层开始分离，保留位置、尺寸、约束、自动布局、可见性和全部非默认 Override（覆盖值）；不得把“已确认 Frame”解释成全量 Detach 授权。
   - 不处理范围外节点；写回后按清单复核，不要求确认范围内所有 Instance 都被分离。

3. 按角色整理结构。
   - 识别容器、背景、媒体、图标、文本、控件、状态层、装饰和可导出 Artwork（视觉作品）。
   - 使用语义名称，例如 `ProductCard`、`Title`、`StatusBadge`、`State/Disabled`。
   - 按根节点、布局区域、内容、控件、状态层、导出标记的顺序组织图层。
   - 保持动态文本、用户数据和内容图片可编辑，不把它们压入静态资源。

4. 复用已有组件。
   - 在当前文件、已启用组件库或用户指定来源中查找匹配组件。
   - 替换前逐项核对角色、Variant、Component Property、Override、文字、图标、图片、状态、Frame 尺寸、约束和 Auto Layout；全部项目都有一一映射时才允许替换。
   - 任一项目未知、缺失或需要改变语义时停止该替换并向用户确认；没有合适组件时保留普通图层并记录。
   - 替换前保存目标范围截图和节点盘点；替换后使用相同范围重新截图并核对盘点差异，再移除被替代图层。

5. 标记导出资源。
   - 只标记来源本身是图像填充、复杂矢量、Logo、插画或含多层混合、模糊、渐变效果的静态 Artwork；普通布局、文字、控件、单色基础形状和可由现有设计令牌表达的效果不得导出。
   - 使用 `Export/kebab-case-name`，例如 `Export/product-hero`。
   - 混合内容中只标记静态 Artwork 子层，不把动态文本、头像或内容图片一起导出。
   - 为透明资源排除画布背景；除非来源明确为贴边构图，否则导出 Frame 四边都必须保留透明像素，任一可见像素接触边缘时在交接中标记裁切风险。

6. 合并写回、报告和交接。
   - 重命名、分组、替换、获批 Detach 与组件技能产生的写回必须先合并到同一份确认清单，再在确认范围内执行；不得边采集边反复写回。
   - 报告目标范围、分离数量、主要重命名、组件替换、跳过项和全部 `Export/` 标记。
   - 本技能发生任何 Figma 写入后，将同一节点已有的来源证据视为失效，不得继续引用旧 `capturedAt` 或旧哈希。
   - 全部 Figma 整理和组件写入完成后冻结节点，只调用一次 `$capture-figma-design-source` 进行正式采集、导出标记资源并统一封存证据。

## 命名约定

| 对象 | 约定 | 示例 |
|---|---|---|
| 可复用根节点 | PascalCase | `PricingCard` |
| 内部角色 | 简短英文语义名 | `Header`、`Action` |
| 状态 | `State/名称` | `State/Loading` |
| 导出目标 | `Export/kebab-case` | `Export/empty-state-art` |

## 完成条件

- 只修改了用户确认的范围。
- 范围确认与高影响确认是两个独立人工决策点，实际写回与逐个 Detach 均可追溯到第二次确认。
- 除用户确认的结构、命名和组件替换外，前后截图中的 Frame 边界、可见文字、填充、描边、效果和图层可见性没有变化。
- 已保存写入前后同范围截图和节点盘点，所有预期外差异均已确认。
- 没有创建新组件或变量。
- 动态内容没有被错误栅格化。
- 每个组件替换均完成角色、Variant、属性、Override、尺寸、约束、Auto Layout 和前后截图核对。
- 每个导出目标都有稳定名称和明确用途。
- 旧来源证据未被当作整理后节点的有效证据继续使用。
