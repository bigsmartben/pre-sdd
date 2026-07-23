---
name: repair-canonical-ui
description: 对 Canonical UI Prototype（规范界面原型）的 HTML、CSS、Lit 模板、组件渲染、资源绑定或来源视觉差异执行一次有边界的 Agent 自动修复。用户明确要求修复界面实现，或 canonical-ui-repair 返回 AIH_UI_REPAIR_REQUIRED 和 Schema 有效的 Repair Packet（修复数据包）时使用；适用于 autonomous、guided 和 exact 三种已解析视觉模式。
---

# 修复 Canonical UI

## 边界

开始前加载 `$product-design` 与 `$apply-repository-harness`。首次调用 Manifest 登记的 `canonical-ui-repair` operation 时传入 `--new-session`；operation 返回 `PASS` 时立即完成，不修改任何文件。

只有 `REPAIR_REQUIRED` Repair Packet 是本次写入依据。Validator（校验器）负责判定、截图和生成 Repair Diagnostic（修复诊断），Agent 只修改实现。`allowedImplementationPaths` 是最小范围指导，不是代码写入许可；不得修改 `src/spec/**`、Mock 数据、业务状态逻辑、设计来源、截图基线或视觉容差。

以下缺陷可以进入本技能：

- `html-structure`：DOM、Lit Tag、Slot、Property、Attribute、Variant 或挂载结构不符合已登记契约。
- `css-rendering`：布局、计算样式、溢出、重叠、裁切、可见性、视口或文本行数失败。
- `html-accessibility`：已登记的名称、ARIA、可聚焦、焦点样式、触控尺寸或减少动画检查失败。
- `asset-binding`：已登记资源没有加载或没有被声明目标使用。
- `component-contract`：组件契约的渲染、结构或语义断言失败。
- `source-parity`：guided/exact 的来源样式或 exact 的截图一致性失败。

业务状态迁移、API、网络、控制台异常、服务器、构建、类型检查、来源完整性和主观美化不属于本技能。Repair Packet 混入任何没有完整诊断的失败时停止。

## 实施规则

1. Evidence before edit（先证据、后修改）：读取每个诊断的 `gateId`、`defectClass`、范围、expected/actual 和证据路径。
2. Preserve interactive DOM（保留真实交互 DOM）：不得用整页或整组件截图覆盖文字、按钮、输入、链接和状态反馈。
3. Source resolution when source-backed（有来源时先解析来源）：guided/exact 优先复用已登记 SVG、PNG、字体和令牌；autonomous 不凭空制造来源事实，不凭视觉感觉补值。
4. Minimal implementation scope（最小实现范围）：组件问题改组件，页面问题改页面；不得用页面级覆盖掩盖共享组件缺陷。
5. Stable comparison environment（固定比较环境）：修复前后保持 Viewport、字体、资源、Mock 数据和动画设置一致。

按 `structure → geometry → typography → paint → effects → assets` 的顺序处理；有来源证据时先执行 `source-resolution`。

## 单次修复协议

1. 使用 `canonical-ui-repair --new-session` 开始；`PASS` 立即完成。
2. 读取 `AIH_UI_REPAIR_REQUIRED` 返回的 Repair Packet，确认 `repairSessionId`、`attempt: 1`、允许路径和全部诊断。
3. 对全部诊断执行一次最小实现修改，不改变业务语义或验证输入。
4. 使用同一个 operation 并传入 `--session <repairSessionId>` 重新验证。
5. 返回 `PASS` 时立即完成；返回 `AIH_UI_REPAIR_EXHAUSTED`、`AIH_UI_REPAIR_SESSION_INVALID` 或其他 `BLOCKED` 时立即停止，不开始第二次修复。

完成只由第二次 `canonical-ui-repair` 的真实 `PASS` 判定。Repair Action Report 是 operation 生成的临时过程证据，不是写入前许可，也不触发 Publish 或 Handoff。
