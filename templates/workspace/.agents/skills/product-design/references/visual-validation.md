# 视觉与交互验证

## 代表性基线

先选择同时覆盖核心布局、典型资源、主要操作和关键状态的页面。使用真实 DOM、CSS、仓库内资源和可控 Mock 数据实现，并且只在用户确认后写入模型的视口实际渲染。

基线至少检查：

- 页面结构、信息密度和主要区域比例；
- 字体、颜色、间距、圆角、阴影和图标资源；
- 默认、加载、空、成功、失败、禁用和权限相关状态中适用的部分；
- 入口、返回、继续、异常恢复和结束路径；
- 文本反馈与用户已确认的视觉检查；
- 用户已确认尺寸内的重排、折行和溢出。

## 扩展规则

- 只有业务意图、实体、操作语义、权限和状态集合兼容时才抽取业务组件。
- 视觉相似但业务语义不同的区域只复用低层 Primitive 或 Shell。
- 所有 Figma 组件相关节点必须形成完整 Component Inventory；共享组件必须有 Figma ↔ Lit Mapping、Component Contract、Variant Coverage 与完整 State Matrix，不能依靠页面名、路由判断或特殊 CSS 补丁表达实例差异。
- 组件公共变更传播以 Single Implementation Owner（单一实现所有者）为基础门禁：每个已映射 Figma Instance 必须由声明的同一个 Lit 自定义元素渲染。页面出现相同 `data-component-id` 但未使用声明 Tag 或 Instance 标识时，以 `AIH_COMPONENT_IMPLEMENTATION_MISMATCH` 阻断。
- 不用固定坐标复刻整页；绝对定位仅用于本来就需要叠放的局部元素。
- 不用整页截图充当交互页面；截图只能作为视觉参考或明确的内容资源。
- 使用稳定本地 Fixture 演示场景，不连接生产服务，除非用户明确要求。
- 使用场景声明的事件实际点击、输入或选择；UC 的正式 Interaction State 暴露对应 `data-state-id`，组件局部状态暴露 `data-component-state`。浏览器必须观测动作发生后的真实状态变化，并按 `resultingStateIds` 的声明顺序核对，不能用最终可见节点反推中间过程。
- 每个本地资源由 `assets[].path` 指向真实文件，并在界面中实际使用；字体资源还必须出现在声明目标或其后代元素的计算字体族中。

## 最终检查

1. 运行生成检查，确认 README 与隐藏 JSON 投影和 `canonical-ui.ts` 无 drift。
2. 实现达到可运行状态后，立即启动 Manifest 登记的 Canonical UI 开发服务器，读取其实际输出的 `[READY]` 正式预览地址，请求一次确认可访问并提供给用户。URL 只允许一个 Review 开关：正式预览与产品截图固定使用 `?review=0`；明确的 UI Case Mock Review 和场景门禁固定使用 `?review=1`。未设置 `review` 与 `review=0` 等价，不加载任何 Review Tool。服务器进程必须在当前评审期间保持运行，且不等待后续视觉修复或严格门禁通过。
3. 地址交付后运行 typecheck、build 及 resolver 返回的全部测试和结构校验。首次使用或收到 `AIH_BROWSER_UNAVAILABLE` 时运行 `npm run install:browser`；构建后运行 `npm run validate:canonical-ui-runtime`，按 `scenarios` 实际操作每个主路径和分支，观察 Screen、State 与反馈。
4. 只在用户确认并已声明的视口执行路由与场景，先运行 `renderAssertions[].checks`，再按模式运行 `sourceParityAssertions[].checks`：`autonomous` 不要求来源比较；`guided` 只比较声明的视觉方面与局部；`exact` 可对所有路由、场景和视口执行整页 `screenshot-match` 诊断。
5. `exact` 的运行截图必须在相同视口、设备像素比、字体、资源和 Mock 数据下与证据截图比较；通道容差与最大差异像素比例只读取 Contract，Agent 不得自行放宽。偏差超过阈值时记录 `AIH_VISUAL_PIXEL_DIAGNOSTIC`，输出 Figma/截图基线、实际截图、差异图、路由、视口、场景、差异比例和区域，但不把像素阈值当作最终接受或阻断。
6. 核对 `assets` 的本地文件、加载结果与实际使用目标，校验 `designSources` 的证据内容哈希和覆盖范围。
7. 核对 `componentInventory` 已唯一覆盖全部 Figma 组件相关节点，`componentVariantDefinitions` 已覆盖全部 Definition，`componentVariantCoverage.usages` 已覆盖全部使用中 Instance ↔ Screen，`componentContracts` 已唯一声明 Lit 接口；浏览器逐项验证 Lit Tag、`data-figma-instance-id`、Variant Attribute、Property、Attribute、Slot，并验证 `/__review/components` 只呈现 `stateMatrix` 中的全部合法组合。
8. 不一致标记、UI Case 切换器与交互分支驱动器统一属于 Review Tool（评审工具），不属于真实产品需求、功能、页面、控件或下游实现范围，也不得修改 Use Case、Interaction Flow 或 Visual Spec 的产品事实。产品截图和像素比较排除全部 `[data-review-tool]`；UI Case Mock 的临时 Review Extension 不得形成独立 READY 生命周期。
9. 捕获控制台错误、页面异常和资源请求失败；只允许本地服务器、`data:` 与 `blob:` 请求。
10. 仅当用户明确选择额外的键盘操作、读屏、焦点、触控尺寸或减少动画检查时，运行 `accessibility.checks` 中对应的检查；Component Contract 的关键可访问断言始终由契约 Runner 执行。
11. `screenshot-match` 只记录差异比例、区域、实际图和差异图，不产生最终视觉阻断。`exact` 的最终视觉结论必须来自当前 Review 范围上的 Human Visual Acceptance；机器样式和来源绑定失败仍可在用户显式启用后进行一次手动修复。
12. 增量校验输出静态输入、Asset、Component、Route 和视觉诊断各层耗时、缓存命中及失效原因；正式 readiness/Publish 不读取增量缓存，并全量执行 Console、Network、Asset、组件、路由、状态和 Viewport 门禁。
13. 用户显式启用的单次手动修复仍失败时报告 `AIH_VISUAL_REPAIR_EXHAUSTED`。来源缺失、哈希不一致、覆盖不完整、业务冲突、运行时错误、网络错误、无障碍错误等非修复码不得生成可执行 Repair Packet。
14. 运行 Product strict Profile；任何 FAIL、BLOCKED 或 NOT_RUN 都必须保留为 residual，不能表述为 ready，也不能据此阻止或撤回仍然可访问的评审地址。`exact` 还必须由用户受控记录 Human Visual Acceptance，Agent 不得代为接受。
15. 每轮修复后确认当前评审地址仍可访问；若服务器重启，则读取并提供新的实际 `[READY]` 地址。只有服务器自身无法启动、未输出地址或地址无法请求时，才能以 `AIH_CANONICAL_UI_SERVER_FAILED` 阻断地址交付。
