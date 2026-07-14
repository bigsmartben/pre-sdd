# 视觉与交互验证

## 代表性基线

先选择同时覆盖核心布局、典型资源、主要操作和关键状态的页面。使用真实 DOM、CSS、仓库内资源和可控 Mock 数据实现，并在模型声明的视口实际渲染。

基线至少检查：

- 页面结构、信息密度和主要区域比例；
- 字体、颜色、间距、圆角、阴影和图标资源；
- 默认、加载、空、成功、失败、禁用和权限相关状态中适用的部分；
- 入口、返回、继续、异常恢复和结束路径；
- 键盘顺序、可见焦点、语义结构、文本反馈和对比度；
- 移动端与桌面端的重排、折行、溢出和触控目标。

## 扩展规则

- 只有业务意图、实体、操作语义、权限和状态集合兼容时才抽取业务组件。
- 视觉相似但业务语义不同的区域只复用低层 Primitive 或 Shell。
- 不用固定坐标复刻整页；绝对定位仅用于本来就需要叠放的局部元素。
- 不用整页截图充当交互页面；截图只能作为视觉参考或明确的内容资源。
- 使用稳定本地 Fixture 演示场景，不连接生产服务，除非用户明确要求。
- 使用 Schema 支持的 `click`、`fill`、`select`、`press`、`check` 或 `uncheck` 操作；每个预期状态在 DOM 暴露对应 `data-state-id`。
- 每个本地化资源按 `assetBindings.usages` 提供代码 reference 和浏览器 selector。

## 最终检查

1. 运行生成检查，确认 Markdown 与内部模型无 drift。
2. 运行 typecheck、build 及 resolver 返回的全部测试和结构校验。
3. 首次使用或收到 `AIH_BROWSER_UNAVAILABLE` 时运行 `npm run install:browser`；构建后运行 `npm run validate:html-mock-runtime`，按 `interactionScenarios` 实际操作每个主路径和分支，观察 Screen、State 与反馈。
4. 在所有 required viewports 检查横向溢出并生成页面与场景结束截图；截图是人工视觉复核证据，不等同于自动证明 Figma 像素一致。
5. 核对 `assetBindings` 的本地文件、`designSources` 的覆盖范围和代码中的追溯标识。
6. 运行 Product strict Profile；任何 FAIL、BLOCKED 或 NOT_RUN 都必须保留为 residual，不能表述为 ready。
