---
name: repair-visual-delivery
description: 从 Review Finding（评审发现）追溯最早根因，路由权威源修复，传播 Stale 并完成机器回归与人工复验状态。
---

# Repair Visual Delivery

## 固定闭环

`Finding → 稳定复现 → 确认最早根因 → 修改唯一权威源 → 下游 Stale → 重新生成/实现 → 回归验证 → 人工复验 → Closed`

例如按钮颜色不一致：若 Figma Token 错误，最早根因是 `FIGMA_SOURCE`，不能只改 Lit CSS；若 Lit 未消费正确 Token，根因才是 `LIT_L1`。

## 根因分类

`SCHEMA | CHECKLIST_BASELINE | FIGMA_SOURCE | FIGMA_BINDING | LIT_L1 | MOCK_ADAPTER | LIT_L2 | REVIEW_TOOL`

路由脚本只记录已确认的最早权威源并使引用该 `itemId` 的下游产物 Stale；它不会代替领域 Skill 修改权威源。

## 关闭条件

- `resolved`：权威源修复已绑定 revision/digest。
- `verified`：机器回归通过，且人类在真实 Lit 上复验。
- `closed`：必须已经 verified；不得跳过根因、修复或人工复验。
