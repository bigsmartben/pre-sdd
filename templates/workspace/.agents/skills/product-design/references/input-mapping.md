# 输入与语义映射

| 输入事实 | 权威位置 | 实例 |
|---|---|---|
| 产品目标、Actor、Use Case | 上游 `capabilities` / Use Cases，单一权威、只读 | `UC-001` 的目标不能由 `UC.md` 人类视图或页面布局反推 |
| 正式 Interaction Flow、Interaction State 和分支 | 上游原子 `capabilities` / Use Cases，只读，并按 Actor 过滤 | `ACTOR-001` 应用把 `INT-STATE-001` 映射为 DOM 的 `data-state-id` |
| Low-Fi Screen、Region、Layout 和 Control | 上游原子 UC 内部建议，只读但不要求结构或像素复刻 | `LF-SCREEN-001` 可被 UI HTML 重组为多个实际 Screen，只要正式流程语义不变 |
| 路由、组件局部状态、事件、动作和可执行场景 | `canonical-ui.ts` | `EVENT-001` 触发 `ACTION-001`，组件进入 Loading |
| 视觉来源、资源、令牌、视口、动画和无障碍 | `canonical-ui.ts`、Area 内设计来源证据与真实资源 | Figma 节点证据覆盖 `SCREEN-001` 的桌面默认态 |
| Figma Component Set、Main Component、Instance 与 Variant 身份 | Figma `design-context`，只读 | `1:10` Instance 指向 `1:3` Main Component 与 `1:1` Component Set |
| 组件语义职责、复用决定与 Lit 接口 | `canonical-ui.ts.componentInventory`、`componentMappings`、`componentContracts` | Figma `Mode=Default` 唯一映射为 `<status-card mode="default">`，并声明 Slot、Property、Attribute 与 Event |
| Variant、运行态、交互态和内容覆盖的有限组合 | `canonical-ui.ts.stateAxes`、`stateMatrix` | `Mode=Default × status=loading × workflow=ready × message=default` 被标为合法并进入 State Gallery |
| Use Case → Interaction Flow → Screen / Control / State | `canonical-ui.ts.traceability` | `UC-001 → IF-001 → SCREEN-001` |

具体路径只从 `psp.project.yaml` 的 `authority`、`projections` 和 `areas` 读取。

## 开始界面工作前

用户明确说过运行环境时直接采用，不重复询问。没有说明时，先给出容易选择的答案并等待确认，例如：

- 电脑网页（推荐）
- 15 寸平板
- 手机
- 我说具体设备

用户选平板但没有说明方向时，再问“横屏”还是“竖屏”。只把确认后的尺寸写入 `viewports`，不得顺手增加其他设备、响应式范围或多套尺寸。

无障碍与辅助使用检查是可选范围。只有用户明确选择后才写入 `accessibility.checks`；未选择时不创建 `accessibility`。询问时使用“键盘操作和读屏等使用方式”这类普通说法，不要求用户理解标准名称。

`visualPolicy.mode` 必须先选择：无视觉输入为 `autonomous`，风格或局部参考为 `guided`，完整视觉参照或明确视觉还原为 `exact`。`unresolved` 只允许保留结构，不允许开始界面实现或通过 readiness。

`repairPolicy` 只声明当前应用的 `allowedImplementationPaths`。用户明确请求修复后，Agent 才调用本 Skill 随附的修复脚本开始一次修复；尝试次数、可修复缺陷类别和检查规则由 Canonical UI Artifact Contract 与领域脚本定义，不复制进模型。`autonomous`、`guided`、`exact` 均可修复一般 HTML/CSS/Lit 缺陷；`guided` 只在声明范围内使用来源，`exact` 额外执行完整来源一致性，`unresolved` 仍不得开始实现或修复。

`designSources[].coverage` 与 `visualPolicy.coverage` 使用 Screen、State、Viewport 和证据项标识表达可验证覆盖，不接受自由文本。`guided` 和 `exact` 中，`assets[].sourceIds`、`tokens[].sourceIds` 与 `sourceParityAssertions[].sourceId` 必须引用已采集来源；`autonomous` 可以使用空 `sourceIds` 表示自主设计事实。

组件覆盖与视觉覆盖分开表达：

- `componentInventory` 必须逐一归类 Figma `design-context.components` 中的节点，不能用 Screen 级视觉覆盖代替组件抽象决定。
- `componentMappings` 只登记确认后的共享组件，要求 Figma 属性与 Lit Property / Attribute / Slot 有显式对应。
- `componentVariantDefinitions` 完整登记 Component Set 的全部 Main Component Definition 与 Lit Attribute，即使某个 Variant 尚未被页面使用也不得遗漏。
- `componentVariantCoverage` 以 `definitionId` 绑定实际 `usages=[{instanceNodeId,screenId}]`；未使用 Definition 保留空 `usages`，每个使用中的共享组件 Instance 必须且只能出现一次。
- `componentContracts` 把每个组件收敛为唯一 Lit 接口；存在 Figma 来源时必须把共享组件映射与 Figma Instance 双向绑定到页面实例，`autonomous` 组件则保持无 Figma 身份的提供方中立契约。页面不得复制内部结构绕过该接口。
- `stateAxes` 为四类状态分别枚举有限值；`stateMatrix` 必须完整分类全部组合。UI ViewModel、UI Case Mock 与组件契约测试只能消费这份矩阵，不得维护平行状态清单。
- `primitive-only` 与 `local-structure` 不得创建 Lit 共享组件映射，避免仅凭视觉相似进行过度抽象。

`renderAssertions` 只检查页面自身健康，例如溢出、裁切和目标可见；`sourceParityAssertions` 检查实现是否遵循指定视觉来源。例如，`guided` 只声明 `typography` 和 `color` 时允许重新组织未覆盖布局，但字体或颜色不匹配必须阻断；`exact` 必须包含整页 `screenshot-match`。

`data-state-id` 只能表示 UC 的正式 Interaction State；组件局部状态使用 `data-component-state`。事件与动作使用独立的 `data-event-id`、`data-event` 和 `data-action-id`，不得用一个字段混写。每个场景事件必须且只能对应一个动作，事件控件的 `data-action-id` 必须等于该动作标识。
