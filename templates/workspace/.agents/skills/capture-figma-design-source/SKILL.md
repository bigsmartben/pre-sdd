---
name: capture-figma-design-source
description: 将带 node-id 的 Figma 节点采集为 Canonical UI Prototype（规范界面原型）可复现的本地设计来源证据，包括节点上下文、截图、变量、字体、图层参数、Export/ 静态资源、PNG 校验和内容哈希。用户提供 Figma 节点并需要绑定视觉来源、导出标记资源、精准还原或补全来源证据时使用；本技能只采集与封存来源，不决定产品语义、视觉策略或 readiness（就绪）。
---

# 采集 Figma 设计来源

## 边界

本技能是 Figma Source Adapter（Figma 来源适配器），只把用户确认的 Figma 节点转换为 Product Design（产品设计）拥有的 provider-neutral design-source evidence（提供方中立设计来源证据）。开始前必须加载 `$product-design` 与 `$apply-repository-harness`，由 Product Design 提供 `sourceId`、节点链接、覆盖范围和 Manifest 绑定的 Canonical UI Area。

本技能不得选择或改变 `visualPolicy.mode`，不得创建 Screen、Control、State、Use Case 或 Interaction Flow，不得把图层名和视觉外观解释为业务规则，也不得直接判定当前产物 readiness 或执行 handoff（移交）。

需要通过 Figma 文件上下文执行唯一读取或资源导出时，必须先加载 `$figma:figma-use`。Figma 连接器、权限或节点不可用时停止采集，将来源标记为 `blocked`，报告 `AIH_SOURCE_CAPTURE_BLOCKED`；不得根据链接、相邻节点、图层名或截图猜测缺失内容。

## 输入条件

- 只接受 `https://www.figma.com/design/...?...node-id=...` 节点链接。
- 将链接中的 `node-id=123-456` 规范化为证据中的 `123:456`。
- `sourceId`、目标 Screen、State、Viewport（视口）和证据覆盖由 Product Design 提供；本技能不自行扩大设备、页面或状态范围。
- 写入路径只从 `psp.project.yaml` 与 Manifest 解析，不根据示例目录猜测。
- 开始采集前必须确认 `$organize-figma-assets`、`$figma-component-from-design` 或其他 Figma 写入已经完成，并冻结本轮节点范围。采集后发生的任何 Figma 节点、变量、组件或图层修改都会使本轮证据失效，必须从同一节点重新采集。
- 临时下载、转换结果和候选清单只能写入本次采集会话创建并记录的操作系统临时目录。清理时只允许删除该会话拥有的目录；不得删除来源不明、其他会话或 Canonical UI Area 内的文件。

## 采集工作流

1. 冻结来源节点。
   - 记录最终节点链接、规范化 `nodeId`、本轮 `sourceId` 和确认的覆盖范围。
   - 读取连接器可验证的来源版本，按 `figma-file-version`、`remote-last-modified` 或 `node-fingerprint` 之一登记 `sourceVersion`。无法取得任何可重复比较的版本值时停止并报告 `AIH_SOURCE_CAPTURE_BLOCKED`。
   - 不在采集过程中整理图层、创建组件、修改变量或执行其他 Figma 写回。
   - 若发现仍需写回，停止采集并先路由到对应 Figma 写入技能；写回完成后重新开始本工作流。

2. 读取节点设计上下文。
   - 保存原始节点上下文，不先转写为主观 CSS 结论。
   - 明确记录 Frame 尺寸、图层位置、宽高、约束、自动布局、间距和对齐。
   - 明确记录字体族、字号、字重、行高、字距、文本换行和文本样式引用。
   - 明确记录填充、透明度、描边、圆角、阴影、模糊、渐变、混合模式和效果引用。
   - 明确记录组件、Instance（实例）、Variant（变体）、状态、变量绑定和资源引用。
   - 每个组件相关节点必须显式记录 `name`、`componentKey`、`componentSetNodeId`、`mainComponentNodeId`、`structureSignature` 与 `variantProperties`；连接器明确返回不存在时写 `null`，不得省略字段或用自由文本 `componentId` 代替关系。
   - `structureSignature` 是规范化结构记录的 SHA-256：按子节点顺序保留节点类型、内容角色、容器关系、Slot 边界与嵌套组件边界；排除文字值、颜色、尺寸、坐标和 Variant 当前值。相同规范化结构必须得到相同签名，结构不同必须得到不同签名。
   - `instance` 必须解析到 `mainComponentNodeId`；无法解析时保留来源缺口并报告 `AIH_SOURCE_CAPTURE_BLOCKED`，不得把未绑定实例交给组件映射门禁。

3. 获取同一节点截图。
   - 使用用户确认的节点、Viewport 和设备像素比。
   - 截图作为来源一致性机器比较和人工复核基线，不得登记为页面实现资源。

4. 读取变量和字体。
   - 保存节点可用的设计变量定义；连接器明确返回无变量时保存空结果。
   - 只有节点实际使用的变量才能交给 Product Design 映射为 `tokens`，不得凭截图发明变量名。
   - 字体不可访问时记录缺口，不得静默替换后仍声明来源一致。
   - 已存在的 Code Connect（代码连接）映射可以保存为 `code-connect-map` 证据；本技能不得创建 `.figma.ts` 文件，也不得要求组件已经发布。

