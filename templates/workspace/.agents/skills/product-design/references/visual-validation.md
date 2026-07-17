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
- 所有 Figma 组件相关节点必须形成完整 Component Inventory；共享组件必须有 Figma ↔ Lit Mapping 与 Variant Coverage Matrix，不能依靠页面名、路由判断或特殊 CSS 补丁表达实例差异。
- 组件公共变更传播以 Single Implementation Owner（单一实现所有者）为基础门禁：每个已映射 Figma Instance 必须由声明的同一个 Lit 自定义元素渲染。页面出现相同 `data-component-id` 但未使用声明 Tag 或 Instance 标识时，以 `AIH_COMPONENT_IMPLEMENTATION_MISMATCH` 阻断。
- 不用固定坐标复刻整页；绝对定位仅用于本来就需要叠放的局部元素。
- 不用整页截图充当交互页面；截图只能作为视觉参考或明确的内容资源。
- 使用稳定本地 Fixture 演示场景，不连接生产服务，除非用户明确要求。
- 使用场景声明的事件实际点击、输入或选择；Wireflow 状态暴露对应 `data-state-id`，组件局部状态暴露 `data-component-state`。浏览器必须观测动作发生后的真实状态变化，并按 `resultingStateIds` 的声明顺序核对，不能用最终可见节点反推中间过程。
- 每个本地资源由 `assets[].path` 指向真实文件，并在界面中实际使用；字体资源还必须出现在声明目标或其后代元素的计算字体族中。

## 最终检查

1. 运行生成检查，确认 README 与隐藏 JSON 投影和 `canonical-ui.ts` 无 drift。
2. 运行 typecheck、build 及 resolver 返回的全部测试和结构校验。
3. 首次使用或收到 `AIH_BROWSER_UNAVAILABLE` 时运行 `npm run install:browser`；构建后运行 `npm run validate:canonical-ui-runtime`，按 `scenarios` 实际操作每个主路径和分支，观察 Screen、State 与反馈。
4. 只在用户确认并已声明的视口执行路由与场景，先运行 `renderAssertions[].checks`，再按模式运行 `sourceParityAssertions[].checks`：`autonomous` 不要求来源比较；`guided` 只比较声明的视觉方面与局部；`exact` 对所有路由、场景和视口执行整页 `screenshot-match`。
5. `exact` 的运行截图必须在相同视口、设备像素比、字体、资源和 Mock 数据下与证据截图比较；通道容差与最大差异像素比例只读取 Contract，Agent 不得自行放宽。偏差超过阈值时报告 `AIH_VISUAL_SOURCE_PARITY_FAILED`，并输出包含 Figma/截图基线、实际截图、差异图、路由、视口、场景、差异比例和失败断言的 Repair Packet。
6. 核对 `assets` 的本地文件、加载结果与实际使用目标，校验 `designSources` 的证据内容哈希和覆盖范围。
7. 核对 `componentInventory` 已唯一覆盖全部 Figma 组件相关节点，`componentVariantCoverage` 已覆盖全部共享组件 Instance；浏览器逐项验证声明的 Lit Tag、`data-figma-instance-id`、Variant Attribute 与使用中的 Slot。
8. 捕获控制台错误、页面异常和资源请求失败；只允许本地服务器、`data:` 与 `blob:` 请求。
9. 仅当用户明确选择额外的键盘操作、读屏、焦点、触控尺寸或减少动画检查时，运行 `accessibility.checks` 中对应的检查；未声明 `accessibility` 时不得自动运行这些检查。
10. `exact` 只在阻断码完全属于 `repairPolicy.repairableBlockerCodes` 时生成 Repair Packet；随后必须路由到 `$repair-canonical-ui-visual`，由该技能按 Contract 固定实现策略修改允许路径，并在 `actionReportPath` 写入通过 Schema 校验的 Repair Action Report。本验证文档不拥有具体 HTML、CSS 或组件修改算法。修复前后的设计来源、截图基线、视觉策略、Canonical UI 业务语义、Use Cases 与 Wireflow 哈希必须一致；任何变化以 `AIH_VISUAL_REPAIR_SCOPE_VIOLATION` 阻断。
11. Validator 最多接受 3 次实现修复；第 3 次仍失败时报告 `AIH_VISUAL_REPAIR_EXHAUSTED`，保留每次差异比例、实际截图和差异图。来源缺失、哈希不一致、覆盖不完整、业务冲突、运行时错误、网络错误、无障碍错误等非修复码不得生成可执行 Repair Packet。
12. 运行 Product strict Profile；任何 FAIL、BLOCKED 或 NOT_RUN 都必须保留为 residual，不能表述为 ready。
13. 修复 operation 与全部检查通过后启动 Manifest 登记的 Canonical UI 开发服务器，读取其实际输出的 `[READY]` 评审地址并请求一次确认可访问。普通评审地址默认开启固定在每个页面右上方的不一致标记工具；只有干净预览才使用 `?annotate=0`。服务器进程必须在当前评审期间保持运行。
