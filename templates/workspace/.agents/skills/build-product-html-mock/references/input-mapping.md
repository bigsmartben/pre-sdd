# 输入与模型映射

## 事实所有权

| 输入事实 | 权威模型 | 说明 |
|---|---|---|
| 产品目标、范围、目标用户 | `product-package` / `capabilities` | PRD 或已确认产品规格拥有，不从 Figma 反推 |
| Actor、Use Case、业务规则、验收条件 | `capabilities` | 定义业务行为，不定义页面布局 |
| Screen、Control、状态、分支和跳转 | `interactions` | Wireflow Mid 拥有交互事实 |
| HTML 入口、路由、DOM 映射、可操作场景 | `ui-spec` | 把 Wireflow 转成可执行证据 |
| 视觉来源、视觉规则、视口、资源本地化 | `ui-spec` | Figma、截图或导出只拥有视觉事实 |
| 可复用 HTML Mock 组件 | `component-catalog` | 以业务语义和状态兼容性划分 |
| UC → Wireflow → HTML Mock | `traceability` | 只记录正式跨产物追溯 |

具体内部模型和输出路径必须从 `psp.project.yaml` 读取，不能从目录名猜测。

## UI Spec 来源字段

### `designSources[]`

- `id`：`DESIGN-SOURCE-NNN`。
- `type`：`figma`、`image` 或 `export`。
- `location`：可访问的 Figma URL、仓库相对图片路径或导出资源路径。
- `nodeId`：Figma Frame/Node ID；非节点来源填 `null`。
- `scope`：该来源覆盖的页面、区域或视觉问题。
- `status`：`available`、`partial` 或 `blocked`。
- `evidence.path`：Product Design stage root 下、且位于绑定 HTML Mock area 的本地快照或导出路径。
- `evidence.sha256`：证据文件内容的 SHA-256。
- `evidence.capturedAt`：UTC 捕获时间，格式为 `YYYY-MM-DDTHH:mm:ssZ`。

`available` 必须具有可读取且哈希匹配的 evidence；`partial` 或 `blocked` 可填 `null` 并记录 gap。每个 `htmlMocks[].designSources` 必须引用实际覆盖它的来源。每个 `visualRules[].sourceRefs` 必须引用支持该规则的来源，不能只写无法追溯的视觉判断。

### `assetBindings[]`

- `id`：`ASSET-BINDING-NNN`。
- `kind`：`image`、`icon`、`logo`、`illustration`、`font` 或 `other`。
- `source`：对应的 `DESIGN-SOURCE-NNN`。
- `sourceNode`：Figma Asset/Node ID；没有节点时填 `null`。
- `localPath`：Product Design stage root 下的仓库相对路径；未本地化时填 `null`。
- `htmlMocks`：使用该资源的 HTML Mock ID。
- `usages`：逐个记录 `htmlMock`、可选 `scenario`（初始可见时为 `null`）、对应代码 `entry`、代码中出现的资源 `reference` 和浏览器可定位的 `selector`。
- `status`：`localized`、`blocked` 或 `out-of-scope`。

有识别性的 Logo、图片、插画、图标和字体优先使用源资源并本地化。`localized` 必须位于绑定 HTML Mock area、指向真实文件，并为每个绑定 HTML Mock 提供代码引用；网络相似素材、自制替代品和 Emoji 不能冒充设计资源。

## 更新顺序

1. 先补齐 Product Package、Use Case 与业务规则。
2. 再补齐 Wireflow 的 Screen、Control、状态和场景。
3. 再写 UI Spec 的来源、路由、场景、视觉与资源绑定。
4. 同步 Component Catalog 和 Traceability。
5. 运行 Product render、结构校验和 `validate:html-mock-input`；输入门 PASS 后才能修改 HTML Mock 代码。
