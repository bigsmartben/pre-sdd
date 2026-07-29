# 工作区原则

本目录只允许存在本文件；它不提供命令、解析器或机器协议。

- Agent 直接理解用户的自然语言请求，并调用对应领域 Skill。
- 领域 Skill 自己拥有初始化、产物写入、渲染和验证。
- 不自动开始其他阶段，不自动发布，不自动执行下游工作。
- 遇到旧 Harness Manifest、Resolver、Profile、Scope、Gate、Consistency Report 或 Handoff Receipt 请求时，不产生副作用，并解释这些概念已移除。
- 保留已有改动，如实报告 `PASS`、`FAIL`、`BLOCKED` 或 `NOT_RUN`。
