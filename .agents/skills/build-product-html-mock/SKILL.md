---
name: build-product-html-mock
description: 将本仓库的产品规格、PRD 与 Figma 链接、截图或导出资源汇合为正式 HTML Mock Specification 和可运行 HTML Mock。用于补全 Product Design 上游模型、固化可校验设计来源与本地资源映射、生成 Markdown 规格、实现多页面/多状态/响应式交互原型，并通过上游输入门、浏览器场景和截图证据完成 Repository Harness 验证；不用于凭 Figma 推导业务事实或绕过产品设计链直接写代码。
---

# Build Product HTML Mock

## 定位

把本技能作为仓库流程编排器，不作为 HTML 的数据源。权威输入位于 `psp.project.yaml` 绑定的 Product Design 内部模型；正式输出是由模型生成的 Markdown，HTML 代码仅是可执行证据。Schema、Contract、Validator 和固定脚手架由 Harness 拥有，不复制到技能目录。

## 资源路由

- 开始整理输入前读取 [references/input-mapping.md](references/input-mapping.md)，按事实所有权写入正确模型。
- Figma、PRD、Wireflow 或现有实现冲突、缺失或不可访问时读取 [references/source-reconciliation.md](references/source-reconciliation.md)。
- 完成代表性页面后、扩展页面与最终验收前读取 [references/visual-validation.md](references/visual-validation.md)。

## 工作流

1. 读取适用的 `AGENTS.md`、`.psp/harness/HARNESS.md`、`psp.project.yaml` 和 Harness manifest；调用 `$apply-repository-harness` 解析预计变更路径。Stage 为 `uninitialized` 或 `unavailable` 时遵守生命周期边界，不自行创建用户实例。
2. 读取项目绑定的 `product-package`、`capabilities`、`interactions`、`ui-spec`、`component-catalog` 与 `traceability`。产品事实以 PRD、Use Case 和 Wireflow 为准；Figma 只提供视觉表达、资源和已设计状态。
3. 把 Figma 文件、Frame、截图或导出记录到 `ui-spec.designSources`，并为 `available` 来源保存 HTML Mock area 内的本地快照、捕获时间与 SHA-256；把本地化资源及代码使用记录到 `ui-spec.assetBindings`。不可访问、冲突或不完整的输入必须形成 gap，不得猜测。
4. 只修改项目绑定的隐藏 `.psp/models/` 模型，不直接维护生成的 Markdown。模型更新后运行 `npm run render:product` 和 `npm run validate:product`，再运行 `npm run validate:html-mock-input`。输入门返回 BLOCKED 时停止受影响 HTML 编码，只修复对应上游或来源证据。
5. 输入门 PASS 后，从项目绑定的 HTML Mock area 继续实现代码。优先使用已初始化的仓库脚手架、技术栈、路由、Mock API 与组件规范；只有 manifest 声明的初始化 operation 才能从 Harness 模板创建 area。
6. 先实现信息密度高且覆盖核心流程的代表性页面，在目标视口验证真实资源、排版、状态和可点击路径，再抽取稳定组件并扩展所有 Screen、场景、异常状态和响应式布局。
7. 在代码入口保留模型要求的 HTML Mock、Screen 和 Scenario 追溯标识；让预期状态暴露 `data-state-id="WF-STATE-NNN"`，并让每个本地资源使用具有模型声明的 selector。不得用静态截图、大面积绝对定位或虚构后端伪造可操作体验。
8. 完成代码后先运行 typecheck、build 与 `npm run validate:html-mock-runtime`。浏览器门禁必须在全部 required viewports 执行场景并返回截图证据；只在输入门、运行时场景和人工截图/无障碍复核分别具有 PASS 证据后勾选对应模型 gates，并重新 render。
9. 对实际变更路径重新调用 `$apply-repository-harness`，按 resolver 顺序运行全部命令。只有以 product-strict 收尾的 Product Design strict Profile 全部通过，才能声明 HTML Mock ready、可消费或可交付。

## 输出契约

- 内部模型：只写 `psp.project.yaml` 绑定的 `.psp/models/`，不列入用户交付。
- 正式产物：重新生成所有受影响绑定的 Markdown `user-artifact`，不得单独编辑。
- 可执行证据：交付绑定 HTML Mock area 内的源码、本地设计资源、路由、状态和场景实现。
- 机器支撑：只生成项目绑定声明的 `generated-support`；浏览器截图写入命令返回的临时 evidence 目录，不冒充正式产物。
- 验证报告：按 Harness 返回 Scope、Changes、逐项状态、截图计数/路径和 Residuals。

## 交付边界

- 不从实现便利性反推或修改 Product Design 事实。
- 不把 Figma 图层名直接当作 DOM、业务组件或产品行为。
- 不把 Schema、Contract、Validator、通用模板或 YAML/JSON 内部模型列为用户产物。
- 不把结构校验 PASS、视觉抽查或构建成功等同于 strict readiness。
- 最终按 Harness 报告 Scope、Changes、Validation 和 Residuals。
