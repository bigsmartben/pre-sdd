---
name: mockcase-coverage
description: 分析生成工作区中正式 UI Scenario 的 business MockCase 覆盖，按 Actor、Route、Use Case、Scenario 或全部缺失项生成确定性候选和领域诊断。用户要求检查、继续生成、补齐或更新 MockCase 业务覆盖时使用；只读分析，不直接修改 Use Case、Scenario、Canonical UI 或其他正式产物。
---

# MockCase Coverage

## 边界

- 只读取当前生成工作区本地 `PSPProject`、User Harness、Use Cases 和 Canonical UI；不得读取包内模板副本。
- 将正式、可在 UI 中评审的 Scenario 作为覆盖单元；`kind=technical` 不计入业务覆盖。
- 不发明业务分支、响应、文案、组件、Mock Behavior 或 State Matrix Entry。
- 不直接写正式文件。候选必须由用户确认后交给 Manifest 登记、Product Design 拥有的 `apply-mockcase-candidate` Operation。
- 上游事实不足时输出 `AIH_MOCKCASE_UPSTREAM_GAP`；这属于 Product Design 内部 remediation route（修正路由），不创建 Handoff 或 Receipt。
- Apply 成功最多表示 `MAPPED`；页面结果需由 MockCase Review Plugin 证明 `READY`，浏览器 Validator 才能证明 `VERIFIED`。

## 工作流

1. 读取 `.psp/harness/HARNESS.md`、`psp.project.yaml` 和本地 Manifest，确认项目类型为 `PSPProject`。
2. 固定 Actor 与用户指定 Scope。支持 `--route`、`--use-case`、`--scenario`；未指定时分析该 Actor 的全部缺失项。
3. 运行只读分析：

   ```text
   node .agents/skills/mockcase-coverage/scripts/analyze.mjs --actor ACTOR-001 --json
   ```

4. 如果报告包含 gap，向用户展示缺少的正式事实并停止；不得生成猜测内容或调用 Apply。
5. 生成确定候选：

   ```text
   node .agents/skills/mockcase-coverage/scripts/generate.mjs --actor ACTOR-001 --use-case UC-001 --json
   ```

6. 展示 existing、generated、stale、blocked、覆盖率差量、`inputHash` 与 `candidateHash`，等待用户明确确认。
7. 用户确认后，把完整 JSON 保存到操作系统临时目录，调用：

   ```text
   npm run apply:mockcase-candidate -- --actor ACTOR-001 --input <temporary-candidate.json> --json
   ```

8. Apply 后运行 Harness resolver 返回的全部验证。输入漂移时以 `AIH_MOCKCASE_CANDIDATE_STALE` 停止并重新分析。

## 结果解释

| 状态 | 含义 | 例子 |
|---|---|---|
| existing | 当前 business Case 仍有效 | `SCENARIO-001` 已由 `MOCK-CASE-SCENARIO-001` 覆盖 |
| generated | 可基于现有正式事实生成 | 失败 Scenario 已有组件、Behavior 和 Matrix Entry |
| stale | Case 引用的正式输入已变化 | Scenario 已删除或 Effect 指向旧实例 |
| blocked | 缺少上游事实，不能生成 | 超时 Scenario 没有正式恢复状态或响应 |

相同输入、Scope 与模型版本必须产生相同 Case ID、顺序、内容和候选哈希。Scope 外 Case 与非 MockCase 实现必须保持不变。
