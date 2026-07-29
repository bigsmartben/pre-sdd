---
name: mockcase
description: 在生成工作区中分析、生成、初始化、应用、评审和验证独立 MockCase Suite。仅在用户显式要求 MockCase 时使用；不属于 Product Design 主流程。
---

# MockCase

## 责任边界

- 只读取当前工作区的 Use Cases 与 Canonical UI；不得修改这些上游产物，也不读取或创建跨领域移交收据。
- `mockdata.json` 只拥有 Fixture 与可追溯的请求响应行为事实；`mockcases.json` 只拥有场景编排、State Matrix 引用和 Fixture → 公开 Lit Property 的 Data Binding（数据绑定）。
- Schema 决定 JSON 结构，Validator 决定跨文件引用、覆盖与生命周期；JSON Suite 固定位于 `MockCase/.psp/models/actors/ACTOR-NNN/`，是隐藏 Internal Model Set（内部模型集合），不是用户交付物。
- Analyze 与 Generate 只读，可在 `mockcase` 未初始化时运行。上游事实不足时返回 `AIH_MOCKCASE_UPSTREAM_GAP`，不得猜测。
- 新 Case 优先匹配覆盖 Recovery State 的合法 State Matrix Entry；没有 Recovery State 时匹配 Expected State。只有唯一匹配才能自动采用；零个或多个匹配必须形成 Gap，并由显式 MockData Packet 的 `stateMatrixEntryId` 消歧。
- Generate 每次读取最新 Use Cases 与 Canonical UI；旧 Suite 的输入锁漂移只形成 STALE，不阻止生成修复 Candidate。Candidate 只列出与当前 Suite 不同的增删改。
- 用户只请求 Analyze 或 Generate 时只执行对应只读操作，工作区必须字节级不变；用户明确请求 Initialize、Apply、Project、Review 或 Verify 时只执行其请求覆盖的操作。
- 只有用户明确要求“端到端完成 MockCase”或等价完整流程时，才授权本次 Scope 内连续执行 Analyze → Generate → Initialize（仅首次）→ Apply → Project → Review → Verify；此时不得在 Candidate、Initialize 或 Apply 前重复请求聊天确认。
- Apply 必须自行校验 Candidate 内的 `candidateHash`、`inputLock` 和目标 Suite 摘要，并只通过登记 Operation 原子写入目标 Actor 的三个 Suite 文件；这些摘要是完整性与并发锁，不是第二次用户授权。
- Apply 前发现 `AIH_MOCKCASE_CANDIDATE_STALE` 时，自动重新读取最新上游、重新 Analyze / Generate 并继续。只有缺失且无法从权威来源取得的业务事实、上游结构冲突或不可恢复失败才停止。
- Runtime Projector 将 State Matrix、Fixture Data Binding、Behavior 和 `request` / `control-event` / `input` Activation（激活）预编译进同一个 Runtime Bundle。请求使用 Method + Path + Query + Header 一次完整匹配，命中后同一 Behavior 同时决定 Status、Header、Delay 与 Payload；零命中回退原始 Fetch，多命中返回 `AIH_MOCKCASE_CONFLICT`。
- Review Extension 只消费确定性 Runtime Bundle，通过公开的组件实例、Contract 与 Control 标记执行 Activation。`input` 可以写入 Input/Select/Textarea value 或公开 Control 的 `textContent`，但必须在 Case 切换、失败、取消和 dispose 后恢复；不得访问私有状态、写文件或向 Product Design 注入 MockCase Hook。
- 每次事务同时保存公开 Lit Property、Input/Select/Textarea value、被修改的 `textContent`、Behavior 与 active Case 集合。回滚失败稳定返回 `AIH_MOCKCASE_ROLLBACK_FAILED`，且不得形成 READY/VERIFIED Evidence。
- READY 只能在全局覆盖完整、当前 Runtime Digest 下每个 Route 的全部 Case 都实际 Apply 且成功 Rollback 后，由用户逐 Route 点击“完成当前路由”形成；Evidence 必须保存 Route、Case、Apply、Rollback 和 Review Decision。独立 Validator 逐 Route 执行全部 Runtime Case，并比较 dispose 前后的公开状态摘要。

## 工作流

1. 读取 `.psp/harness/HARNESS.md` 与 `psp.project.yaml`，确认这是当前生成工作区并已绑定 `mockcase`。
2. 只读分析：

   ```text
   npm run analyze:mockcase -- --actor ACTOR-001 --json
   ```

3. 生成确定性 Candidate；显式 MockData Packet 可通过 `--mockdata` 提供：

   ```text
   npm run generate:mockcase-candidate -- --actor ACTOR-001 --mockdata <packet.json> --json
   ```

4. 报告 `mockDataChanges`、`mockCaseChanges`、覆盖差量、`inputLock` 和 `candidateHash`。只读请求到此停止；端到端请求不暂停等待重复确认。
5. `mockcase` 为 `uninitialized` 时自动初始化并继续；已经是 `active` 时跳过。不得请求或消费旧的跨领域移交收据：

   ```text
   npm run init:mockcase -- --actor ACTOR-001 --json
   ```

6. 将 Candidate 保存到操作系统临时目录并应用：

   ```text
   npm run apply:mockcase-candidate -- --actor ACTOR-001 --input <candidate.json> --json
   ```

   返回 `AIH_MOCKCASE_CANDIDATE_STALE` 时自动回到步骤 2，不再次询问用户。

7. 生成运行投影。若 Playwright 报告缺少 Chromium，执行一次 `npm run install:browser`。另启本地 Canonical UI 服务并使用其实际 URL：

   ```text
   npm run project:mockcase-runtime -- --actor ACTOR-001 --json
   npm run dev -- --actor ACTOR-001
   npm run review:mockcase -- --actor ACTOR-001 --review-url <canonical-ui-url> --headed --json
   ```

   Review 窗口保持打开，Extension 按 Route 分组 Case；当前 Route 投影稳定后点击“完成当前路由”，所有含 Case 的 Route 都完成后才写入新的 READY Evidence。路由间进度只存于 MockCase 命名空间的 session storage，完成或取消后清理。不得用非交互 Review 生成 Human READY Evidence，也不得在聊天中追加确认步骤。

8. 只有独立无头浏览器验证通过后才报告 VERIFIED：

   ```text
   npm run verify:mockcase -- --actor ACTOR-001 --review-url <canonical-ui-url> --json
   ```

## 状态解释

| 状态 | 唯一证明者 | 含义 |
|---|---|---|
| PARTIAL | 静态 Validator | Scoped Apply 已成功，但尚未覆盖全部 Canonical UI Scenario；不得 Review 或 Verify |
| MAPPED | Projector + 静态 Validator | Suite 全局覆盖完整，且已生成当前确定性 Runtime Bundle |
| READY | Review Runner | 当前 Runtime Bundle 已在浏览器中完成事务与回滚 |
| VERIFIED | 独立浏览器 Validator | 全量 Case 与当前摘要一致 |
| STALE | Validator | 上游、Suite、Runtime 或 Host API 摘要已漂移 |

`mockcase-quick` 接受 PARTIAL/MAPPED/READY/VERIFIED；`mockcase-readiness` 只接受 READY/VERIFIED；`mockcase-runtime` 与 active 状态的 `mockcase-main` 只接受 VERIFIED。STALE 在这些门禁中均失败。
