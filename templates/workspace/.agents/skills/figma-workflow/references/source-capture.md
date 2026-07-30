# Figma 冻结、采集与登记

## 1. 输入门禁

开始正式采集前必须同时满足：

- `scopeAudit` 无未解决 `FAIL`。
- `writebackApproval`、`writebackReceipt` 和 `finalFigmaAcceptance` 的内容哈希有效。
- 写回操作集合与批准集合精确相等。
- 最终验收绑定写回后的 `sourceVersion`。
- 当前读取的 `sourceVersion` 与最终验收一致。

缺少最终人工验收时返回 `AIH_FIGMA_FINAL_ACCEPTANCE_REQUIRED`。版本或内容漂移时废弃本轮证据，返回扫描审计。

## 2. Visual Strategy（视觉策略）

每个确认范围内的视觉节点必须且只能选择一种策略：

| Strategy | 用途 | 门禁 |
|---|---|---|
| `asset` | Figma 提供的图标、图片、插画、背景、边框、阴影、渐变、视觉效果或整体 Artwork | 必须声明导出参数、Asset Boundary 和消费目标 |
| `layout` | 仅包含几何布局或文字排版，没有可见 Paint、Stroke、Effect、Mask 或 Raster | 出现视觉属性时触发 `AIH_FIGMA_VISUAL_POLICY_VIOLATION` |
| `dynamic` | 运行时文本、用户数据或真实控件内容 | 其视觉外壳仍必须由独立 `asset` 节点覆盖 |
| `ignored` | 不可见、明确排除或已被父 Group Asset Boundary 覆盖 | 必须记录原因；被父 Group 覆盖时必须引用该边界 |

含视觉内容的 Group 是唯一 Asset Boundary。整组导出后，子视觉节点只能登记为 `ignored` 并引用父边界；不得把子节点分别导出后在 HTML 中拼接。

## 3. 实现边界

本技能只以 `visualNodeCatalog` 判定节点能否标记为 `layout`：节点不得含可见 Paint、Stroke、Effect、Mask 或 Raster。产品级视觉还原由 `$implement-lit-ui` 及其 Validator 所有，本技能不重复定义。

## 4. 正式采集

1. 冻结最终节点并记录 `frozenAt`。
2. 加载 `$figma:figma-design-to-code`，调用 `get_design_context`。
3. 保存原始响应及其字节 SHA-256。
4. 生成规范化 Design Context，包含 geometry、typography、paint、effects、components、assets 和逐节点 `visualNodeCatalog`。
5. `visualNodeCatalog` 为每个视觉节点记录父节点、可见性、Paint、Stroke、Effect、Mask、Raster、Text 与 Asset Boundary。
6. 仅下载 `strategy: asset` 的节点；按兼容格式与比例批量导出，写入本次会话的操作系统临时目录。
7. 调用本 Skill 随附的 `ingest-assets.mjs` 生成正式 Asset 和 Ingest Receipt。

正式 Capture、下载、Ingest 和 Evidence 必须位于同一时间边界，并绑定同一 `sourceVersion`。

## 5. Asset 规则

- SVG 用于无损缩放的矢量；透明位图使用 PNG。
- 动态文本、用户数据、真实控件和整页截图不得作为交互 Asset。
- Asset 必须闭合 `sourceNodeId`、`assetBoundaryNodeId`、格式、比例、裁切、透明边距、预期尺寸、目标路径、哈希和消费目标。
- PNG 必须运行 `figma-workflow/scripts/validate-png-assets.mjs`；无可见内容或缺少要求的透明像素时停止。

## 6. Registration Packet

Registration Packet 只保存 Figma 来源事实：

- Capture Plan、Design Context、Ingest Receipt 和 Evidence 的路径与哈希。
- Figma Component Contract、最终组件节点和结构签名。
- 全部 Variant Definition。
- 使用中的 Instance 与 Screen Binding；零使用必须显式为 `[]`。
- Asset 与 Asset Boundary 闭包。
- 明确 gap。

交回 Product Design 前，以 Registration 模式运行 `ingest-assets.mjs` 做只读闭包校验。不得在本技能中创建业务 conceptId、Lit 接口或 Figma → Lit 实现映射；Figma 与 UC 的解释只进入后续 `Mapping.html` 澄清。
