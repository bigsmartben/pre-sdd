---
name: figma-workflow
description: 将用户指定的 Figma 文件或选区按契约完成来源接收、完整扫描审计、一次获批写回、写回后人工验收、最终冻结、设计上下文采集、静态资源导入和来源登记。用户要求检查或整理 Figma 页面、Group、图片归组、组件、状态、Variant，或为 Canonical UI 精确实现准备可验证 Figma 来源时使用；本技能只返回 Figma 来源事实与登记包，不创建产品状态、Lit 接口或 HTML/CSS 实现。
---

# Figma 工作流

## 职责边界

本技能只拥有 Figma 来源处理：

- 扫描并审计用户指定的文件或选区。
- 执行一次人工批准的有限写回。
- 在写回后取得最终人工验收。
- 冻结、采集、导入 Asset（静态资源）并形成 Registration Packet（登记包）。

Product Design 提供 `sourceId`、业务 Screen、预期 Page、State、Variant、Viewport 和 Scenario；本技能只验证这些事实在 Figma 中的覆盖，不从名称或外观推断业务语义，也不得选择或改变视觉策略。Product Design 独立建立 Figma → Lit Mapping；`$implement-canonical-ui` 独立拥有 Lit 组件与页面正常实现。本技能不得输出 Lit Property、Attribute、Slot、Event，不得写 HTML、CSS、路由或 `canonical-ui.ts`。

## 关键原则

1. **Source-first（来源优先）**：所有视觉内容必须使用正式 Figma Asset；禁止用 CSS、伪元素、内联 SVG、Canvas 或多层 DOM 重绘。
2. **CSS 只做布局与文字排版**：允许尺寸、位置、Flex/Grid、间距、层级、溢出、字体、字号、字重、行高、字距、对齐和文字颜色；禁止背景、非透明边框、阴影、渐变、滤镜、遮罩和 CSS 图形。`background:none`、`border:0` 等中性重置不算绘制。
3. **Group 是 Asset Boundary（资产边界）**：含视觉内容的 Group 必须整体导出；禁止导出其子节点后在 HTML 中重新拼接。
4. **不推断业务事实**：预期 Page、State 和 Variant 必须来自 Product Design 输入；缺失时报告 gap。
5. **两道人工门禁**：写回前批准完整审计与操作清单；写回后验收最终 Figma。第二道门禁未通过时不得冻结或采集。
6. **冻结后只读**：冻结后的节点、Group、Variable、Component 或 Variant 发生变化时，废弃本次采集并返回扫描审计。

## 工具路由

- 本任务首次调用 `use_figma` 前加载一次 `$figma:figma-use`，后续调用复用已加载上下文；普通元数据或截图读取不要求加载该 Skill。
- 本任务首次创建或修改 Component、Component Set、Variant 或 Variable 前加载一次 `$figma:figma-generate-library`。
- 本任务首次正式采集前加载一次 `$figma:figma-design-to-code`，并以 `get_design_context` 取得 Design Context；截图或元数据不能替代它。
- 扫描、审计和写回时读取 `references/figma-writeback.md`。
- 冻结、分类、采集、导入和登记时读取 `references/source-capture.md`。

## 契约索引

| 产物 | 结构契约 |
|---|---|
| Capture Plan | `capture-plan.schema.json` |
| Design Context | `figma-design-context.schema.json` |
| Acquisition Packet | `acquisition-packet.schema.json` |
| Ingest Receipt | `ingest-receipt.schema.json` |
| Evidence | `../product-design/canonical-ui-prototype/design-source-evidence.schema.json` |
| Registration Packet | `source-registration.schema.json` |

结构由上述 Schema 定义；跨文件闭包由 `scripts/ingest-assets.mjs` 定义。Workflow Request 是 Step 1 到 Step 2 之间不落盘的输入检查表，不创建额外 Schema 或文件。

## 固定工作流

| Step | 输入 | 动作 | 输出 | 门禁与返回 |
|---|---|---|---|---|
| 1. Intake（接收） | Figma 链接、`sourceId`、`scopeMode`、预期 Page/State/Variant、Screen Binding | 校验权限、根节点和可比较 `sourceVersion` | 标准化 Workflow Request | 输入缺失或来源不可读：`AIH_SOURCE_CAPTURE_BLOCKED`，停止 |
| 2. Scan & Audit（扫描审计） | Workflow Request | 一次遍历盘点 Page、Frame、Group、Component Set、Component、Instance、Image 和视觉节点；检查页面、归组、图片、状态和 Variant；形成唯一写回计划 | `scopeAudit`、内容寻址的前置截图与节点清单、`writebackPlan` | 未解决项：`AIH_FIGMA_AUDIT_INCOMPLETE`；用户确认后形成 `writebackApproval` |
| 3. Writeback & Acceptance（写回验收） | 带内容哈希的 `writebackApproval` 与 Step 2 前置证据 | 复用前置证据；一次批量执行获批操作；一次重新扫描并保存后置证据 | `writebackReceipt`、后置截图、最终节点清单 | 前置版本变化时返回 Step 2；操作越界：`AIH_FIGMA_WRITEBACK_UNAPPROVED`；用户验收后形成 `finalFigmaAcceptance`，拒绝则返回 Step 2 |
| 4. Freeze, Capture & Ingest（冻结采集） | `finalFigmaAcceptance` 与最终 `sourceVersion` | 冻结；正式采集；按 `asset/layout/dynamic/ignored` 分类；导出并受控导入 Asset | Capture Plan、Design Context、Acquisition Packet、Ingest Receipt、Evidence | 缺少验收：`AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED`；视觉节点误标 `layout`：`AIH_FIGMA_VISUAL_POLICY_VIOLATION` |
| 5. Register（登记） | 同版本的 Capture、Context、Receipt 和 Evidence | 校验 Asset Boundary、组件、Variant Definition、Instance Usage 与 Screen Binding 双向闭包 | Figma-only Registration Packet | Schema、哈希、版本或覆盖不闭合时停止；通过后只交回 Product Design |

## 失效与重试

- Step 2 的未解决审计项不得被人工确认掩盖。
- Step 3 每次只执行一个获批批次；人工拒绝最终结果时，以新的 `sourceVersion` 返回 Step 2。
- Step 4 开始后禁止任何 Figma 写回。发现仍需编辑时废弃 Capture Plan、证据和候选 Registration Packet。
- 连接器、权限、节点或可比较版本不可用时，保留原始 blocker code，不猜测、补写或伪造证据。

Step 5 的 Figma-only Registration Packet 及其引用产物是本技能的最终输出。正式就绪、Review、Repair、Publish 和 Handoff 不属于本技能。