5. 导出并验证来源资源。
   - 收集用户指定或 `$organize-figma-assets` 标记的全部 `Export/kebab-case-name` 目标。
   - 为每个目标记录来源节点、预期格式、资源用途和目标 Screen 或 Component。
   - 优先复用 Figma 已有 SVG、PNG、组件 Artwork（视觉作品）和复杂效果资源。
   - SVG 用于需要无损缩放的矢量；需要透明度的位图使用 PNG。
   - 动态文字、用户数据、真实控件和交互结构不得栅格化。
   - 复杂视觉资源应保留透明边距、裁切范围、导出比例和来源节点引用。
   - 页面或组件的完整截图不得伪装成 `asset` 资源。
   - 文件使用稳定的 kebab-case 名称，写入 Canonical UI Area 的 `public/assets/<source-id>/`；不得写入 `dist/`、`.vite/` 或 Area 之外的永久证据目录。
   - 对要求透明背景的 PNG 运行：

     ```text
     node .agents/skills/capture-figma-design-source/scripts/validate-png-assets.mjs <png>...
     ```

   - PNG 缺少可见内容或真实透明像素时以 `FAIL` 停止；可见内容接触边缘时必须人工确认是否发生裁切。
   - 每个 `asset` 证据项必须登记 `sourceNodeId`、`assetKind`、`captureScope` 和 `containsDynamicContent: false`；`captureScope` 只允许单个 `layer` 或不包含动态内容的 `artwork-subtree`。

6. 封存正式来源证据。
   - 原始上下文、截图和变量写入 `design-sources/<source-id>/`。
   - 可执行界面需要的导出资源写入 `public/assets/<source-id>/`。
   - 生成 `evidence.json`，记录规范化 `nodeId`、`sourceVersion`，并为每个文件记录 Area 相对 POSIX 路径、角色和 `sha256` 内容哈希。
   - 每个导出资源必须以 `role: asset` 出现在同一来源的 `evidence.json` 中；只存在于 `public/assets/` 或 `canonical-ui.ts.assets` 不构成来源证据。
- `design-context` 必须符合本技能拥有的 `figma-design-context.schema.json`，并在证据项的 `schema` 字段登记其 `$id`。
- Schema 要求明确登记 geometry、typography、paint、effects、components 和 assets 六类参数检查结果；只保存一张截图不构成完整 Figma 证据。
- `components` 中的 Component Set、Main Component 与 Instance 关系必须闭合；同一 `nodeId` 不得重复，Instance 引用的 Main Component 必须存在于本次 `design-context`。
   - 所有文件落盘后重新计算每个证据项哈希，再计算最终 `evidence.json` 哈希；未完成最终清单哈希前，证据状态不得标记为 `available`。
   - 完成哈希后再次读取或计算同一种 `sourceVersion`；若与步骤 1 不一致，丢弃本次会话拥有的候选结果并从冻结节点步骤重新采集，不得登记混合版本证据。

7. 生成登记包并交回 Product Design。
   - 使用 Canonical UI Artifact Contract（产物契约）登记的 `design-source-evidence.schema.json` 校验证据清单。
   - 在本次会话拥有的操作系统临时目录中生成符合 `source-registration.schema.json` 的 Registration Packet（登记包），只包含 `sourceId`、`sourceVersion`、证据清单路径与哈希、可用资源候选、确认的使用目标和显式缺口。
   - 返回登记包路径、来源状态、变量和字体；由 Product Design 校验登记包后，将来源、最终 `designSources[].evidence.sha256`、资源和使用目标写入 `canonical-ui.ts`。
   - 本技能不得直接编辑 `canonical-ui.ts`，不得创建 Canonical UI Asset ID，也不得决定视觉覆盖或来源一致性断言。
   - Product Design 登记的 `canonical-ui.ts.assets[*].sourceIds` 只能引用证据清单中包含同一路径的来源；禁止先登记资源事实、后补来源证据。
   - 执行 Resolver 返回的全部验证命令；资源文件、证据项、清单哈希或使用目标不一致时保留 `AIH_SOURCE_INTEGRITY_FAILED` 或原始 blocker code（阻断码）。

## 完成条件

- 节点链接与证据 `nodeId` 一致。
- 同时存在通过哈希校验的 `design-context` 与 `screenshot` 证据项。
- 设计上下文包含可用于实现的明确尺寸、排版、形状、效果和资源参数。
- 截图基线没有作为页面或组件资源使用。
- 动态内容和交互结构没有被错误栅格化。
- 所有导出资源均存在对应 `role: asset` 证据项，文件哈希和最终清单哈希匹配。
- 透明 PNG 包含可见内容和真实透明像素，边缘裁切风险已经确认。
- `sourceVersion` 在 `design-context`、`evidence.json` 和 Registration Packet 中完全一致。
- Registration Packet 已通过 Schema 校验，资源候选均引用同一证据清单中的 `role: asset` 项。
- 最终证据采集时间晚于本轮全部 Figma 写入；后续发生 Figma 写入时不继续复用旧证据。
- 来源不可访问或参数缺失时保留明确 gap 和原始 blocker code（阻断码）。
- 没有新增 Python 或其他运行依赖。
