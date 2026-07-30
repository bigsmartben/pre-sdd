---
name: mockcase
description: 为 L2 User Path Plan（用户路径计划）提供机器 Fixture（固定数据）、Scenario（场景）与 Review/Test Adapter。
---

# MockCase

本 Skill 只消费 `.psp/visual-spec/user-path-plan.json` 中声明的 `scenarioSlots`，并拥有 `MockCase/suite.json` 与 Review/Test Adapter。

例如 Path Plan 声明 `case-tc-007`，MockCase 可以提供库存不足响应；它不能修改 Test Case、Path Plan 或 Checklist，也不能授权产品候选。

状态只有 `draft → ready → stale`。MockCase 没有独立人工评审、候选 Apply（应用）或产品发布权限。生产 UIHTML 不得导入本目录或 `src/testing`。
