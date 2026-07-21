---
name: implement-figma-lit-page
description: 将 Figma 节点、Frame（画框）或完整页面实现为工作区 Canonical UI Prototype（规范界面原型）中的 Lit + Vite 组件和页面，并使用现有来源证据、语义模型、Mock Service Worker（模拟服务工作线程）与像素一致性门禁验证。用户要求复刻、还原或精准匹配 Figma 组件或页面时使用。
---

# 实现 Figma Lit 页面

## 边界

本技能只实现 Product Design（产品设计）阶段的 Canonical UI Prototype，不生成生产 Web 映射，也不定义下游平台代码生成规则。

开始前必须加载 `$product-design` 和 `$apply-repository-harness`，按项目绑定确认：

- 产品阶段和上游原子 Use Cases（含正式 Interaction Flow）已经就绪；
- 用户已确认主要运行环境；
- `visualPolicy.mode` 已确定；
- Figma 节点证据、截图、变量和资源可复现；
- Figma 组件相关节点已在 `componentInventory` 中唯一归类，共享组件已具备通过校验的 `componentMappings` 与 `componentVariantCoverage`；
- Resolver（解析器）允许目标路径写入。

任何条件返回 `BLOCKED` 时停止对应写入并保留原始 blocker code（阻断码）。

Figma 来源尚未形成通过 Schema 校验的本地证据，或证据采集后发生过图层、变量、组件、Variant 或其他 Figma 写入时，停止实现并路由到 `$capture-figma-design-source`。本技能只消费冻结节点的最终证据，不执行 Figma 连接器采集，也不在视觉失败后拥有代码修复循环。

首次代码写入前，所有实现所需资源必须已经存在于最终 `evidence.json`、通过内容哈希校验，并由 Product Design 登记到 `canonical-ui.ts.assets`。缺少资源、来源版本或登记关系时停止实现，返回来源采集或 Product Design 登记步骤；不得边写组件边补采集。

需要详细视觉验证时读取 `references/visual-qa.md`。

## 工作流

1. 判断请求范围。
   - 用户明确要求组件时，只实现指定组件。
   - 用户明确要求页面时，检查页面依赖的组件并复用已有实现。
   - 只有 Figma 链接或范围不明确时停止实现，先确认目标 `nodeId`、Screen、State、Viewport、组件范围和页面范围；未确认时报告 `BLOCKED`，不得先实现猜测出的组件或页面。

2. 汇合事实。
   - Use Cases（用例）提供目标、权限和业务规则。
   - 原子 Use Case 的 Interaction Flow 提供正式状态和分支；Low-Fi UI Blueprint 只提供 Screen、Control 与布局建议，可由实现重组。
   - `canonical-ui.ts` 提供 Route、Component、Event、Action、Scenario 和追溯。
   - `guided` 或 `exact` 覆盖范围内的布局、字体、尺寸、资源和视觉层级来自已采集 Figma 证据。
   - `componentInventory` 决定哪些节点是共享组件、Primitive 或页面局部结构；`componentMappings` 决定 Lit Tag、Property、Attribute、Slot 和 Event；`componentVariantCoverage` 决定每个 Figma Instance 的实际接口值。
   - 不从图层名或视觉外观反推业务事实。

3. 逐个实现 Lit 组件。
   - 只实现 `componentInventory.decision: shared-component` 且已有正式映射的组件；`primitive-only` 只复用低层样式或结构，`local-structure` 留在页面组合中。
   - 每个共享组件必须使用 `componentMappings[].litTagName` 创建自定义元素，并登记 `HTMLElementTagNameMap`。
   - 使用响应式属性表达内容和 Variant，使用 Slot（插槽）表达可替换子内容，使用带类型的 `CustomEvent` 表达交互。
   - 映射声明的 Variant Property 必须反射为对应 Attribute；不得新增未映射的页面专用公共属性。
   - 使用 CSS Custom Property（自定义属性）连接设计令牌。
   - 在组件阶段完成默认、加载、成功、失败、空、禁用等已声明状态。
   - 每完成一个组件，运行对应的来源比较，再进入下一个组件。

