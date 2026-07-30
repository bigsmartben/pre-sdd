# Lit Delivery Contract

`src/ui` 是 Review/Test 与 Production（生产）唯一共享的 UI 源。Delivery Manifest（交付清单）只读组合 Checklist、Figma、L1/L2 Coverage 与 Finding，不产生第二份视觉规格。

Ready 表示机器输入闭合；Accepted 表示真实 Lit 已经完成人工评审。两者不可互换。

Production UIHTML 只允许依赖 `src/ui` 与 `src/adapters/real`。任何 `.psp/visual-spec`、`Cases`、`MockCase`、`src/review` 或 `src/testing` 依赖都会返回 `VSD_PRODUCTION_DEPENDENCY_FORBIDDEN`。
