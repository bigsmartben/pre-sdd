---
name: architecture-design
description: 在 PSP 仓库中编写、审查或验证 Architecture Package、System Boundary、Conceptual Model 或 Technical Validation 时使用。该领域 Skill 合并 Agent 工作流、Contract、Schema、模板、渲染器、领域 Validator 与技术验证能力；通过项目绑定和 Harness 完成上游门禁、路径路由、输入输出治理、工程门禁与 handoff，禁止从实现便利性反推或修改产品事实。
---

# Architecture Design

## 边界

本 Skill 是 Architecture Design Domain（架构设计领域）的仓库级封装，拥有架构设计工作流和本目录中的领域资源。Harness 只拥有输入输出绑定、路径与 Scope、工程命令、依赖、生命周期、阻断码协议和确定执行的 handoff；不要把架构语义写入 Harness。

## 资源路由

只读取当前产物所需资源：

- Architecture Package：`architecture-package/contract.yaml`、`architecture-package/schema.json`、`architecture-package/template.yaml`
- System Boundary：`system-boundary/contract.yaml`、`system-boundary/schema.json`、`system-boundary/template.yaml`
- Conceptual Model：`conceptual-model/contract.yaml`、`conceptual-model/schema.json`、`conceptual-model/template.yaml`
- Technical Validation：`technical-validation/contract.yaml`、`technical-validation/schema.json`、`technical-validation/template.yaml` 与 `technical-validation/template-area/`
- 可执行能力：渲染器与领域 Validator 位于 `scripts/`，领域回归测试位于 `tests/`

每个架构产物必须从 `psp.project.yaml` 的 Artifact binding 读取固定 `inputRoot`。`inputRoot` 只保存当前产物的支撑输入与技术执行回执，不是权威模型或正式输出；上游 Use Case 和同阶段产物必须从其项目绑定读取，不得复制到输入目录形成第二事实源。

## 工程结构

以下路径均相对 Architecture Design 阶段根目录；阶段根目录本身仍由项目绑定决定：

| Artifact | 固定输入目录 | Contract 声明的输入 Artifact | 权威模型 | 正式输出 |
|---|---|---|---|---|
| Architecture Package | `inputs/architecture-package/` | `capabilities`、`system-boundary`、`conceptual-model`、`technical-validation` | `.psp/models/architecture-package.yaml` | `README.md` |
| System Boundary | `inputs/system-boundary/` | `capabilities` | `.psp/models/system-boundary.yaml` | `系统边界.md` |
| Conceptual Model | `inputs/conceptual-model/` | `capabilities`、`system-boundary` | `.psp/models/conceptual-model.yaml` | `概念建模.md` |
| Technical Validation | `inputs/technical-validation/` | `capabilities`、`system-boundary` | `.psp/models/technical-validation.yaml` | `技术验证/README.md` |

Technical Validation 的真实代码固定放在 `技术验证/cases/EXP-NNN.case.mjs`。输入目录可以保存当前产物的补充来源说明或真实执行回执，但不得复制已绑定的上游正式产物。

产物级 Scope 依赖固定为：System Boundary 依赖 Use Cases；Conceptual Model 依赖 Use Cases 与 System Boundary；Technical Validation 依赖 Use Cases 与 System Boundary；Architecture Package 依赖 Conceptual Model 与 Technical Validation。每个产物使用自己的 readiness Profile，不得用整个 Architecture Delivery 的严格门禁代替中间步骤检查。

## 工作流

1. 读取 `AGENTS.md`、`.psp/harness/HARNESS.md`、`psp.project.yaml` 和项目绑定的 Manifest。
2. 使用 `$apply-repository-harness` 解析用户明确请求的当前产物、实际路径和 Manifest 声明的产物级上游。Architecture 阶段初始化通过 `upstreamScopes` 独立验证 Use Cases readiness，不要求也不生成 Use Cases → Architecture handoff；Use Cases readiness 未通过时停止，不生成架构事实，也不得要求 Canonical UI Prototype readiness。
3. 从 Manifest 登记位置读取当前产物的 Contract、Schema 和模板，并从项目绑定读取固定 `inputRoot`；不得从目录名猜测用户路径，不在本文件复制字段定义。
4. 只从已验证的产品事实推导架构决策。无法由上游支持的内容记录为 gap、assumption 或 blocker，不得静默回写产品设计。
5. 对四个内部模型产物，先在工作区外临时位置准备候选 YAML，再解析 Manifest 登记的 artifact operation；`--dry-run` 只预检 Schema 与目标路径，正式写入不要求旧版本 hash。operation 从同一候选数据生成目标 YAML 与 Markdown；不得直接编辑两者，也不得在日常更新中运行 `render:architecture`。Technical Validation 只从已验证 Use Cases 与 System Boundary 提取标记为需要技术验证的关键能力。每个关键能力必须映射到已选择的技术方案，以及当前真实代码的测试通过结论；修改实验代码后直接重新执行，不维护源码 hash 凭证。
6. 对全部实际变更路径重新调用 Resolver，并按 Manifest 返回顺序执行所有验证命令；Skill 不维护静态命令清单，也不自行判断 readiness。
7. 当前产物 readiness 全部通过且 Manifest 为当前产物声明了合法移交边时，必须执行登记的 handoff operation；不得保存用户审批或自动初始化消费者。Manifest 未声明消费者时，在 readiness 通过后结束当前范围。

## 领域约束

- 架构设计单向依赖产品设计，不得从代码或实现便利性反推、修改或伪造产品事实。
- 架构设计的唯一产品上游是 `capabilities`（Use Cases）；Canonical UI Prototype 不是架构输入、依赖或移交来源。
- 当前仓库不声明工作区外消费者或外部框架生命周期；架构产物通过本地严格门禁后结束当前范围，后续消费必须由用户另行明确。
- 固定输入目录、权威模型和正式输出必须保持分离：`inputRoot` 保存支撑输入，`.psp/models/` 保存权威结构化模型，`user-artifact` 保存正式 Markdown 投影。
- 具体边界、概念模型、架构约束和技术验证规则只由本 Skill 内的 Contract、Schema 与 Validator 定义。
- status 为 `unavailable` 的上游禁止写入；下游只能显式记录缺口。
- 不把结构校验或单个技术实验成功等同于架构交付 readiness。

## 交付

按 Manifest 的 evidence report 规范报告 Scope、Changes、Validation 和 Residuals。正式架构产物、隐藏机器模型与技术验证证据必须保持各自的输入输出角色。
