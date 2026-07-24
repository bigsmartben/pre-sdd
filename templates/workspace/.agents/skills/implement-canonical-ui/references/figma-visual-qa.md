# Figma 来源附加验证

本文件只在当前 Canonical UI 范围包含 `designSources[].kind: figma` 时读取；公共规则仍以 `visual-qa.md` 为准。

## 输入闭包

- Figma 来源已经由 `$figma-workflow` 完成范围确认、高影响确认、合并写回、最终冻结和唯一一次正式采集。
- 每个候选视觉节点在 Capture Plan 中只有一种 `asset`、`dom-css`、`dynamic` 或 `ignored` strategy。
- `asset` 已在 Ingest Receipt、`evidence.json`、`canonical-ui.ts.assets` 和 `consumerTargets` 中双向闭合。
- Registration Packet 已由 Product Design 以路径与哈希登记，Component Inventory 已唯一覆盖全部组件相关节点；`shared-component` 已具有 Mapping、Contract、State Matrix、全部 Variant Definition 和使用中 Instance Coverage。

## 每个组件

1. 读取该组件的 Registration Handshake、`componentMappings`、`componentVariantDefinitions` 与全部 `componentVariantCoverage`，不从单页外观重新推导接口。
2. 在共用 Matrix Mount 中逐行渲染合法矩阵；宿主声明唯一的 `data-component-id` 与 `data-component-instance-id`，Figma 页面实例再声明 `data-figma-instance-id`。
3. 使用来源相同的尺寸、字体、资源和稳定 Mock 数据。
4. 核对 Lit Tag、全部已定义 Variant Attribute、Property、Event、Render Binding 与使用中的 Slot。
5. Exact 模式对每个 Figma Page Instance × Viewport × 合法 Matrix Entry 各使用一条且仅一条 Component Source Parity Assertion，比较对应组件节点基线与隔离 Lit Host；不得用默认态基线替代其他 Variant 或 Runtime State。

## 页面

- 页面把映射组件作为自定义元素实例使用，不复制内部模板。
- `exact` 对全部登记 Route、Scenario 和 Viewport 执行来源比较；`guided` 只检查声明区域与视觉方面。
- 页面差异只能通过实例数据、映射接口、布局容器和页面样式处理，不得破坏共享组件。

## Figma 专用阻断

- 来源采集后发生过节点、图层、变量、组件、Variant 或其他 Figma 写入。
- Figma 组件被展开复制到页面模板。
- 组件节点缺少抽象决定、Registration、Mapping、Variant Definition 或 Instance Usage Coverage。
- `data-figma-instance-id` 重复、Lit Tag 不符或同一 Component ID 出现旁路实现。
- 已分类 `asset` 被 DOM/CSS 近似替代，或没有实际加载正式文件。
