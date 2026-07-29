---
name: repair-canonical-ui
description: 用户明确要求修复 Canonical UI Prototype（规范界面原型）实现时使用：先调用 canonical-ui-repair；只有返回 AIH_UI_REPAIR_REQUIRED 和 Schema 有效的 Repair Packet（修复数据包）后，才对 HTML、CSS、Lit 模板、组件渲染、资源绑定或机器可判定的来源差异执行一次有边界的 Agent 实现修复。适用于 autonomous、guided 和 exact 三种已解析视觉模式；不负责 Review、预览服务、反馈路由、发布、来源变更或主观美化。
---

# 修复 Canonical UI

## 边界

本技能只拥有一次有边界的 Canonical UI 实现修复。正式 Review、反馈路由、Publish 与 Reopen 生命周期由 `$product-design` 拥有；`canonical-ui-dev` 临时预览服务、Review Marker 和 Review Evidence 都不属于本技能。

开始前加载 `$product-design`。只有用户明确请求本次修复后，才首次调用本 Skill 随附的修复脚本并传入 `--new-session`；脚本返回 `PASS` 时立即完成，不修改任何文件。

Review Feedback Packet（评审反馈包）只表达用户反馈，不是 Repair Packet，也不授权修复。必须先由领域 Validator（校验器）形成机器可判定诊断，并由修复脚本生成有效 Repair Packet；无法形成该数据包的反馈必须返回 `$product-design` 保留为未解析反馈，不得按主观判断修改。

只有状态为 `REPAIR_REQUIRED` 且通过 Schema 校验的 Repair Packet 是本次写入依据。Validator（校验器）负责判定、截图和生成 Repair Diagnostic（修复诊断），Agent 只修改 `allowedImplementationPaths` 指定的实现范围。不得修改 `src/spec/**`、Mock 数据、业务状态逻辑、设计来源、截图基线或视觉容差。

以下缺陷可以进入本技能：

- `html-structure`：DOM、Lit Tag、Slot、Property、Attribute、Variant 或挂载结构不符合已登记契约。
- `css-rendering`：布局、计算样式、溢出、重叠、裁切、可见性、视口或文本行数失败。
- `html-accessibility`：已登记的名称、ARIA、可聚焦、焦点样式、触控尺寸或减少动画检查失败。
- `asset-binding`：已登记资源没有加载或没有被声明目标使用。
- `component-contract`：组件契约的渲染、结构或语义断言失败。
- `source-parity`：guided/exact 中已登记、机器可判定的来源样式或结构检查失败。

业务状态迁移、API、网络、控制台异常、服务器、构建、类型检查、来源完整性、来源写回、主观美化和人工视觉接受不属于本技能。`AIH_VISUAL_PIXEL_DIAGNOSTIC` 是非阻塞诊断，不得作为修复授权或 Repair Packet 输入。Repair Packet 混入任何没有完整诊断或不可修复失败时停止。

## 实施规则

1. Evidence before edit（先证据、后修改）：读取每个诊断的 `gateId`、`defectClass`、范围、expected/actual 和证据路径。
2. Preserve interactive DOM（保留真实交互 DOM）：不得用整页或整组件截图覆盖文字、按钮、输入、链接和状态反馈。
3. Source resolution when source-backed（有来源时先解析来源）：guided/exact 优先复用已登记 SVG、PNG、字体和令牌；autonomous 不凭空制造来源事实，不凭视觉感觉补值。
4. Minimal implementation scope（最小实现范围）：组件问题改组件，页面问题改页面；不得用页面级覆盖掩盖共享组件缺陷。
5. Stable comparison environment（固定比较环境）：修复前后保持 Viewport、字体、资源、Mock 数据和动画设置一致。

按 `structure → geometry → typography → paint → effects → assets` 的顺序处理；有来源证据时先执行 `source-resolution`。

## 单次修复协议

1. 确认用户已明确请求本次修复，再使用 `canonical-ui-repair --new-session` 开始；`PASS` 立即完成。
2. 读取 `AIH_UI_REPAIR_REQUIRED` 返回的 Repair Packet，确认 `repairSessionId`、`attempt: 1`、允许路径和全部诊断。
3. 对全部诊断执行一次最小实现修改，不改变业务语义或验证输入。
4. 使用同一个领域脚本并传入 `--session <repairSessionId>` 重新验证。
5. 返回 `PASS` 时立即完成；返回 `AIH_UI_REPAIR_EXHAUSTED`、`AIH_UI_REPAIR_SESSION_INVALID` 或其他 `BLOCKED` 时立即停止，不开始第二次修复。

完成只由第二次 `canonical-ui-repair` 的真实 `PASS` 判定。Repair Action Report 是领域脚本生成的临时过程证据，不是写入前许可，也不触发 Preview、Review 或 Publish；完成后把控制权交回 `$product-design`，由它重新提供临时预览。
