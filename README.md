# sdd-pre

`sdd-pre` 是一个通过 Python 工具分发的工作区脚手架。它把本地 Agent 所需的 Product Design（产品设计）、MockCase 和 Architecture Design（架构设计）技能复制到一个全新目录；之后用户只需继续与 Agent 对话。

## 使用者

```bash
uv tool install git+https://github.com/bigsmartben/pre-sdd.git
mkdir my-design
cd my-design
sdd-pre init .
```

初始化成功后，可以直接告诉 Agent：

- “开始产品设计，先把想法整理成 Use Cases（用例）。”
- “根据这些用例和 Figma 逐轮澄清 Mapping.html，确认后实现 Lit UI。”
- “独立开始架构设计，并记录还缺少的输入。”

初始化要求目标是已存在、非符号链接且没有模板顶层同名路径的真实目录。发生冲突、复制失败或提交失败时，命令会回滚，目标目录不会留下半成品。既有工作区不支持更新、升级或同步。

## 维护者

| 位置 | 责任 |
|---|---|
| `pyproject.toml`、`runtime/sdd_pre/` | Python 分发与事务初始化 |
| `templates/workspace/` | 新工作区模板的唯一事实来源 |
| `templates/workspace/.agents/skills/` | 各领域工作流、契约、脚本与测试 |
| `templates/workspace/.agents/runtime/` | 无领域语义的项目读取和原子文件事务 |
| `tests/package/` | 分发、初始化和模板边界测试 |

维护者通过普通 CI 执行工程测试。根与模板的 `.psp/harness/` 都只能保留一份 `HARNESS.md` 原则文档，不得恢复可执行控制面。
