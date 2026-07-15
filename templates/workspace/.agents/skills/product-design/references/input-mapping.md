# 输入与语义映射

| 输入事实 | 权威位置 | 实例 |
|---|---|---|
| 产品目标、Actor、Use Case | 上游 `product-package` / `capabilities`，只读 | `UC-001` 的目标不能由页面布局反推 |
| Screen、Control、Wireflow 状态和分支 | 上游 `interactions`，只读 | `WF-STATE-001` 映射为 DOM 的 `data-state-id` |
| 路由、组件局部状态、事件、动作和可执行场景 | `canonical-ui.ts` | `EVENT-001` 触发 `ACTION-001`，组件进入 Loading |
| 视觉来源、资源、令牌、视口、动画和无障碍 | `canonical-ui.ts`、Area 内设计来源证据与真实资源 | Figma 节点证据覆盖 `SCREEN-001` 的桌面默认态 |
| Use Case → Wireflow → Screen / Control / State | `canonical-ui.ts.traceability` | `UC-001 → WF-001 → SCREEN-001` |

具体路径只从 `psp.project.yaml` 的 `authority`、`projections` 和 `areas` 读取。

`designSources[].coverage` 使用 Screen、State、Viewport 和证据项标识表达可验证覆盖，不接受自由文本。`assets[].sourceIds`、`tokens[].sourceIds` 和 `visualAssertions[].sourceIds` 必须引用可用来源。

`data-state-id` 只能表示 Wireflow 页面或流程状态；组件局部状态使用 `data-component-state`。事件与动作使用独立的 `data-event-id`、`data-event` 和 `data-action-id`，不得用一个字段混写。每个场景事件必须且只能对应一个动作，事件控件的 `data-action-id` 必须等于该动作标识。
