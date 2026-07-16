# Figma 到 Lit 视觉验证

## 比较范围

- Frame 尺寸、用户确认的 Viewport（视口）和设备像素比。
- 页面层级、区域顺序、位置、尺寸、间距和对齐。
- 字体、字号、字重、行高、字距和换行。
- 颜色、透明度、边框、圆角、阴影和模糊。
- 图片裁切、透明度、可见边界和缩放。
- 组件 Variant、状态、图标、文案和可见反馈。

## 每个组件

1. 读取该组件的 `componentMappings` 与全部 `componentVariantCoverage`，不从单页外观重新推导接口。
2. 在最小可运行场景中逐行渲染覆盖矩阵，宿主元素声明 `data-component-id` 与 `data-figma-instance-id`。
3. 使用与 Figma 来源相同的尺寸、字体、资源和稳定 Mock 数据。
4. 在组件最小路由中执行 `sourceParityAssertions`，并核对 Lit Tag、Variant Attribute 与使用中的 Slot。
5. 先修复整体尺寸和位置，再修复字体、颜色和细节。
6. 比较通过后再进入下一个组件。

## 页面

1. 按 `canonical-ui.ts.routes` 打开目标路由。
2. 按 `scenarios` 触发默认态和全部显式分支。
3. 只在用户确认并登记的 Viewport 运行。
4. `exact` 模式执行整页 `screenshot-match`；`guided` 只检查声明区域与视觉方面。
5. 页面差异应通过页面数据、属性、Slot、布局容器和页面样式修复；不要为单页差异破坏共享组件。

## 证据角色

- Figma 节点截图和上下文是 Canonical UI Area 内带内容哈希的正式来源证据。
- 浏览器运行截图、叠图和差异图是临时运行证据，只写入操作系统临时目录。
- 容差来自 Canonical UI Artifact Contract，不在任务中另建阈值。

## 阻断条件

- 来源节点、截图、字体或资源不可访问。
- 页面使用未登记资源或仍有占位图。
- Figma 组件被展开复制到页面模板。
- Figma 组件相关节点缺少抽象决定、映射或 Variant 覆盖。
- 声明的 `data-figma-instance-id` 重复、Lit Tag 不符或同一 Component ID 出现旁路实现。
- 声明状态无法通过真实操作触发。
- 实际渲染超出固定像素容差。
- 只完成构建而没有执行来源一致性和运行时验证。
