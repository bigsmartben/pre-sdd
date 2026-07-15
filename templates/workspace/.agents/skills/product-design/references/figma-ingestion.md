# Figma 节点采集

## 输入条件

- 只接受 `https://www.figma.com/design/...?...node-id=...` 节点链接。没有 `node-id` 时请求节点级链接，不猜测页面或 Frame。
- 将链接中的 `node-id=123-456` 规范化为证据中的 `123:456`。
- 先确认 Figma 读取连接器提供设计上下文、节点截图和设计变量能力。连接器、权限或节点不可用时，将来源标记为 `blocked`，建立带 `sourceIds` 的 gap，并报告 `AIH_SOURCE_CAPTURE_BLOCKED`。

## 采集顺序

1. 读取节点设计上下文，保留布局、文本、组件、变体、视觉属性和资源引用。
2. 获取同一节点截图，作为人工视觉复核基线。
3. 读取节点可用的设计变量定义；如果连接器明确返回无变量，将空结果记录在设计上下文中。只有实际使用的变量才映射为 `tokens`，不得凭截图猜测变量名。
4. 已有 Code Connect 映射可保存为 `code-connect-map` 证据；不得在本工作流创建 `.figma.ts` 或要求组件已经发布。
5. 将原始响应保存到 `design-sources/<source-id>/`，将可执行界面使用的资源保存到 `public/assets/<source-id>/`。
6. 生成 `evidence.json`，在清单级记录规范化 `nodeId`，并为每个证据文件记录 Area 相对 POSIX 路径、角色和 `sha256` 内容哈希。
7. 先让证据清单通过 `design-source-evidence.schema.json`，再写入 `canonical-ui.ts` 的 `designSources`、`assets`、`tokens` 和 `visualAssertions`。

## 事实边界

Figma 只拥有已绘制的视觉层级、排版、尺寸、间距、资源、变量和状态呈现。Use Case、权限、业务规则、Screen、Control 与流程状态继续由已就绪的上游产物拥有。

例如：Figma 节点出现“删除”按钮，只能采集按钮的文字、位置和视觉状态；是否允许删除以及失败后的业务结果必须来自 Use Case 与 Wireflow。
