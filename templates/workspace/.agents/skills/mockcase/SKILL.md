---
name: mockcase
description: 在生成工作区中分析、生成、初始化、应用、评审和验证独立 MockCase Suite。用户显式要求 MockCase，或确认 canonical-ui-prototype 到 mockcase 的 Handoff 后使用；不属于 Product Design 主流程。
---

# MockCase

## 责任边界

- 只读取当前工作区的 Use Cases、Canonical UI 和可选 Handoff Receipt；不得修改这些上游产物。
- `mockdata.json` 只拥有 Fixture 与可追溯的请求响应行为事实；`mockcases.json` 只拥有场景编排、State Matrix 引用和 Fixture → 公开 Lit Property 的 Data Binding（数据绑定）。
- Schema 决定 JSON 结构，Validator 决定跨文件引用、覆盖与生命周期；本 Skill 只编排一次用户触发后的领域命令。
- Analyze 与 Generate 只读，可在 `mockcase` 未初始化时运行。上游事实不足时返回 `AIH_MOCKCASE_UPSTREAM_GAP`，不得猜测。
- 新 Case 优先匹配覆盖 Recovery State 的合法 State Matrix Entry；没有 Recovery State 时匹配 Expected State。只有唯一匹配才能自动采用；零个或多个匹配必须形成 Gap，并由显式 MockData Packet 的 `stateMatrixEntryId` 消歧。
- Generate 每次读取最新 Use Cases 与 Canonical UI；旧 Suite 的输入锁漂移只形成 STALE，不阻止生成修复 Candidate。Candidate 只列出与当前 Suite 不同的增删改。
- 用户显式触发本 Skill 即授权本次 Scope 内的 Analyze → Generate → Initialize（仅首次）→ Apply → Project → Review → Verify；不得在 Candidate、Initialize 或 Apply 前再次请求聊天确认。
- Apply 必须自行校验 Candidate 内的 `candidateHash`、`inputLock` 和目标 Suite 摘要，并只通过登记 Operation 原子写入目标 Actor 的三个 Suite 文件；这些摘要是完整性与并发锁，不是第二次用户授权。
- Apply 前发现 `AIH_MOCKCASE_CANDIDATE_STALE` 时，自动重新读取最新上游、重新 Analyze / Generate 并继续。只有缺失且无法从权威来源取得的业务事实、上游结构冲突或不可恢复失败才停止。
- Runtime Projector 将 State Matrix 与 Fixture Data Binding 预编译成公开 Lit Property assignments；网络型与非网络型 Case 都走同一 DataModel 投影，不执行请求匹配。
- Review Extension 只消费确定性 Runtime Bundle，通过 `data-component-instance-id` 与 `data-component-contract-id` 定位正式组件并给 Contract 声明的公开响应式属性赋值。不得点击正式控件、派发正式事件、写输入值、拦截 Fetch、修改私有 DOM 或向 Product Design 注入 MockCase Hook。
- Case 面板的按钮点击只属于 Review Tool 自己；赋值后等待 Lit `updateComplete` 并核对公开状态标记。Review Host 保持 `psp.review-extension/v1` 中立接口，不拥有 MockCase 投影语义。
- READY 只能在当前 Apply 事务成功、全局覆盖完整且运行投影稳定后，由用户逐 Route 点击“完成当前路由”形成；该页面操作是评审证据，不是再次授权 Skill。独立 Validator 必须逐 Route 执行全部 Runtime Case，并核对 Evidence 的完整事实集合。

## 工作流

1. 读取 `.psp/harness/HARNESS.md`、`psp.project.yaml` 和 Manifest，确认 `PSPProject` 与 `mockcase` 注册。
2. 只读分析：

   ```text
   npm run analyze:mockcase -- --actor ACTOR-001 --json
   ```

3. 生成确定性 Candidate；显式 MockData Packet 可通过 `--mockdata` 提供：

   ```text
   npm run generate:mockcase-candidate -- --actor ACTOR-001 --mockdata <packet.json> --json
   ```

4. 报告 `mockDataChanges`、`mockCaseChanges`、覆盖差量、`inputLock` 和 `candidateHash`，不暂停等待确认。
5. `mockcase` 为 `uninitialized` 时自动初始化并继续；已经是 `active` 时跳过。Receipt 可选且只作为来源证明：

   ```text
   npm run init:mockcase -- --actor ACTOR-001 [--receipt <receipt.json>] --json
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
