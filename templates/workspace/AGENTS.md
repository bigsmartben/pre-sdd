# PSP 生成工作区说明

当前目录是由 `sdd-pre init .` 创建的生成工作区（Generated Workspace），不是脚手架源仓库。

## 与用户协作

- 优先使用中文；英文术语首次出现时附中文说明。
- 用户可以直接用自然语言提出任务，例如“开始产品设计，先整理 Use Cases（用例）”或“独立开始架构设计”。
- 只处理用户明确请求的当前产物，不自动扩展到其他阶段、发布或下游实现。
- 最终回复说明实际修改、验证结果与剩余问题，不要求用户运行 npm、Node.js、内部脚本或治理命令。

## 工作区边界

- `psp.project.yaml` 声明阶段、产物路径和领域元数据；具体语义与工作流由 `.agents/skills/` 中对应 Domain Skill（领域技能）拥有。
- `.agents/runtime/` 只提供无领域语义的项目读取与原子文件事务。
- `.psp/harness/HARNESS.md` 只是一份简短行为原则，不是执行入口。
- 不存在 Harness Manifest、Resolver、Profile、Scope、Gate、Consistency Report（统一一致性报告）、Handoff Receipt（移交凭证）或中央生命周期控制面。遇到要求使用这些旧概念的请求时，停止写入并解释当前版本由 Agent 与领域 Skill 直接协作。
- Product Design、MockCase 与 Architecture Design 生命周期彼此独立。架构设计可只读引用固定版本的产品产物，但不得改写产品事实。
- 领域 Skill 可以在后台调用当前工作区本地脚本完成初始化、原子写入、渲染和验证；不得让用户承担这些内部操作。
- 面向用户阅读和评审的正式规格使用 Markdown；隐藏 YAML/JSON 模型只能写到项目绑定声明的位置。
- Canonical UI Prototype（规范界面原型）的可执行界面与 `src/spec/canonical-ui.ts` 是界面事实；临时截图、构建目录和评审数据不是正式交付物。
- 修改前保留已有改动；不得覆盖无关内容，不得把 `FAIL`、`BLOCKED` 或 `NOT_RUN` 描述为通过。

## 开始与停止

只有用户明确开始某领域时，Agent 才调用该领域 Skill 的初始化能力。出现范围外修复、不可恢复错误或需要新的用户决定时停止，并用通俗语言说明原因。
