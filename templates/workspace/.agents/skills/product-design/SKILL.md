---
name: product-design
description: 在 PSP 工作区中建立、编写和验证 Product Use Cases（产品用例）与 Functional Delivery Baseline（功能交付基线）。
---

# Product Design

## 唯一职责

本 Skill 只拥有两类上游机器事实：

- `PRODUCT-USE-CASES`：产品行为、Actor（参与者）、场景、步骤、交互状态和 Low-Fi（低保真）蓝图。
- `FUNCTIONAL-DELIVERY-BASELINE`：每个范围项必须交付到 `VISUAL`（L1 视觉）还是 `USER_PATH`（L1 + L2 用户路径）。

具体例子：结算失败属于 Product Use Case；“该失败分支必须作为 USER_PATH 运行”属于 Functional Delivery Baseline。按钮颜色、Figma 节点、Flutter Widget 和 Mock 响应都不属于本 Skill。

## 工作流

1. 读取 `psp.project.yaml` 的正式 Registry（注册表）路径，不扫描目录猜测产物。
2. 初始化时只生成 `use-cases.yaml`、`functional-delivery-baseline.json` 与只读 `UC.md`。
3. 每次修改机器产物落盘字节前递增 `metadata.revision`。
4. 未确定事实保留结构化 `gaps`；不得根据设计或实现推断产品事实。
5. 两个源均为 `ready` 且无 gap 后，调用 `$visual-spec` 编译视觉规格清单。

## 硬边界

- 不拥有 Visual Spec、Figma Evidence（设计证据）、Flutter UI、Mock、Preview 或 UI-SPEC-MANIFEST。
- 不生成视觉规格的人类文档或评审页面。
- 不创建兼容转换器、迁移入口或中央工作流控制面。
