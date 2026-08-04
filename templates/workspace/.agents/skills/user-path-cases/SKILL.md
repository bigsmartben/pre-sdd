---
name: user-path-cases
description: 维护框架无关的 Test Case Catalog（测试用例目录），并将 Ready Checklist 编译为 L2 User Path Plan（用户路径计划）。
---

# User Path Cases

本 Skill 拥有两个不可合并的机器产物：

- `Cases/test-cases.json`：产品行为测试事实，ID 为 `TC-###` / `TC-###-STEP-##`。
- `.psp/visual-spec/user-path-plan.json`：把 Ready Test Case 与 Ready Checklist 绑定为 L2 待实现路径。

例如 `TC-007` 可以描述“库存不足 → 修改数量 → 提交成功”，Path Plan 可声明路由检查点和 `inventory-shortage` 场景槽位；具体 Mock 响应由 `$mockcase` 拥有。

本 Skill 不读取 Figma，不声明 Flutter Widget 或 Finder，不写 Mock 数据，也不改变 Checklist 的交付层级。
