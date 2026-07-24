# Canonical UI 视觉与运行验证

## 公共比较范围

- 用户确认的 Viewport（视口）、设备像素比和页面可用范围。
- 页面层级、区域顺序、尺寸、间距、对齐和内容密度。
- 字体、字号、字重、行高、字距和换行。
- 颜色、透明度、边框、圆角、阴影、模糊和动画。
- 已登记 Asset 的裁切、透明度、可见边界、缩放和实际消费。
- Component Contract、State Matrix、交互状态、文案和可见反馈。

## 按视觉模式

- `autonomous`：只执行页面健康、Contract、Asset、路由、场景、Console、Network 和用户确认的可选无障碍检查，不建立来源一致性断言。
- `guided`：在公共门禁之外，只比较 `visualPolicy.aspects` 与 `coverage` 声明的来源范围；未覆盖部分不作完全还原要求。
- `exact`：对全部确认的 Route、Screen、State、Scenario 与 Viewport 执行登记的来源比较；整页截图比较仍是非阻塞诊断，最终视觉接受由用户完成。

## 组件

1. 读取 `componentContracts`、`stateAxisCoverage`、`stateAxes.renderBinding` 与 `stateMatrix`，不从单页外观重新推导接口。
2. 在共用 Matrix Mount 中逐个隔离渲染全部合法组合。Mount 只注入输入；验证器必须观察组件自己的 Lit Property、Variant Attribute、内部 Runtime State、可见 Content 和真实 Slot 分配，不得读取 Mount 自己写入的同一标记作为通过依据。
3. Boolean Attribute 的 `false` 必须表现为 Attribute 不存在；Slot 节点必须拥有同名 `assignedSlot` 且内容可见。
4. 使用稳定 Viewport、字体、资源、Mock 数据和动画设置。
5. 先修复整体结构和尺寸，再处理字体、颜色和效果。
6. 有来源时只运行已登记的来源一致性断言；Exact Figma 范围必须逐个覆盖 Page Instance × Viewport × 合法 Matrix Entry，没有来源时不制造比较基线。

## 页面

1. 按 `canonical-ui.ts.routes` 打开目标路由。
2. 按 `scenarios` 触发默认态和全部显式分支。
3. 只在用户确认并登记的 Viewport 运行。
4. 页面差异通过页面数据、Contract 接口、布局容器和页面样式处理；不得为单页差异破坏共享组件。
5. screenshot、export 与 other 来源截图只作基线或明确的内容 Asset，不得替代交互 DOM。

## 证据角色

- 已登记的设计来源与本地内容哈希是正式来源证据。
- 浏览器运行截图、叠图和差异图是临时运行证据，只写入操作系统临时目录。
- 容差来自 Canonical UI Artifact Contract，不在任务中另建阈值。

## 阻断条件

- `visualPolicy.mode` 仍为 `unresolved`。
- ready Use Cases、Visual Spec、`canonical-ui.ts` 或用户确认的 Viewport 缺失。
- guided/exact 来源证据、覆盖、字体或资源不可访问或哈希不一致。
- 页面使用未登记资源、占位图或整页截图替代真实交互。
- Component Contract、State Matrix、路由或正式状态无法实际运行。
- 只完成构建而没有执行当前模式要求的运行时验证。
