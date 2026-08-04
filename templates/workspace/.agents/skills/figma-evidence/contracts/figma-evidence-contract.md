# psp.dev/figma-evidence/v1

## Contract（语义契约）

- 外部输入：Ready `.psp/visual-spec/checklist.json`、Figma locator 与 file/page/node scope，以及可读取 Figma 的连接权限。
- Figma acquisition：只有本 Skill 调用 Figma 连接器。连接器不可用、权限不足、scope 不可读取或 Asset 导出失败时 fail-closed。
- 内部派生：`source.digest`、node digest 与 Asset digest；摘要只按原始采集 payload 或导出字节计算，不接受调用者自声明值。
- 内部中间态：Intake，只能位于操作系统临时目录，通过私有 Schema 校验，不进入 Registry，也不是公开命令输入。
- 正式输出：Coverage、Evidence 与从 Figma 导出到 `assets/**` 的 Assets；三者必须由同一原子事务提交。
- 失败语义：采集、绑定、导出或 freshness 失败均产生结构化 Gap，并返回 `BLOCKED`；非 `ready` 正式产物不得被 Validator 判为 `PASS`。

## Freshness（新鲜度）

Coverage 锁定 Checklist 字节；Coverage 与 Evidence 锁定同一 Figma source。每个主门禁必须重新采集当前 scope，并把私有 Intake 交给 Figma Validator 重新计算 revision/digest；缺少当前采集时返回 `BLOCKED`，漂移时返回 `STALE`。

## Scope（范围）

Checklist `target.kind` 与 Coverage anchor `role` 必须语义对应；所有 anchor、Asset、Token、Motion source node 都必须属于声明 scope。Figma scope 外内容不得扩大 Checklist。
