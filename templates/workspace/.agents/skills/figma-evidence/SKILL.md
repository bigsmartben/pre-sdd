---
name: figma-evidence
description: 从 Ready Visual Spec Checklist 与 Figma locator/scope 采集真实设计事实，导出并验证 Figma Coverage、Evidence 与正式 Assets。Use when binding visual specs to Figma, exporting design evidence, checking Figma freshness, authorizing visual delivery, or diagnosing visual-source gaps.
---

# Figma Evidence

## 公开契约

公开输入只有 Ready 的 `.psp/visual-spec/checklist.json` 与明确的 Figma locator/scope；输出是：

- `.psp/visual-spec/figma-coverage.json`
- `.psp/visual-spec/figma-evidence.json`
- 正式 Asset 文件（由 Skill 从 Figma 导出，并由 Evidence 以内容摘要和 usage refs 引用）

把 `Intake → Bind → Export → Validate` 作为唯一主流程。不要询问用户提供 capture、revision、digest、Asset 文件或 Intake Checklist。

例如 Checklist 项 `VSI-FDBI-004-STATE-01` 可以绑定 Figma 节点 `12:34` 的 loading Variant；如果属性无法读取，输出结构化 `missing` Gap，不能根据图层名称猜测，也不能把问题伪装成 Flutter 缺陷。

## 主编排

1. 读取 Ready Checklist；缺失、非 `ready` 或有 Gap 时返回 `BLOCKED`。
2. 从用户给出的 locator 解析 file/page/node scope。通过 Figma 连接器读取该 scope 的当前原始响应、revision、节点属性、Token 与 Motion；连接器不可用或权限不足时返回 `BLOCKED`。
3. 把原始 scope 响应原样放入 `source.payload`，把每个绑定节点的原始响应放入 `source.nodes[].payload`。不要生成或接受任何 digest。
4. 将 Checklist 项逐项绑定到明确节点。让 `target.kind` 与 `anchor.role` 一一对应；不可读取的属性写成 `missing`，不要猜测。
5. 用 Figma 连接器把所需 Asset 导出到操作系统临时目录。在私有 Intake 中记录临时 `sourcePath` 与正式仓库 `path`；不要要求正式文件预先存在。
6. 按 `schemas/private/figma-intake.schema.json` 在操作系统临时目录生成私有 Intake。不要把它登记到 Registry、写入仓库或展示为用户输入。
7. 运行 `node .agents/skills/figma-evidence/scripts/finalize.mjs --intake <临时路径>`。让脚本计算 source/node/Asset digest，并原子提交 Coverage、Evidence 与 Assets。
8. 立即重新读取同一 Figma scope，生成只含当前 `source`、空 `items/assets/tokens/motions` 的私有 Intake；运行 `node .agents/skills/figma-evidence/scripts/validate.mjs --figma-freshness <临时路径>`。
9. 运行 Ready Authorization 或 Flutter 门禁时，先重新执行步骤 8，并通过 `PSP_FIGMA_FRESHNESS_PATH=<临时路径>` 传给下游。门禁结束后删除临时文件。

## 证据闭包

- Source 明确记录 `figma://` locator、file/page/node scope、revision、digest 与 capturedAt。
- Coverage 逐项记录 node、state、variant、viewport 与属性证据；node scope 外锚点会被拒绝。
- Evidence 记录 source revision/digest、Asset、Token 和 Motion 内容寻址闭包。
- Figma 多出的内容不得创建 Checklist 项。
- Checklist 或 Figma source 改变后，关联证据为 `stale`。
- `assets[].nodeId`、`tokens[].sourceNodeId` 与 `motions[].sourceNodeId` 必须位于声明的 node scope 内。
- source digest、node digest 和 Asset digest 必须由脚本根据采集 payload 或导出字节计算；无法读取 Figma 或无法导出 Asset 时返回结构化 Gap 与 `BLOCKED`。

## 硬边界

本 Skill 不修改 Checklist，不创建业务目标，不读取 Flutter consumer，不写 Flutter Coverage/Preview/Manifest，也不包含人工签署门。拒绝 `--capture`、自声明 revision/digest、旧 Packet、writeback 或视觉映射输入，并返回 `LEGACY_VISUAL_WORKFLOW_FORBIDDEN`。
