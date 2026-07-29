# 来源汇合规则

- 已批准产品规格决定目标、权限、业务行为和验收结果。
- 原子 Use Case 的正式 Interaction Flow 决定行为状态和分支流转；Low-Fi UI Blueprint 只给出 Screen、Control 与布局建议。
- 在 `guided` 与 `exact` 覆盖范围内，Figma、截图和导出决定实际页面骨架、视觉层级、资源、字体、尺寸、间距及已设计状态；Use Case 与 Low-Fi UI Blueprint 不拥有这些视觉事实。
- 现有界面实现只能作为证据，不能反向改写上游事实。

来源冲突时保留证据并写入 `gaps`，不静默裁决。`blocked` 来源必须由 `gaps[].sourceIds` 关联；`guided` 可把预期的局部来源登记为 `partial` 并只约束明确覆盖，`exact` 不接受 `partial`。不可访问的来源不得凭链接、图层名或相邻页面猜测，可继续完成不依赖该来源的范围。

本地资源必须通过 `$figma-workflow` 随附的 Ingest 脚本写入项目绑定 Area 的 `public/`，并由 `assets[].path` 引用。Figma 资源还必须形成“Capture Plan 候选节点 → Ingest Receipt → `evidence.json` 证据项 → 正式 Asset → `consumerTargets` 实际代码消费”的双向闭包；任一已分类 asset 只用 DOM/CSS 近似而未加载正式文件时以 `AIH_ASSET_CSS_BYPASS` 阻断。浏览器截图属于临时运行证据，不是设计来源或正式产物。
