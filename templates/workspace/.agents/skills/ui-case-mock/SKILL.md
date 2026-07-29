---
name: ui-case-mock
description: 在 Product Design 中分析 UI Case 轴值覆盖、显式启动 headed UI Case Mock 评审，或无头验证 UI ViewModel 到正式 Lit 组件的视觉投影时使用。它只消费 Canonical UI 的 UI ViewModel、UI Case、Component Contract 与 State Matrix，不创建业务 Mock、独立产物或生命周期。
---

# UI Case Mock

## 责任边界

本 Skill 是 `$product-design` 的子能力，不是独立 Stage（阶段）或领域。

- UI ViewModel（界面视图模型）只通过 `{pageInstanceId, stateMatrixEntryId}` 选择 Component Contract（组件契约）已经声明的合法状态。
- UI Case（界面视觉用例）只组合 `ViewModel + Route + Viewport`，不包含 `useCaseId`、`scenarioId`、业务分类或技术分类。
- UI Case Mock（界面用例模拟）只把该有限状态投影到正式组件的公开 Property（属性）、Attribute（特性）和 Slot（插槽），等待 Lit `updateComplete`，执行视觉断言并回滚。
- Use Case（业务用例）、UC Case（业务路径用例）、UI Interaction Scenario（界面交互场景）和 Component Visual Case（组件视觉案例）的语义与结构仍由 `$product-design` 拥有。
- 不点击正式控件、不派发业务事件、不拦截 Fetch、不修改私有 DOM。模板中的 MSW 网络桩是独立能力。
- 不创建 Candidate、Suite、Fixture、Behavior 或独立就绪状态，不写工作区正式文件。截图和运行事实只写操作系统临时目录。

例如：`UI-CASE-002` 可以把同一页面上的列表组件投影为“空数据”，同时把提交按钮投影为“disabled / secondary”；它不能伪造“下单失败”这一业务路径。

## 单次意图路由

每次调用只执行用户明确表达的一种操作：

| 意图 | 命令 | 行为 |
|---|---|---|
| Analyze（分析） | `npm run analyze:ui-case-coverage -- --json`；可用 `--actor ACTOR-NNN` 收窄 | 默认只读检查全部参与者的默认 Entry 和每个 State Axis Value 是否至少被一个 UI Case 覆盖 |
| Review（评审） | `npm run review:ui-case-mock -- --actor ACTOR-NNN --headed` | 启动有界面的交互评审，等待用户结束或取消 |
| Verify（验证） | `npm run verify:ui-case-mock`；可用 `-- --actor ACTOR-NNN` 收窄 | 默认无头执行全部参与者的 UI Case × Viewport，生成临时截图与断言事实 |

只说 `$ui-case-mock` 而没有指定操作时，默认只执行 Analyze。Skill 名称或来源关系均不授权 Review、Verify 或任何写入。Analyze、Review、Verify 不串联，也不互相隐含。

## 执行规则

1. 读取 `psp.project.yaml`、Canonical UI 与本 Skill 的本地规则，直接选择用户明确请求的单次操作。
2. Analyze 读取 Canonical UI 与 Visual Spec，检查引用、Route 边界、合法 Matrix Entry、重复 Override、Viewport 和轴值覆盖；不写文件。
3. Review 必须由用户明确要求并带 `--headed`。`review=0` 不加载工具，`review=1` 才加载 `ui-case-switcher`。
4. Verify 必须无头执行所有 Case。每次投影前保存公开接口基线，切换 Case、Route 或退出时完整恢复；失败回滚不完整时返回 `AIH_UI_CASE_ROLLBACK_FAILED`。
5. 产品截图前隐藏所有 `[data-review-tool]` 元素，Review Tool 不得进入产品视觉证据。
6. 浏览器缺失时返回 `AIH_UI_CASE_BROWSER_MISSING`；Agent 可在后台准备依赖，不把安装命令交给用户。

## 稳定阻断

- `AIH_UI_CASE_CONTRACT_INVALID`：UI ViewModel、UI Case 或引用结构无效。
- `AIH_UI_CASE_COVERAGE_INCOMPLETE`：默认态或某个有限轴值没有 UI Case 覆盖。
- `AIH_UI_CASE_VISUAL_TRACE_INVALID`：Component Visual Case 无法解析到 Component Contract / State Matrix。
- `AIH_UI_CASE_TARGET_MISSING`：正式页面中找不到登记的组件实例。
- `AIH_UI_CASE_PROJECTION_CONFLICT`：一次请求试图同时投影多个页面组合态。
- `AIH_UI_CASE_ASSERTION_FAILED`：Render / Source Parity Assertion 失败。
- `AIH_UI_CASE_PLUGIN_FAILED`：Review Extension 无法加载或运行。
- `AIH_UI_CASE_ROLLBACK_FAILED`：切换或退出时未恢复基线。
- `AIH_UI_CASE_TIMEOUT`：Lit 稳定等待或状态观测超时。
- `AIH_UI_CASE_BROWSER_MISSING`：本地缺少已授权安装的 Chromium。
- `AIH_UI_CASE_REVIEW_CANCELLED`：用户取消交互评审。
