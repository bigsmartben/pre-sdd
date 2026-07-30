---
name: figma-workflow
description: 将 Ready Visual Spec Checklist（视觉规格清单）绑定为 Figma Coverage（覆盖）与独立设计证据。
---

# Figma Workflow

## 单向职责

输入是 Ready 的 `.psp/visual-spec/checklist.json` 和明确的 Figma file/scope/revision；输出是：

- `.psp/visual-spec/figma-coverage.json`
- `.psp/visual-spec/figma-evidence.json`
- 正式 Asset 文件（由 Evidence 以内容摘要和 usage refs 引用）

例如 Checklist 项 `VSI-FDBI-004-STATE-01` 可以绑定 Figma 节点 `12:34` 的 loading Variant；如果属性无法读取，输出结构化 `missing` Gap，不能根据图层名称猜测，也不能把问题伪装成 Lit 缺陷。

## 证据闭包

- Source 明确记录 `figma://` locator、file/page/node scope、revision、digest 与 capturedAt。
- Coverage 逐项记录 node、state、variant、viewport 与属性证据；node scope 外锚点会被拒绝。
- Evidence 记录 source revision/digest、Asset、Token 和 Motion 内容寻址闭包。
- Figma 多出的内容不得创建 Checklist 项。
- Checklist 或 Figma source 改变后，关联证据为 `stale`。

## 硬边界

本 Skill 不修改 Checklist，不创建业务目标，不读取 Lit consumer，不写 UIHTML，不包含人工签署门。旧 Packet、writeback 或视觉映射输入统一返回 `LEGACY_VISUAL_WORKFLOW_FORBIDDEN`。
