# 三方 API 验证 Case

每个真实代码实验使用固定路径 `cases/EXP-NNN.case.mjs`，导出的 `experiment.id` 必须与文件名及技术验证内部模型一致，并实现 `run(context)`。`--describe` 只加载被请求的单个实验，不扫描执行其他实验模块。

运行时通过环境变量注入 endpoint 与凭据，不得把密钥、Token、完整响应正文或个人数据写入代码、规格或 evidence。`npm run verify -- --case EXP-NNN --describe` 只校验 case 注册信息并返回当前源代码的 SHA-256 哈希，不调用 `run(context)`；正常执行输出实验标识、源代码哈希、状态、耗时和脱敏断言证据。执行后把真实运行输出映射到对应技术决策与候选方案；严格校验要求 `passed` 结论与当前源代码哈希一致。
