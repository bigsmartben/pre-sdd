# Test Case Catalog

正式路径：`Cases/test-cases.json`。Artifact ID：`TEST-CASE-CATALOG`。

每个 `TC-###` 绑定一个 `UC-###` 和 `main | UC-###-ALT-## | UC-###-EXC-##` 场景。每个 `TC-###-STEP-##` 引用一个已存在的 Use Case Step，只保存有来源依据的 action（动作）与 expectedOutcome（预期结果）。

Catalog 不包含设计、框架、路由、组件、Mock、Mapping 或实现状态。
