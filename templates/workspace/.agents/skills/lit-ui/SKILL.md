---
name: lit-ui
description: 基于 Ready Visual Spec 与 Figma Evidence 实现真实 Lit L1/L2、唯一 Review Delivery（评审交付）和隔离的生产 UIHTML。
---

# Lit UI

## 权威实现

真实权威是工作区 `src/ui/` 下的 Lit/TypeScript 模块。L1 `VISUAL` 覆盖所有 Checklist 项；只有 `USER_PATH` 项追加 L2。Review/Test Build（评审/测试构建）与生产 UIHTML 必须绑定同一份 `src/ui` commit 和 digest。

具体例子：按钮默认、hover、disabled、loading 属于 L1；“库存不足 → 修改数量 → 提交成功”属于按需 L2。两者都运行真实 `src/ui`，不复制一份评审 UI。

## 机器产物

- `.psp/visual-spec/lit-visual-coverage.json`
- `.psp/visual-spec/user-path-coverage.json`（仅有 L2 时）
- `.psp/visual-spec/delivery-manifest.json`
- `.psp/visual-spec/review-findings.json`
- `.psp/visual-spec/uihtml-production.json`

唯一正式人类评审入口由 `delivery-manifest.json` 导航真实 Lit。Marker（标记工具）以 `itemId` 为主键；L2 还记录 `testCaseId` 和 `pathStepId`。

## 运行隔离

- Review/Test 只替换 Adapter（适配器）并增加导航和 Marker。
- 生产入口只使用真实 Adapter。
- Delivery 前必须把 `src/ui`、`src/product-main.ts` 与 `src/adapters/real` 提交到同一 Git commit；Review Build 和 Product Build 都由 Vite 实际构建。
- 成功的 Product Build 自动记录 `uihtml-production.json`，不得用手写 UIHTML 或单独记录命令伪造构建来源。
- UIHTML Bundle 不得包含或读取 Visual Spec、Figma Evidence、Finding、Mock、Case、Path Plan、Review Tool。
- Mock 或评审代码泄漏生产构建时必须阻断。

## 状态

- L1：`pending → implemented → reviewing → accepted → stale`
- L2：`not-required | pending → implemented → verifying → accepted → stale`
- Finding：`open → triaged → repairing → resolved → verified → closed`

旧视觉载体、旧状态或旧实现入口统一返回 `LEGACY_VISUAL_WORKFLOW_FORBIDDEN`。
