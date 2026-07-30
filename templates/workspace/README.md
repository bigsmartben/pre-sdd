# PSP 工作区

这个目录保存本项目的 Product Design（产品设计）、Visual Delivery（视觉交付）、MockCase 和 Architecture Design（架构设计）产物。使用者只需向本地 Agent 描述目标。

## 对话示例

- “开始产品设计，把以下想法整理成 Use Cases（用例）：……”
- “把当前功能范围分为 VISUAL（视觉）和 USER_PATH（用户路径），再生成机器视觉规格清单。”
- “把清单绑定到这份 Figma 设计证据，并列出缺失项。”
- “在真实 Lit 中实现 L1 和声明的 L2，然后打开唯一评审交付。”
- “为 USER_PATH 的场景槽位准备 Mock Fixture（固定测试数据）。”
- “独立开始架构设计，先明确系统边界。”

Agent 会读取 `psp.project.yaml` 与对应的 `.agents/skills/`，在后台完成初始化、原子写入、投影和验证。使用者无需运行任何内部命令。

## 目录

| 路径 | 内容 |
|---|---|
| `01-product-design/` | Product Use Cases 与 Functional Delivery Baseline（功能交付基线） |
| `Cases/` | 仅 USER_PATH 需要的框架无关 Test Case Catalog（测试用例目录） |
| `.psp/visual-spec/` | Checklist、Figma/Lit Coverage、Finding 和交付锁等机器事实 |
| `src/ui/`、`UIHTML/` | 同一份真实 Lit 权威源码与隔离的最终产品交付 |
| `MockCase/` | 仅 Review/Test 使用的场景与 Fixture |
| `02-architecture-design/` | 系统边界、概念模型与技术验证 |
| `.agents/skills/` | Agent 使用的领域技能 |
| `.agents/runtime/` | 无领域语义的本地事务工具 |
| `.psp/` | 隐藏模型、发布记录与简短行为原则 |

视觉链是单向且可追溯的：产品事实决定范围，Figma 提供设计证据，Lit 提供真实实现，UIHTML 来自同一份已评审源码。中间机器产物不需要人类签署；人类只评审真实 Lit。Product Design、MockCase 和 Architecture Design 的权威边界仍相互独立。
