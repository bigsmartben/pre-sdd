---
name: repair-visual-delivery
description: Route Flutter UI Preview Review Findings to the earliest authoritative Visual Spec, Figma, Flutter L1/L2, Mock Adapter, or Preview Tool source; propagate stale state through Flutter Coverage, selected-target Preview, and UI-SPEC-MANIFEST; and control repair, machine regression, human re-verification, and closure. Use when diagnosing or repairing visual delivery findings in the Flutter UI chain.
---

# Repair Visual Delivery

## 固定闭环

`Finding → 稳定复现 → 确认最早根因 → 修改唯一权威源 → 下游 Stale → 重新生成/实现 → 回归验证 → 人工复验 → Closed`

例如按钮颜色不一致：若 Figma Token 错误，最早根因是 `FIGMA_SOURCE`，不能只改 Flutter Widget；若 Widget 未消费正确 Token，根因才是 `FLUTTER_L1`。

## 根因分类

`SCHEMA | CHECKLIST_BASELINE | FIGMA_SOURCE | FIGMA_BINDING | FLUTTER_L1 | MOCK_ADAPTER | FLUTTER_L2 | REVIEW_TOOL`

路由脚本只记录已确认的最早权威源并使引用该 `itemId` 的 Coverage、Preview 与 Manifest Stale；它不会代替领域 Skill 修改权威源，也不会直接补丁派生产物。

## 关闭条件

- `resolved`：脚本从实际权威文件读取 digest；有 Artifact revision 时同时绑定实际 revision。Figma Source 绑定当前正式 Figma Evidence 作为可验证证据，不接受调用者自报摘要。
- `verified`：机器回归通过，且人类在当前 selected-target Flutter Preview 上复验。
- `closed`：必须已经 verified；不得跳过根因、修复或人工复验。
