---
name: architecture-design
description: 在 PSP 仓库中编写、审查或验证 Architecture Package、System Boundary、Conceptual Model 或 Technical Validation 时使用。该领域 Skill 合并 Agent 工作流、Contract、Schema、模板、渲染器、领域 Validator 与技术验证能力；Architecture Design 使用独立生命周期，并可选择显式、固定版本、只读的 Product Design 输入引用，禁止从实现便利性反推或修改产品事实。
---

# Architecture Design

## 边界

本 Skill 是 Architecture Design Domain（架构设计领域）的仓库级封装，拥有架构设计工作流和本目录中的领域资源。Harness 只登记输入输出绑定、路径与 Scope、工程命令、Dependency/Handoff 边、生命周期和阻断码；Dependency 语义由本 Skill 或一致性 Skill 解释，Handoff 授权由用户决定。

## 资源路由

只读取当前产物所需资源：

- Architecture Package：`architecture-package/contract.yaml`、`architecture-package/schema.json`、`architecture-package/template.yaml`
- System Boundary：`system-boundary/contract.yaml`、`system-boundary/schema.json`、`system-boundary/template.yaml`
- Conceptual Model：`conceptual-model/contract.yaml`、`conceptual-model/schema.json`、`conceptual-model/template.yaml`
- Technical Validation：`technical-validation/contract.yaml`、`technical-validation/schema.json`、`technical-validation/template.yaml` 与 `technical-validation/template-area/`
- 可执行能力：渲染器与领域 Validator 位于 `scripts/`，领域回归测试位于 `tests/`

每个架构产物必须从 `psp.project.yaml` 的 Artifact binding 读取固定 `inputRoot`。`inputRoot` 只保存当前产物的支撑输入与技术执行回执，不是权威模型或正式输出；同阶段产物必须从其项目绑定读取，不得复制到输入目录形成第二事实源。

## 工程结构

以下路径均相对 Architecture Design 阶段根目录；阶段根目录本身仍由项目绑定决定：

| Artifact | 固定输入目录 | Contract 声明的输入 Artifact | 权威模型 | 正式输出 |
|---|---|---|---|---|
| Architecture Package | `inputs/architecture-package/` | `system-boundary`、`conceptual-model`、`technical-validation`；可选只读引用 `product-design/capabilities@version` | `.psp/models/architecture-package.yaml` | `README.md` |
| System Boundary | `inputs/system-boundary/` | 无硬依赖；从本地 Architecture 输入建立 | `.psp/models/system-boundary.yaml` | `系统边界.md` |
| Conceptual Model | `inputs/conceptual-model/` | `system-boundary` | `.psp/models/conceptual-model.yaml` | `概念建模.md` |
| Technical Validation | `inputs/technical-validation/` | `system-boundary` | `.psp/models/technical-validation.yaml` | `技术验证/README.md` |

Technical Validation 的真实代码固定放在 `技术验证/cases/EXP-NNN.case.mjs`。输入目录可以保存当前产物的补充来源说明或真实执行回执，但不得复制已绑定的上游正式产物。

产物级 Scope 依赖固定为：System Boundary 无跨阶段依赖；Conceptual Model 与 Technical Validation 依赖 System Boundary；Architecture Package 依赖 Conceptual Model 与 Technical Validation。每个产物使用自己的 readiness Profile，不得用整个 Architecture Delivery 的严格门禁代替中间步骤检查。

## 工作流

1. 读取 `AGENTS.md`、`.psp/harness/HARNESS.md`、`psp.project.yaml` 和项目绑定的 Manifest。
2. 使用 `$apply-repository-harness` 解析用户明确请求的当前产物、实际路径和 Manifest 声明的同阶段上游。Architecture 阶段初始化不得运行 Product Design readiness、handoff 或状态转换；无论 Product Design 是 uninitialized、active/draft、published 还是 reopen 后的 active，都只由 Architecture 自己的状态决定能否初始化。
3. 从 Manifest 登记位置读取当前产物的 Contract、Schema 和模板，并从项目绑定读取固定 `inputRoot`；不得从目录名猜测用户路径，不在本文件复制字段定义。
4. 在 Architecture Package 明确输入模式：`independent` 只使用 Architecture 本地输入；`reference` 必须记录 `product-design/capabilities`、固定 SemVer 和 `access: read-only`。引用只用于一致性校验，不得检查或控制 Product Design 生命周期，也不得修改、补齐或锁定 01。
5. 对四个内部模型产物，先在工作区外临时位置准备候选 YAML，再解析 Manifest 登记的 artifact operation；`--dry-run` 只预检 Schema 与目标路径，正式写入不要求旧版本 hash。operation 从同一候选数据生成目标 YAML 与 Markdown；不得直接编辑两者，也不得在日常更新中运行 `render:architecture`。Technical Validation 只从 System Boundary 提取标记为需要技术验证的关键能力。每个关键能力必须映射到已选择的技术方案，以及当前真实代码的测试通过结论；修改实验代码后直接重新执行，不维护源码 hash 凭证。
6. 对全部实际变更路径重新调用 Resolver，并按 Manifest 返回顺序执行所有验证命令；Skill 不维护静态命令清单，也不自行判断 readiness。
7. 当前产物完成后结束当前范围。只有用户显式请求 Handoff 时才执行 preflight，展示检查与风险后等待确认；确认形成 Receipt 也不得自动初始化或执行消费者。

## 领域约束

- 架构设计与产品设计生命周期解耦；不得以 Product Design readiness、发布状态或 handoff 阻断 Architecture 初始化、编辑或 readiness。
- `capabilities`（Use Cases）只能成为 Architecture Package 显式选择的固定版本只读引用；Canonical UI Prototype 不是架构输入、依赖或移交来源。
- Architecture operation 与 Validator 不得修改、补齐、发布、重开或锁定 Product Design 文件和状态。例如引用版本漂移时只返回 `AIH_REFERENCE_UNRESOLVED`，不得自动重跑 01 readiness 或改写引用版本。
- 当前仓库不声明工作区外消费者或外部框架生命周期；架构产物通过本地严格门禁后结束当前范围，后续消费必须由用户另行明确。
- 固定输入目录、权威模型和正式输出必须保持分离：`inputRoot` 保存支撑输入，`.psp/models/` 保存权威结构化模型，`user-artifact` 保存正式 Markdown 投影。
- 具体边界、概念模型、架构约束和技术验证规则只由本 Skill 内的 Contract、Schema 与 Validator 定义。
- Product Design 不可读或引用版本不匹配时，`reference` 模式显式阻断；`independent` 模式不读取 Product Design。
- 不把结构校验或单个技术实验成功等同于架构交付 readiness。

## 交付

按 Manifest 的 evidence report 规范报告 Scope、Changes、Validation 和 Residuals。正式架构产物、隐藏机器模型与技术验证证据必须保持各自的输入输出角色。
