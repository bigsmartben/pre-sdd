---
name: implement-canonical-ui
description: 将已经登记的 Product Design 语义与视觉事实实现为工作区 Canonical UI Prototype（规范界面原型）中的 Lit + Vite 组件、页面、路由和运行状态。用于首次创建 UI HTML，或在 Reopen、上游版本变化和正式规格更新后执行正常实现；覆盖 autonomous（自主设计）、guided（部分参考）和 exact（完全实现），并支持 figma、screenshot、export、other 或无设计来源。实现缺陷的单次修复由 repair-canonical-ui 独立负责。
---

# 实现 Canonical UI

## 边界

本技能拥有 Canonical UI Prototype 的正常实现：首次创建 HTML、CSS、Lit 组件与页面，以及产品事实或视觉事实更新后的规格驱动实现。它不拥有 Validator（校验器）判定后的 Repair（修复）事务，也不生成生产 Web、SwiftUI、Android 映射或下游代码生成规则。

开始前必须加载 `$product-design` 和 `$apply-repository-harness`，按项目绑定确认：

- Product Design 阶段允许修改，且上游 Atomic Use Cases（原子用例，含正式 Interaction Flow）与 Visual Spec 已经 ready、无 gap；
- 用户已经确认主要运行环境；
- `visualPolicy.mode` 是 `autonomous`、`guided` 或 `exact`，不是 `unresolved`；
- Product Design 已经在 `canonical-ui.ts` 登记 Route、Screen、Component、Control、Event、Action、Scenario、State、Component Contract、来源和追溯等当前实现所需事实；Figma 来源还必须登记当前 Registration Packet、全部 Variant Definition、Instance Usage Coverage、State Axis Render Binding 和组件来源基线；
- Product Design 已经用 Component Contract 的 `implementationRole`、`litTagName`、`pageInstances` 与 `implementationPaths` 明确组件、唯一应用外壳和实现所有权，并用 Token 的 `targetIds` 与 `cssProperty` 明确样式绑定；实现者不得自行改写这组上游决定；
- Resolver（解析器）允许目标实现路径写入。

任何条件返回 `BLOCKED` 时停止对应写入并保留原始 blocker code（阻断码）。`unresolved` 必须以 `AIH_VISUAL_POLICY_UNRESOLVED` 停止，不得先写一个猜测版本。

`$product-design` 独立拥有产品语义、`canonical-ui.ts`、视觉策略、来源登记、临时预览、正式 Review Evidence（评审证据）、Feedback Packet（反馈包）路由、Publish 与 Reopen。本技能只消费这些事实并写正常实现；不得从图层名、截图、现有代码或实现便利性反推业务状态，也不得直接修改 `src/spec/**` 来绕过缺失登记。

正常实现包括首次创建，以及 Reopen、上游输入版本变化或正式规格变化后的重建。只有在产品和视觉事实不变、用户明确请求修复、`canonical-ui-repair --new-session` 返回 `AIH_UI_REPAIR_REQUIRED` 与 Schema 有效 Repair Packet 时，才路由到 `$repair-canonical-ui`；本技能不得自行启动 Repair、消费 Repair Packet 或执行自由试错循环。

## 来源路由

按 `visualPolicy.mode` 与 `designSources[].kind` 选择最小实现路径：

- `autonomous`：允许 `designSources`、`sourceParityAssertions`、Figma Mapping 与来源 Asset 为空。根据 ready Visual Spec、正式语义、Component Contract 和用户确认的 Viewport 自主实现；不得把自主决定伪装成来源事实。
- `guided`：只实现 `visualPolicy.aspects` 与 `coverage` 声明的来源约束，未覆盖部分允许自主设计。`partial` 来源只在 guided 中有效。
- `exact`：所有确认的 Screen、State、Viewport 与 Scenario 必须由 `available` 来源完整覆盖，并运行登记的来源一致性检查；不得用整页截图替代真实交互 DOM。
- `screenshot`、`export`、`other`：只消费 Product Design 已登记且通过哈希校验的 Evidence（证据）、Asset、Token 和覆盖关系；不要求 Figma Capture Plan、Component Mapping 或 `data-figma-instance-id`。
- `figma`：来源必须先由 `$figma-workflow` 完成完整审计、写回批准、受控写回、最终人工验收、冻结、正式采集与 Asset Ingest，再由 Product Design 登记。Figma 相关节点还必须闭合 Registration Handshake（登记握手）、Component Inventory、Product Design 独立创建的 Figma ↔ Lit Mapping、Variant Definition Coverage（定义覆盖）、Instance Usage Coverage（使用覆盖）、Capture Plan、Ingest Receipt、`evidence.json`、Component Source Parity Assertion（组件来源一致性断言）与 Asset 消费目标。证据缺失、过期、来源版本变化或 Component Set 接口事实变化时停止并返回 `$figma-workflow`；Canonical ID 或产品接口登记漂移时返回 `$product-design`。

