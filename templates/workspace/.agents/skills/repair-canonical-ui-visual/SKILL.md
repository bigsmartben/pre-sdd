---
name: repair-canonical-ui-visual
description: 在 Canonical UI Prototype（规范界面原型）的 exact（完全实现）模式产生 Repair Packet（修复数据包）后，依据已采集设计来源和固定修复顺序修改允许的 Lit、HTML、CSS 或组件实现，并重新执行同一视觉门禁。用户要求修复 Figma 像素差异，或 canonical-ui-repair 返回 AIH_VISUAL_REPAIR_REQUIRED 时使用。
---

# 修复 Canonical UI 视觉差异

## 边界

本技能只执行 Agent-owned implementation repair（由 Agent 执行的实现修复）。开始前必须加载 `$product-design` 与 `$apply-repository-harness`，并先运行 Manifest 登记的 `canonical-ui-repair` operation（修复操作）取得符合 Schema 的 Repair Packet。

Validator（校验器）只判定、截图、计算差异和生成证据；Repair Packet 中的 `allowedImplementationPaths` 用于提示最小实现范围，不是代码写入许可。代码修改前不需要文件 hash 快照或预先创建 Action Report；修改是否有效只由下一次真实运行验证判断，验证通过后由 operation 生成 Repair Action Report 作为临时过程证据。Figma 证据、截图基线等外部输入仍受内容 hash 校验，若确需更新应重新采集并登记，而不是在修复循环中静默替换。

Repair Packet 是本轮修复的证据输入。它必须直接提供来源标识、设计上下文、来源证据项、检查类型、目标位置和截图；`screenshot-match` 失败还必须提供 `differenceRatio`、`differenceScreenshot` 与结构化 `differenceRegions`，`computed-style` 失败必须提供 `targetId`。状态不是 `REPAIR_REQUIRED`、失败含不可修复 blocker code（阻断码）或证据不可读取时停止，不尝试主观修复。

## 固定实现原则

1. Evidence before edit（先证据、后修改）。
   - 先读取失败断言、Figma 基线、实际截图、差异图和对应 `design-context`。
   - 找不到尺寸、字体、颜色、圆角、阴影、渐变、资源或状态依据时报告来源不完整，不凭视觉感觉补值。

2. Preserve interactive DOM（保留真实交互结构）。
   - 文字、按钮、输入、链接、状态反馈和可操作控件必须保留真实 DOM（文档对象模型）。
   - 禁止使用整页截图、整组件截图或大面积背景图覆盖真实界面来制造像素匹配。

3. Prefer source assets（优先来源资源）。
   - 已有 Figma SVG、PNG、字体、插画或复杂效果资源时优先复用。
   - CSS 只承担布局、排版、令牌绑定和无法独立导出的基础形状；不得用无来源参数的近似 CSS 替代已有设计资源。

4. Minimal implementation scope（最小实现范围）。
   - 共享组件内部错误修改共享组件；页面布局错误修改页面容器。
   - 不得用页面级覆盖样式掩盖共享组件缺陷。
   - 不重构与当前失败路由、场景、视口或组件无关的代码。

5. Stable comparison environment（固定比较环境）。
   - 修复前后使用相同 Viewport、设备像素比、字体、资源、Mock 数据和动画设置。
   - 不得通过改变内容、隐藏状态或缩减覆盖范围降低差异。

## 固定修复顺序

每轮严格按以下顺序定位并修复；前一层仍明显错误时不进入后一层的微调：

1. `source-resolution`：先判断现有 SVG、PNG、字体、插画或效果资源是否应直接复用，禁止先写近似 CSS 再寻找资源。
2. `structure`：DOM 层级、共享组件边界、区域顺序和真实交互结构。
3. `geometry`：Frame、位置、尺寸、间距、对齐、约束、裁切和溢出。
4. `typography`：字体、字号、字重、行高、字距、换行和文本宽度。
5. `paint`：颜色、透明度、填充、描边和圆角。
6. `effects`：阴影、模糊、渐变、混合模式和视觉层级。
7. `assets`：SVG、PNG、字体、图片裁切、透明边距和缩放。

## 修复循环

1. 读取 Repair Packet，确认 `attempt`、建议实现路径和失败断言。
2. 使用 `targetId` 或 `differenceRegions` 将每个失败定位到 Route、Scenario、Viewport、Component 和最小 DOM 区域；缺少 Schema 要求的位置证据时以 `AIH_VISUAL_REPAIR_PACKET_FAILED` 停止。
3. 从对应来源证据取得明确参数或资源，按固定顺序修改实现；建议优先落在 `allowedImplementationPaths`，但 Validator 不以文件 hash 阻止代码修改。
4. 重新运行同一个 `canonical-ui-repair` operation，以当前代码的真实运行结果判断修复是否有效。
5. 返回 `PASS` 时停止；再次返回 `REPAIR_REQUIRED` 时进入下一轮。
6. 最多三轮；`AIH_VISUAL_REPAIR_EXHAUSTED` 或任何不可修复阻断码必须立即停止。

## 完成条件

- 修改范围与当前差异直接相关，并优先采用 Repair Packet 建议的实现路径。
- 每项代码调整都有设计来源参数、资源或差异证据支持。
- 真实 DOM、文字和交互保持可执行。
- 相同环境下重新截图，并由同一来源一致性门禁返回 `PASS`。
