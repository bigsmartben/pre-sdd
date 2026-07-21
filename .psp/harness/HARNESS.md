# pre-sdd Maintainer Harness（维护者治理层）

本 Harness 只治理 `pre-sdd` 脚手架源仓库的维护、测试和发布准备。根 `psp.project.yaml`、本协议与 `.psp/harness/harness.manifest.json` 是机器执行的唯一事实来源（Single Source of Truth）；产品与架构内容不属于本 Harness。

## 双 Harness 模型

| 治理层 | 物理位置 | 服务对象 | 完成结果 |
|---|---|---|---|
| Maintainer Harness（维护者治理层） | 仓库根 `.psp/harness/` | 脚手架维护者与维护 Agent | 经过全部工程门禁的脚手架变更 |
| User Harness（使用者治理层） | `templates/workspace/.psp/harness/`，初始化后位于生成工作区本地 | 脚手架使用者与工作区 Agent | 受本地项目绑定约束的产品或架构执行 |

根 Harness 管“如何生产正确的脚手架与 User Harness 模板”；User Harness 管“生成工作区如何执行”。二者不得共享项目类型、领域生命周期、移交凭证或运行权威。

## 四个执行上下文

| 上下文 | 物理位置 | 拥有内容 | 不拥有内容 |
|---|---|---|---|
| 脚手架源仓库（Scaffold Repository） | 仓库根目录 | 模板、运行时、测试、打包、发布准备与 Maintainer Harness | 产品或架构用户阶段 |
| 工作区模板（Workspace Template） | `templates/workspace/` | 未来生成工作区的初始文件与 User Harness 模板 | 活跃用户实例与运行证据 |
| 打包运行时（Packaged Runtime） | `bin/`、`runtime/` | 安装、更新、新工作区初始化与内部命令分发 | 既有工作区的本地执行事实 |
| 生成工作区（Generated Workspace） | `pre-sdd init` 的目标目录 | 本地运行配置、User Harness、领域 Skill 与用户产物 | 脚手架源仓库维护规则 |

## 维护执行协议

1. 读取适用的 `AGENTS.md`、根项目绑定、本协议和根 Manifest。
2. 确认根项目类型是 `PSPScaffoldProject`，并确认没有产品或架构阶段绑定。
3. 保留用户已有改动，收集预计变更的仓库相对 POSIX 路径。
4. 调用：

       node .psp/harness/scripts/resolve-validation.mjs --path <path>... --intent change|checkpoint --json

   只有正式发布前使用 `node .psp/harness/scripts/run-ci-validation.mjs --release`；该入口是请求 `readiness` 的唯一维护协议入口。

5. 解析结果为 `BLOCKED` 时停止对应写入；否则只修改请求覆盖的最小脚手架工程范围。
6. 编辑循环使用 `change`；任务、Issue、PR、合并和普通 CI 使用 `checkpoint`；只有显式发布前验证使用 `readiness`。
7. 对全部实际变更路径重新解析，并按返回顺序执行每一条验证命令。`change` 与 `checkpoint` 只证明当前影响范围，不能形成最终完成凭证。
8. 按 Manifest 声明的证据结构报告结果。只有 `readiness` PASS 可以形成 `validated-scaffold-change`。

`change` 用于快速反馈，`checkpoint` 用于任务级和普通 CI 集成验证，`readiness` 只用于显式发布前的完整脚手架工程门禁。根仓库的这些意图都不表示产品或架构内容就绪。

## 硬治理不变量

- 根项目不得出现 `stages`；根 Manifest 不得出现领域注册、Artifact 注册、阶段 operation 或领域 handoff。
- 根 `.agents/skills/` 只能包含 Manifest 允许的脚手架维护 Skill。
- 模板项目必须是 `PSPProject`，全部可用阶段初始状态必须为 `uninitialized`。
- 模板不得包含用户实例、依赖目录、构建输出或运行证据。
- 模板中的 User Harness、领域 Skill 与执行器复制到工作区后，由生成工作区本地拥有；根 Harness 不得接管。
- 打包运行时必须执行目标工作区 Manifest 声明的本地执行器，不得用包内模板副本替代。
- 既有工作区不提供更新、升级、迁移或同步操作；全局工具更新只影响未来生成的新工作区。
- 当前仓库不绑定根 Manifest 声明为范围外的外部框架。

Schema（结构定义）先校验机器结构，Validator（校验器）再校验跨文件关系。说明文字不能替代机器门禁。

## Maintainer Handoff（维护者移交）

当前根仓库的移交对象是未来维护者与维护 Agent，结果是 `validated-scaffold-change`（已验证脚手架变更）：

```text
Repository Change Request / 仓库变更请求
  → Maintainer Harness / 维护者治理层
  → Scaffold Change / 脚手架变更
  → Engineering Validation / 工程验证
  → Validated Scaffold Change / 已验证脚手架变更
```

这不是用户产物移交，不生成产品或架构 handoff 凭证，也不启动任何下游阶段。合并由维护者在工程门禁通过后决定。

## 验证与证据

技术证据固定包含 Scope（范围）、Changes（实际变更）、Validation（逐项验证）和 Residuals（剩余阻断）。验证状态只允许 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`；失败必须提供稳定 blocker code（阻断码）。