每次正常实现都必须读取 `references/implementation-reuse.md`，先完成工程勘察与 Reuse Plan（复用计划）。需要一般视觉实现与验证细节时读取 `references/visual-qa.md`；只有当前范围包含 Figma 来源时，额外读取 `references/figma-visual-qa.md`。

## 工作流

1. **确认正常实现范围**
   - 用户明确要求组件时，只实现指定组件及其登记依赖。
   - 用户明确要求页面时，实现页面、所需组件、已登记路由与场景。
   - 首次创建或上游规格更新时，以当前 Draft 的 Actor、Route、Screen、State、Scenario、Viewport 和 `implementationPaths` 为边界。
   - 范围不明确、语义入口缺失或上游输入漂移时停止，返回 Product Design；不得从旧 HTML 猜测新的正式事实。
   - 写入前扫描当前入口、Router（路由器）、已注册自定义元素、Component Contract、`implementationPaths`、共享样式、CSS Custom Property、状态模块、Mock、依赖和测试，形成临时 Reuse Plan：`Route → Screen → App Shell → Page Instance → Lit Tag → implementationPaths → Token`。
   - Reuse Plan 必须覆盖本次全部 Route、Screen 和 Component，且每项都能回指 `canonical-ui.ts`；它只是执行证据，不是新规格，不得覆盖或扩写上游语义。覆盖不全、所有权冲突或无法确定唯一实现对象时以 `AIH_COMPONENT_CONTRACT_INVALID` 停止。
   - 固定实现优先级为：已有 Contract 组件 → 已有 App Shell（应用外壳）或 Feature Shell（功能外壳）→ 已有 Layout/Style Primitive（布局/样式基础件）→ Slot（插槽）组合 → 页面局部结构 → 上游已经登记的新组件。命中前一层时不得继续创建后一层的平行实现。
   - 发现未登记组件、多个候选外壳、实现路径所有权冲突、已有 Token 被字面量绕过，或需要新 Router、全局状态、API/Mock 层、样式根或依赖时停止并返回 Product Design；不得边写边猜。运行结果旁路已登记 Lit Tag、Page Instance 或 Contract Host 时统一以 `AIH_COMPONENT_IMPLEMENTATION_MISMATCH` 阻断。

2. **汇合已经登记的事实**
   - Use Cases 提供目标、权限、业务规则和正式 Interaction Flow。
   - Low-Fi UI Blueprint 只提供 Screen、Control 与布局建议，可以按可用性重组，但必须保持正式行为可达。
   - `canonical-ui.ts` 提供 Route、Screen、Component、Control、Event、Action、Scenario、State、Contract、Variant Definition、Instance Usage、Render Binding 与追溯。
   - Visual Spec、`visualPolicy` 和来源证据只在声明范围内提供布局、字体、尺寸、资源、视觉层级和状态外观。
   - 缺失业务或视觉事实时返回 `$product-design` 登记，不在实现代码中建立平行事实来源。

