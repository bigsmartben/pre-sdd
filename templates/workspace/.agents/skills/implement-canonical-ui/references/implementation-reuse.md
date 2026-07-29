# Canonical UI 工程复用协议

本协议约束正常 HTML/CSS/Lit 实现的第一步：先识别并复用工作区已经拥有的工程结构，再进行最小写入。它不产生新的产品事实，也不允许实现者改写 Product Design 已登记的 Component Contract。

## 两层权威

| 层 | 权威输入 | 决定 |
|---|---|---|
| 上游 Contract（契约） | Route、Screen、Component Contract、`implementationRole`、`litTagName`、`pageInstances`、`implementationPaths`、Token `targetIds`/`cssProperty`、State Matrix | 必须实现什么、复用对象是谁、状态和样式边界是什么 |
| Lit 工程规则 | 当前入口、Router、已注册自定义元素、Shell、布局基础件、共享样式、状态模块、Mock、依赖和测试 | 在不改变上游语义的前提下，如何以最小正确改动完成实现 |

现有代码只能证明“已经有什么”，不能反推业务语义。代码与 Contract 冲突时停止并返回 `$product-design`，不得选择更方便的一方继续实现。

## 写入前勘察

只读检查本次 Scope（范围）内的：

1. 应用入口、Router 与每个 Route 当前挂载的根 Lit Tag。
2. `customElements.define`、`@customElement`、`LitElement` 子类与 `HTMLElementTagNameMap`。
3. Component Contract 的 `litTagName`、`pageInstances`、`implementationPaths`、Property、Attribute、Slot、Event 与 State Matrix。
4. App Shell、Feature Shell、布局容器、共享样式、CSS Custom Property 与 Token 使用点。
5. 跨组件状态、Mock Service Worker、API 适配层、依赖和相关测试。

形成临时 Reuse Plan（复用计划）：

| Route | Screen | App/Feature Shell | Component / Page Instance | Lit Tag | implementationPaths | Token | 决策 |
|---|---|---|---|---|---|---|---|
| `/orders` | `SCREEN-ORDERS` | `app-shell` | `COMPONENT-ORDER-LIST` / `INSTANCE-ORDER-LIST` | `order-list` | `src/components/order-list.ts` | `--surface` | reuse |

每一行必须回指 `canonical-ui.ts`。没有上游身份的候选不得进入实现；没有覆盖全部当前范围前不得写入。

## 固定实现优先级

逐级判断，命中即停止向下创建：

1. 复用 Contract 已登记、接口可满足需求的现有 Lit 组件。
2. 复用现有 App Shell 或 Feature Shell，保持 Router 的单一页面根。
3. 复用现有 Layout/Style Primitive 与 CSS Custom Property。
4. 使用现有组件的 Property、Attribute、Slot、Event 和数据进行组合。
5. 只为当前页面创建不承载共享语义的局部结构。
6. 只有 Product Design 已登记新 Component Contract，且前五层均不能满足时，才创建新的 Lit 组件。

示例：页面需要带状态的提交卡片，工作区已有 `status-card` Contract。应给现有组件传入 `state`、内容 Slot 和 Event；不得复制其模板成为 `checkout-status-card`。

## 最低正确层

| 变化 | 修改层 |
|---|---|
| 多个页面共用的交互或视觉行为 | 共享 Lit 组件 |
| 多页面共同的导航、边栏或内容骨架 | App/Feature Shell 或布局基础件 |
| 单页组件排列 | 页面组合层 |
| 单个实例文案、Variant 或内容 | Property、Attribute、Slot 或数据 |
| 设计色、间距、圆角、字体已有 Token | 原 Token 与 CSS Custom Property |

不得用页面覆盖修复组件问题，也不得为一个实例改动全局 Shell。

## 必须停止的情况

| 情况 | 结果 |
|---|---|
| Contract 缺失、与现有实现不一致，或一个实现路径出现多个所有者 | `AIH_COMPONENT_CONTRACT_INVALID` |
| 一个 Screen 存在多个相互竞争的页面根，无法确定统一 Shell | `AIH_COMPONENT_CONTRACT_INVALID` |
| 页面旁路已登记 Lit Tag、Page Instance 或 Contract Host | `AIH_COMPONENT_IMPLEMENTATION_MISMATCH` |
| 需要新增或替换 Router、全局状态、API/Mock 层、样式根或依赖，但上游没有登记 | `AIH_COMPONENT_CONTRACT_INVALID` |
| 已有 Token 能表达目标样式，却需要新增近义变量、局部常量或字面量 | `AIH_COMPONENT_IMPLEMENTATION_MISMATCH` |
| 需要改变 Route、Screen、State、Event、Action、Scenario 或组件公开接口才能完成页面 | `AIH_COMPONENT_CONTRACT_INVALID` |

这些情况返回 `$product-design` 补齐或纠正 Contract。不得先创建临时代码再补登记。

## 完成检查

- 页面上的每个 `data-component-instance-id` 都来自 Contract `pageInstances`，宿主 Tag 与 `litTagName` 一致。
- Router 仍只有一条已登记实现路径；每个 Screen 使用 Reuse Plan 选择的统一 Shell。
- 共享模板、状态、Mock、样式根和设计 Token 没有第二份等价实现。
- 改动位于最低正确层，未修改 `src/spec/**`，未扩大 Component Contract 的公开接口。
- Component Contract、State Matrix、Route、Scenario、Asset 和视觉检查全部使用当前领域 Skill 随附的本地脚本验证。
