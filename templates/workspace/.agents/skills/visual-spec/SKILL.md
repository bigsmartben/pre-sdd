---
name: visual-spec
description: 编译并验证框架无关的 Visual Spec Schema（视觉规格模式）与机器 Checklist（清单）。
---

# Visual Spec

## 权威与输入

本 Skill 拥有 `psp.dev/visual-spec/v1` 的表达契约和 Checklist Compiler（清单编译器）。它只读取：

1. `PRODUCT-USE-CASES`
2. `FUNCTIONAL-DELIVERY-BASELINE`
3. 仅在存在 `USER_PATH` 时读取 `TEST-CASE-CATALOG`

示例：Baseline 的 `FDBI-004` 要求结算页达到 `USER_PATH`，并引用 `TC-007`；编译器会生成稳定的 `VSI-FDBI-004-PAGE-01`，不会查询 Figma 或决定 Lit 组件。

## 产物

- Schema：`schemas/visual-spec.schema.json`
- Checklist Schema：`schemas/visual-spec-checklist.schema.json`
- Checklist：工作区 `.psp/visual-spec/checklist.json`
- Ready Authorization（就绪授权）：Validator 在所有结构、引用、闭包和新鲜度通过时输出

## 规则

- 所有摘要从源文件落盘后的精确 UTF-8 字节计算。
- 相同输入得到相同 Checklist 字节和稳定 ID。
- `USER_PATH` 必须同时包含 L1 `VISUAL`，且必须引用有效 Test Case。
- Provider（提供方）或实现字段，例如 Figma node、Lit component、DOM selector、Mock fixture，都会被 Schema 拒绝。
- 旧视觉载体只返回 `LEGACY_VISUAL_WORKFLOW_FORBIDDEN`；不转换、不别名、不回退。

## 边界

本 Skill 不读取 Figma、不创建 Lit、不生成评审页面，也不判断主观视觉是否一致。