3. **实现提供方中立的 Lit 组件**
   - 每个共享组件先复用 `componentContracts[].implementationPaths` 中已经登记的实现；只有 Contract 明确登记新组件且没有可满足接口的现有组件时，才按 `litTagName` 创建自定义元素并登记 `HTMLElementTagNameMap`。
   - 使用响应式 Property 表达内容和状态，使用反射 Attribute 表达公开 Variant，使用 Slot 表达可替换子内容，使用带类型的 `CustomEvent` 表达交互。
   - 使用已登记的 CSS Custom Property（自定义属性）连接设计令牌；同一语义已经存在 Token 时，不得新增近义变量、局部常量或字面量形成第二套风格。
   - 对 `exact` 模式中由 Figma 覆盖的实现路径，CSS 只允许尺寸、位置、Flex/Grid、间距、层级、溢出和文字排版；禁止背景、非透明边框、阴影、渐变、滤镜、遮罩、CSS 图形及带视觉内容的 `::before/::after`。`background:none`、`border:0` 等中性重置允许。
   - 修改必须落在能正确拥有该变化的最低层：跨页面共用行为修改组件，跨页面骨架修改 Shell 或 Layout Primitive，单页排布修改页面组合，实例差异只修改 Property、Attribute、Slot 或数据。
   - 完成 Contract 与 State Matrix 声明的默认、加载、成功、失败、空、禁用等合法状态，并实现 `stateAxisCoverage` 中全部 `modeled` 轴；不得为 `not-applicable` 轴制造平行接口。
   - Matrix Mount 只负责把声明输入送入 Lit Host，不得把 Host 上由 Harness 写入的 Attribute 或 State Marker 当成组件输出。Variant 必须同时进入登记的 Lit Property 与 Attribute；Runtime State 必须由组件内部可见节点呈现；Content Override 必须形成可观察内容。
   - Boolean Attribute 按 Lit presence semantics（存在语义）实现：`true` 写空 Attribute，`false` 移除 Attribute，不得写成字符串 `"false"`。Slot 内容必须分配到组件 Shadow DOM 中同名且可见的 `<slot>`，不能只把带 `slot` 属性的孤立 Light DOM 节点挂到 Host。
   - 非 Figma 组件不要求 `mappingId`、Figma Instance 身份或 Figma Variant；不得为了通过 Figma 专用检查伪造这些字段。
   - Figma `shared-component` 先消费 Registration Handshake 的来源事实，再逐项消费 Product Design Mapping 登记的 Lit Tag、Property、Attribute、Slot、Event 与全部已定义 Variant；`primitive-only` 只复用低层结构，`local-structure` 留在页面组合中。
   - 实现独立 Component Preview（组件预览）入口；State Gallery 与 Component Contract Test 必须共用同一个 Matrix Mount，每次只挂载一个 Contract 声明的 Lit Tag，并真实应用所有 Render Binding。

4. **组装页面**
   - 页面必须按 Reuse Plan 复用已有 App Shell、布局框架、自定义元素和样式系统，不复制共享组件内部模板，也不新建平行页面根。
   - 页面阶段只调整 Contract 允许的 Property、Attribute、Slot、数据、布局容器和页面样式。
   - 每个页面组件宿主声明唯一的 `data-component-id` 与 `data-component-instance-id`；Figma 映射实例额外声明唯一的 `data-figma-instance-id`，并使用 Definition 与 Usage Coverage 指定的 Attribute 与 Slot。
   - 非 Figma 页面只声明通用的 Component、Instance、Screen、State、Control、Event 和 Action 身份，不添加虚假的 Figma 标记。
   - 缺少 Contract、合法 State Matrix 组合或 Figma 专用映射时停止并返回 Product Design；接口需要改变时先更新正式事实，再重新进入正常实现。

5. **绑定路由、状态与场景**
   - 路由以 `canonical-ui.ts.routes` 为事实来源，优先使用普通链接、`history.pushState`、`popstate` 和根 Lit 组件渲染。
   - 正式 Screen 与 Interaction State 使用 `data-screen-id` 与 `data-state-id`；组件局部状态使用 `data-component-state`。
   - Control、Event 和 Action 使用各自独立标识；不得把业务状态和组件状态混写。
   - 组件局部状态使用 Lit 响应式属性；只有确需跨组件共享时才创建小型、带类型的原生 TypeScript 状态模块。
   - 网络场景使用工程已有 Mock Service Worker（模拟服务工作线程），不连接生产服务。
   - 按 `scenarios` 实际触发事件并观察声明的中间、最终与恢复状态。

6. **使用已经登记的资源**
   - 所有模式都只使用 `canonical-ui.ts.assets` 登记且真实存在、哈希一致的本地资源，并实际绑定每个 `consumerTargets`。
   - `autonomous` Asset 可以使用空 `sourceIds`；有来源的 Asset、Token 和视觉断言必须引用有效的 `designSources`。
   - screenshot、export 或 other 来源中的整页基线不是交互 Asset；不得用它覆盖文字、按钮、输入、链接和状态反馈。
   - Figma `asset` 还必须存在于 Capture Plan、Ingest Receipt 与最终 `evidence.json`。含视觉内容的 Group 以 `assetBoundaryNodeId` 整体导出和使用，其子节点不得单独导出后在 HTML 中拼接。
   - Figma 覆盖区域不得用背景、边框、阴影、渐变、滤镜、遮罩、伪元素、内联 SVG、Canvas 或多层 DOM 图形替代来源视觉；CSS 只负责布局与文字排版。

