# 输入与语义映射

| 输入事实 | 权威位置 | 实例 |
|---|---|---|
| 产品目标、Actor、Use Case | 上游 `capabilities` / Use Cases，单一权威、只读 | `UC-001` 的目标不能由 `PSP.md` 摘要或页面布局反推 |
| Screen、Control、Wireflow 状态和分支 | 上游 `interactions`，只读 | `WF-STATE-001` 映射为 DOM 的 `data-state-id` |
| 路由、组件局部状态、事件、动作和可执行场景 | `canonical-ui.ts` | `EVENT-001` 触发 `ACTION-001`，组件进入 Loading |
| 视觉来源、资源、令牌、视口、动画和无障碍 | `canonical-ui.ts`、Area 内设计来源证据与真实资源 | Figma 节点证据覆盖 `SCREEN-001` 的桌面默认态 |
| Figma Component Set、Main Component、Instance 与 Variant 身份 | Figma `design-context`，只读 | `1:10` Instance 指向 `1:3` Main Component 与 `1:1` Component Set |
| 组件语义职责、复用决定与 Lit 接口 | `canonical-ui.ts.componentInventory`、`componentMappings`、`componentVariantCoverage` | Figma `Mode=Default` 映射为 `<status-card mode="default">` |
| Use Case → Wireflow → Screen / Control / State | `canonical-ui.ts.traceability` | `UC-001 → WF-001 → SCREEN-001` |

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

`repairPolicy` 固定声明 `maxAttempts: 3`、两个可修复视觉阻断码和允许修改的实现路径。`exact` 必须启用；`autonomous`、`guided` 与 `unresolved` 必须禁用，避免把局部参考误套用为整页像素修复。

`designSources[].coverage` 与 `visualPolicy.coverage` 使用 Screen、State、Viewport 和证据项标识表达可验证覆盖，不接受自由文本。`guided` 和 `exact` 中，`assets[].sourceIds`、`tokens[].sourceIds` 与 `sourceParityAssertions[].sourceId` 必须引用已采集来源；`autonomous` 可以使用空 `sourceIds` 表示自主设计事实。

组件覆盖与视觉覆盖分开表达：

- `componentInventory` 必须逐一归类 Figma `design-context.components` 中的节点，不能用 Screen 级视觉覆盖代替组件抽象决定。
- `componentMappings` 只登记确认后的共享组件，要求 Figma 属性与 Lit Property / Attribute / Slot 有显式对应。
- `componentVariantCoverage` 逐行登记使用中的 Figma Variant、Lit Attribute、Instance 与 Screen；每个共享组件 Instance 必须且只能出现一次。
- `primitive-only` 与 `local-structure` 不得创建 Lit 共享组件映射，避免仅凭视觉相似进行过度抽象。

`renderAssertions` 只检查页面自身健康，例如溢出、裁切和目标可见；`sourceParityAssertions` 检查实现是否遵循指定视觉来源。例如，`guided` 只声明 `typography` 和 `color` 时允许重新组织未覆盖布局，但字体或颜色不匹配必须阻断；`exact` 必须包含整页 `screenshot-match`。

`data-state-id` 只能表示 Wireflow 页面或流程状态；组件局部状态使用 `data-component-state`。事件与动作使用独立的 `data-event-id`、`data-event` 和 `data-action-id`，不得用一个字段混写。每个场景事件必须且只能对应一个动作，事件控件的 `data-action-id` 必须等于该动作标识。
