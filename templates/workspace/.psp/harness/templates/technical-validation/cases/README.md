# 三方 API 验证 Case

每个 `*.case.mjs` 导出 `experiment`，其 `id` 必须与 `技术验证/README.md` 中列出的 `EXP-NNN` 一致，并实现 `run(context)`。

运行时通过环境变量注入 endpoint 与凭据，不得把密钥、Token、完整响应正文或个人数据写入代码、规格或 evidence。`npm run verify -- --case EXP-NNN --describe` 只校验 case 注册信息，不发出网络请求；正常执行只输出适合脱敏审阅的状态、耗时和断言证据。执行后由架构责任人审阅结论、更新内部技术验证模型，并重新生成 Markdown 用户产物。
