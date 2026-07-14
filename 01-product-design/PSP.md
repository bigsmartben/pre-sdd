<!-- OFFICIAL USER ARTIFACT. GENERATED FROM INTERNAL MODEL; DO NOT EDIT DIRECTLY. Internal model: .psp/models/product-package.yaml -->
---
generated: true
artifactRole: user-artifact
internalModel: .psp/models/product-package.yaml
status: draft
version: 0.1.0
---

# Product Specification Package

本文件是产品设计 Package 的正式用户产物；内部 YAML/JSON 模型只服务于生成和机器校验，不属于用户交付物。

## Product Overview

- 产品名称：未提供（见显式 gaps）
- 产品目标：未提供（见显式 gaps）
- 目标用户：未提供（见显式 gaps）
- 核心价值：未提供（见显式 gaps）
- 当前版本：0.1.0

## Primary Delivery Chain

- [UC Specification](./UC.md)
- [Wireflow Mid-Fidelity Specification](./wireflow-mid.md)
- [HTML Mock Specification](./HTML-Mock/README.md)

## Supporting Artifacts

- [HTML Mock Component Catalog（支撑）](./HTML-Mock/components/README.md)
- UC → Wireflow → HTML Mock Traceability（支撑）（机器生成支撑，不作为用户产物）

## Reading Protocol

1. 从本文件确认 Package 状态、三段主链和支撑产物。
2. 主链按 UC → Wireflow Mid → HTML Mock 顺序消费，后一步不得反向改写前一步事实。
3. Component Catalog 与 Traceability 只支撑 HTML Mock 实现和机器校验，不拥有新场景。
4. 遇到 gap 或冲突时停止下游推导，并反馈对应上游用户产物。

## Abstraction Boundary

- UC Specification 定义产品行为事实，不定义 Screen 或实现。
- Wireflow Mid 定义 Screen、内容层级、Control、状态和分支流转，不定义代码组件。
- HTML Mock Specification 将 Wireflow 转成可运行、可操作、可审阅的体验证据。
- 本 Package 不拥有软件架构和生产实现事实。

## Gates

- [ ] Product Overview 已由产品责任人确认 (overview-confirmed)
- [ ] UC → Wireflow Mid → HTML Mock 主链及支撑产物边界已审阅 (abstraction-reviewed)
- [ ] Package 中的产品事实已批准交付 (product-facts-approved)

## Explicit Gaps

- GAP-001 · overview：记录缺失事实及其澄清原因，不得用实现假设填充
