# PSP 工作区

这个目录保存本项目的 Product Design（产品设计）、MockCase 和 Architecture Design（架构设计）产物。使用者只需向本地 Agent 描述目标。

## 对话示例

- “开始产品设计，把以下想法整理成 Use Cases（用例）：……”
- “根据当前 Use Cases 编写 Visual Spec（视觉规格）。”
- “为 ACTOR-001 分析 MockCase，但暂时不要写入。”
- “独立开始架构设计，先明确系统边界。”

Agent 会读取 `psp.project.yaml` 与对应的 `.agents/skills/`，在后台完成初始化、原子写入、投影和验证。使用者无需运行任何内部命令。

## 目录

| 路径 | 内容 |
|---|---|
| `01-product-design/` | Use Cases、Visual Spec 与 Canonical UI Prototype |
| `MockCase/` | 独立的模拟案例模型与评审材料 |
| `02-architecture-design/` | 系统边界、概念模型与技术验证 |
| `.agents/skills/` | Agent 使用的领域技能 |
| `.agents/runtime/` | 无领域语义的本地事务工具 |
| `.psp/` | 隐藏模型、发布记录与简短行为原则 |

Product Design、MockCase 和 Architecture Design 生命周期相互独立。Agent 不会因为开始其中一个领域而自动推进另一个领域。
