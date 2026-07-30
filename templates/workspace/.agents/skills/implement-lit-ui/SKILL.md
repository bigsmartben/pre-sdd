---
name: implement-lit-ui
description: 消费 Ready Checklist 与 Figma Evidence，在唯一 src/ui 中实现 Lit L1 及按需 L2。
---

# Implement Lit UI

## 前置条件

只接受 `.psp/visual-spec/ready-authorization.json`、当前 Checklist、Figma Coverage/Evidence。任一锁失效或 Gap 未闭合时停止。

## 实现顺序

1. 在 `src/ui` 实现所有 Checklist 项的 L1：Page/Component、State、Variant、Viewport、Token、Asset 和适用 Motion。
2. 为每个组合提供可确定到达的场景，并在元素上暴露 `data-visual-item-id="<itemId>"` 供 Review Driver 定位。
3. 仅当项为 `USER_PATH` 时读取 User Path Plan，在同一 `src/ui` 路由/组件上实现 L2。
4. L2 通过 `src/testing` 与 `$mockcase` Review/Test Adapter 驱动；具体 Mock 不进入 `src/ui`。
5. 记录 `lit-visual-coverage.json`，按需记录 `user-path-coverage.json`；摘要必须来自实际 `src/ui`。
6. Review 与 Production 使用同一份 `src/ui`。生产只接 `src/adapters/real`。

## 禁止

不反向修改 Checklist 或 Figma Evidence，不自行升级/降级交付层级，不创建评审复制 UI，不让生产代码读取 Spec、Evidence、Finding、Case、Path Plan 或 Mock。
