# Figma 扫描、审计与写回

## 1. 输入契约

只接受以下事实：

- Figma 文件或选区链接，以及可读取的根节点。
- `sourceId` 与 `scopeMode: file | selection`。
- Product Design 提供的 Screen Binding、预期 Page、State、Variant、Viewport 和 Scenario。
- 可重复比较的 `sourceVersion`。

`file` 模式必须盘点文件中的全部 Page；`selection` 模式只证明选区完整，不得声称整个文件没有遗漏。

Workflow Request 是不落盘的输入检查表。权限、根节点、`sourceVersion`、Inventory 和审计输入应在一次前置遍历中取得；逻辑 Step 1 和 Step 2 不要求拆成独立远程调用。

## 2. 扫描审计

`scopeAudit` 必须盘点 Page、Section、Frame、Group、Component Set、Component、Instance、Image 和视觉节点，并完成以下检查：

| 检查 | PASS 条件 | 示例 |
|---|---|---|
| Page Coverage | 每个预期 Page 解析到唯一 Figma Page；`file` 模式还覆盖文件全部 Page | 预期“登录页”没有对应 Page → FAIL |
| Group Integrity | Group 成员、父子关系和 Asset Boundary 唯一；含视觉内容的 Group 不拆分 | 头像、边框、角标同组 → 整组导出 |
| Image Group Coverage | 每个图片节点位于其预期组件或 Group 下 | 卡片插图跑到 Page 根节点 → FAIL |
| State Coverage | 每个上游 State 解析到一个或多个明确节点 | `STATE-ERROR` 没有对应 Frame → FAIL |
| Variant Coverage | 每个预期轴和值均存在 Definition；允许稀疏组合 | `State=Disabled` 未创建 → FAIL |

所有检查结果只允许 `PASS`、`FAIL` 或 `EXCLUDED`。`EXCLUDED` 必须有用户提供的范围理由；未解决的 `FAIL` 触发 `AIH_FIGMA_AUDIT_INCOMPLETE`。

## 3. 写回计划与第一道人工门禁

`writebackPlan` 只允许：

- `rename`
- `group`
- `reorder`
- `replace-component`
- `create-component`
- `create-component-set`
- `create-variant`
- `create-variable`
- `detach-instance`

每项操作必须有唯一 ID、目标 Node ID 和原因。默认禁止 Detach Instance；只有 `writebackApproval.detachApprovals` 逐个登记的实例可以 Detach。

`writebackApproval` 的 SHA-256 覆盖完整 `scopeAudit` 哈希、`sourceVersion`、全部操作 ID、批准人和批准时间。审计或计划变化后旧批准立即失效。

## 4. 执行与第二道人工门禁

1. 校验当前 `sourceVersion` 与 Step 2 一致，并复用 Step 2 已保存的内容寻址截图和节点清单；不得重复采集。
2. 在一次 `use_figma` 批次中只执行获批操作，操作 ID 必须精确相等。
3. 以一次后置遍历保存写回后截图和节点清单，重新执行五类审计。
4. 生成带内容哈希的 `writebackReceipt`。
5. 用户基于写回后 Figma 完成人工验收，生成 `finalFigmaAcceptance`。

前置版本变化时旧证据和批准失效，返回扫描审计。任何计划外变化触发 `AIH_FIGMA_WRITEBACK_UNAPPROVED`。人工拒绝时不得冻结；返回扫描审计，生成新的审计、批准和写回批次。

## 5. Figma-only 组件事实

组件提案只记录：

- 组件边界与最终 Figma Node。
- Figma Component Property。
- Variant Axis 与有限值。
- Content Region（内容区域）。
- 嵌套组件。
- 固定、Hug、Fill 和内容驱动的尺寸行为。
- Definition 与使用中 Instance。

禁止记录或推导 Lit Property、Attribute、Slot、Event、CSS Custom Property、路由或业务状态。Figma → Lit Mapping 由 Product Design 在登记后独立建立。
