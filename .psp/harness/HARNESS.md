# pre-sdd 脚手架工程 Harness

本 Harness 只治理脚手架源仓库，与产品语义和架构语义无关。机器事实来源是根 `psp.project.yaml` 与 `.psp/harness/harness.manifest.json`。

## 四个执行上下文

| 上下文 | 物理位置 | 拥有内容 | 不拥有内容 |
|---|---|---|---|
| 脚手架源仓库（Scaffold Repository） | 仓库根目录 | 模板、运行时、测试、打包与发布工程 | 产品或架构用户阶段 |
| 工作区模板（Workspace Template） | `templates/workspace/` | 生成工作区初始文件 | 活跃用户实例与运行证据 |
| 打包运行时（Packaged Runtime） | `bin/`、`runtime/` | 通用命令分发与依赖环境 | 目标工作区的本地执行事实 |
| 生成工作区（Generated Workspace） | `pre-sdd init` 的目标目录 | 本地 Manifest、领域 Skill、Contract、Schema、Validator 与用户产物 | 脚手架源仓库维护规则 |

## 解析与变更

1. 读取适用的 `AGENTS.md`、根项目绑定、本协议和根 Manifest。
2. 以仓库相对 POSIX 路径调用：

       node .psp/harness/scripts/resolve-validation.mjs --path <path>... --intent change|readiness --json

3. resolver 返回 `BLOCKED` 时停止目标写入。`readiness` 在根仓库只表示脚手架工程门禁，不表示任何产品或架构内容就绪。
4. 只修改本次请求覆盖的最小脚手架范围；不得初始化模板中的产品或架构用户实例。

## 硬治理不变量

- 根项目类型、模板绑定、运行时入口和允许的根 Skill 由项目绑定与 Manifest 声明。
- 根项目不得出现 `stages`；根 Manifest 不得出现领域注册、Artifact 注册、阶段 operation 或领域 handoff。
- 模板项目必须保持全部可用阶段为 `uninitialized`，阶段根目录只能包含 Manifest 声明的工作区标记。
- 模板必须包含 Manifest 声明的本地领域 Skill，且不得包含镜像绑定、`node_modules`、构建输出或运行证据。
- 根与模板 `AGENTS.md` 必须相互独立，并满足各自声明的文本契约。
- 包运行时必须执行目标工作区 Manifest 声明的本地 executor（执行器）；包内模板只用于初始化，不得作为执行替身。
- 持续集成（Continuous Integration）工作流只能调用 Manifest 登记的统一执行器；该执行器必须先用 Resolver 覆盖全部仓库路径，再按返回顺序实际执行所有命令。

上述规则由 Schema 先校验结构，再由 `validate-harness.mjs` 完成跨文件校验。Validator 只解释脚手架工程结构，不解释产品或架构内容。

## 验证与证据

对实际变更路径重新解析，并按返回顺序执行全部命令。技术证据固定报告 Scope、Changes、Validation、Residuals；状态只允许 `PASS`、`FAIL`、`BLOCKED`、`NOT_RUN`。根 Harness 不生成业务 handoff 凭证。