7. **交付临时预览**
   - 页面和已确认交互达到可运行状态后，立即按 `$product-design` 调用 Manifest 登记的 `canonical-ui-dev` Preview Operation（预览操作）。
   - 读取命令实际输出的 HTTP 地址，请求确认可访问后把可点击地址提供给用户；不得猜测默认端口。
   - 命令输出 `?review=0` 正式产品预览地址；这里只是临时预览入口，不产生正式 Review Evidence，也不得等待 Repair、Product strict Profile 或正式 readiness 全部通过。
   - `canonical-ui.ts.reviewTools` 声明的不一致标记、UI Case 切换器和交互分支驱动器都不属于下游产品实现范围；本技能不得修改、复制或把它们登记成产品页面、控件或功能。
   - 地址交付后停止在实现职责边界；由 `$product-design` 等待、校验并路由 Feedback Packet，不在本技能内开始反馈、Review 或 Publish 生命周期。

8. **执行验证并停止在责任边界**
   - 地址交付后执行 Resolver 返回的全部命令，并运行当前模式已登记的类型、构建、运行、组件、路由、场景、Asset 与来源一致性门禁。
   - `autonomous` 不执行来源比较；`guided` 只比较声明的方面和覆盖范围；`exact` 比较全部确认范围。
   - Figma 页面额外验证每个映射 Instance 只出现一次，并使用声明的 Lit Tag、Component ID、Instance ID、Variant Attribute 与 Slot；缺标记、错误 Tag、孤立 Marker 或 Host 外 Control/State 统一以 `AIH_COMPONENT_IMPLEMENTATION_MISMATCH` 返回。
   - 对每条合法 Matrix Entry 验证全部 Variant Attribute 与对应 Lit Property、组件内部呈现且同轴互斥的 Runtime State、正式 Scenario 中可观察的 Interaction State，以及形成可见内容的 Property、Attribute 或已分配 Slot；Exact 模式对每个 Figma Page Instance × Viewport × 合法 Matrix Entry 使用唯一组件基线比较隔离 Lit Host。
   - 运行截图和差异图只写操作系统临时目录；像素容差只读取 Artifact Contract，不得手工放宽。
   - 未通过项作为 residual 报告并阻止正式 readiness，但不得撤回仍可访问的临时预览地址。
   - 可修复缺陷只报告并等待用户明确请求；不得在本技能内调用 `canonical-ui-repair`、修改基线或开始第二轮实现尝试。

## Lit 组件接口示例

```ts
export class StatusCard extends LitElement {
  static properties = {
    state: { type: String, reflect: true },
    label: { type: String },
  };

  declare state: 'default' | 'loading' | 'success' | 'error';
  declare label: string;
}
```

页面通过 `<status-card state="loading">`、Property、Attribute、Event 和 Slot 组装，不复制组件内部结构。存在 Figma Mapping 时再附加登记的 Figma Instance 身份；没有 Figma 来源时保持提供方中立。

## 可运行完成条件

- 已确认范围内的组件、页面、路由和交互状态可以由本地 HTTP Server 实际打开。
- 页面保持真实 DOM、CSS、Lit 组件、资源和可操作状态，不以整页图片代替。
- 已读取服务器输出并验证实际地址，向用户提供临时预览入口。
- 尚未通过的严格门禁作为 residual 列出，没有自动进入 Repair。

## 正式就绪附加条件

- 路由、状态、事件、动作和追溯与 `canonical-ui.ts` 一致。
- Component Contract、Variant Definition、Instance Usage、State Axis、State Matrix 与页面实例闭合，页面没有旁路实现。
- Reuse Plan 的每个决策都回指上游 Contract；实际 DOM 使用声明的 App Shell 与 Lit Tag，实际 CSS 使用已登记 Token，不存在重复 Router、状态层、API/Mock 层、样式根或等价组件。
- 资源路径、哈希、来源引用和消费目标闭合，资源实际加载且没有占位图。
- guided 只实现声明覆盖；exact 使用固定 Contract 容差执行完整来源一致性，且按 Product Design 规则取得 Human Visual Acceptance。
- Figma 范围额外满足 Registration、Component Inventory、Mapping、Definition+Usage 双覆盖、Component Source Parity、Capture Plan、Ingest Receipt 和正式 Asset 闭包。
- 视觉实现修复只由用户明确请求后的 `$repair-canonical-ui` 独立执行。
- 没有写入生产代码映射、未确认设备范围或未登记业务事实。