4. 组装页面。
   - 页面将 Figma 组件视为实例，使用已有自定义元素，不复制其内部模板。
   - 每个映射实例在自定义元素宿主上声明 `data-component-id` 与 `data-figma-instance-id`，并使用覆盖矩阵指定的 Variant Attribute 与 Slot。
   - 页面阶段只调整属性、Slot、数据、布局容器和页面样式。
   - 缺少映射或 Variant 覆盖时以 `AIH_COMPONENT_ABSTRACTION_UNRESOLVED` 停止并返回 Product Design 登记；接口确需改变时回到 `$figma-component-from-design` 重新确认，写回后重新采集。不得在页面组装中偷偷新增接口或复制内部实现。

5. 路由和状态。
   - 路由以 `canonical-ui.ts.routes` 为事实来源，优先使用普通链接、`history.pushState`、`popstate` 和根 Lit 组件渲染。
   - 组件局部状态使用 Lit 响应式属性。
   - 只有确需跨组件共享且现有工程没有合适机制时，创建小型、带类型的原生 TypeScript 状态模块。
   - 网络场景使用工程已有 Mock Service Worker，不连接生产服务。

6. 使用已闭合资源。
   - 只使用已经存在于 `evidence.json` 且登记到 `canonical-ui.ts.assets` 的资源。
   - 校验 `canonical-ui.ts.assets[*].sourceIds`、实际路径、使用目标和证据清单中的 `role: asset` 项一致。
   - 发现缺少 `Export/` 资源、PNG 校验、清单哈希或使用目标时停止当前实现；返回 `$capture-figma-design-source` 或 Product Design 登记步骤完成闭环后，再从首次代码写入前的输入门禁重新开始。
   - 不用整页截图替代可交互页面或可复用组件。

7. 绑定可执行语义。
   - 实际 Screen 和正式 Interaction State 使用 `data-screen-id` 与 `data-state-id`。
   - 组件局部状态使用 `data-component-state`。
   - Control、Event 和 Action 使用各自独立标识。
   - 按 `scenarios` 实际触发事件并观察声明的中间状态和最终状态。

8. 验证。
   - 页面与已确认的交互路径达到可运行状态后，立即按 `$product-design` 启动并请求实际 HTTP 评审地址，把可点击地址提供给用户；这一步不得等待视觉修复、Product strict Profile 或正式 readiness 全部通过。
   - `autonomous` 只执行页面健康检查。
   - `guided` 只比较已声明的视觉方面和覆盖区域。
   - `exact` 对全部确认路由、场景和视口执行来源截图匹配。
   - 像素通道容差和最大差异比例只读取 Artifact Contract（产物契约），不得手工放宽。
   - 运行截图和差异图写入操作系统临时目录，不提交为用户事实。
   - 地址交付后执行 Resolver 返回的全部命令；未通过项必须作为 residual 报告，并阻止正式就绪或移交，但不得阻止或撤回仍然可访问的评审地址。
   - 浏览器门禁必须验证每个 `data-figma-instance-id` 只出现一次、使用声明的 Lit Tag、Component ID、Variant Attribute 和 Slot；同一 Component ID 的旁路实现以 `AIH_COMPONENT_IMPLEMENTATION_MISMATCH` 阻断。
   - `exact` 出现可修复来源差异时停止正式就绪流程，调用 `canonical-ui-repair` 生成 Repair Packet，再交给 `$repair-canonical-ui-visual`；不得在本技能内自由试错或修改基线，也不得用该差异阻塞已经可运行的评审地址。

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

页面通过 `<status-card state="loading">`、属性绑定、事件和 Slot 组装，不复制组件内部结构。

## 第五步可运行完成条件

- 已确认范围内的 Lit 组件、页面、路由和交互状态可以由本地 HTTP Server 实际打开。
- 已读取服务器输出并请求验证实际地址，向用户提供默认带不一致标记工具的可点击地址。
- 尚未通过的来源一致性或严格门禁已作为 residual 列出，后续从评审地址进入反馈与修复循环；不能因为这些问题扣留地址。

## 正式就绪附加条件

- 组件先于页面完成并分别通过视觉比较。
- 页面复用了已有自定义元素。
- Component Inventory、Figma ↔ Lit Mapping 与 Variant Coverage Matrix 全部闭合，页面没有旁路实现。
- 路由、状态、事件、动作和追溯与 `canonical-ui.ts` 一致。
- 资源证据、清单哈希、`designSources` 和 `assets` 已闭合，资源实际加载且没有占位图。
- `exact` 模式使用固定 Contract 容差通过来源一致性门禁。
- 视觉差异修复已由 `$repair-canonical-ui-visual` 独立执行，本技能没有改变基线或验收条件。
- 没有写入生产代码映射或未确认设备范围。
