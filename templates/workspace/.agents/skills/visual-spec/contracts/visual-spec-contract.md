# psp.dev/visual-spec/v1

Visual Spec（视觉规格）只回答“视觉要求如何表达”。正式 Checklist（清单）路径是 `.psp/visual-spec/checklist.json`，Artifact ID 固定为 `VISUAL-SPEC-CHECKLIST`。

## 身份与源锁

- `metadata.revision` 是大于等于 1 的整数；任何 Checklist 落盘字节变化前递增。
- `sourceLocks[]` 保存 `artifactId + path + revision + digest`。
- `digest` 是工具对源文件精确 UTF-8 字节计算的 `sha256:<64 位小写十六进制>`。
- `VISUAL` 清单锁定 Product Use Cases 与 Functional Delivery Baseline。
- 存在 `USER_PATH` 项时还必须锁定 Test Case Catalog。

## 稳定项

`itemId` 为 `VSI-<baselineItemId>-<KIND>-##`。编号只在同一个 `baselineItemId + KIND` 内按 `sourceRef`、名称和来源引用稳定排序。

例如同一 `FDBI-004` 下，结算页是 `VSI-FDBI-004-PAGE-01`，提交按钮是 `VSI-FDBI-004-COMPONENT-01`；新增 `FDBI-002` 不会改变这些 ID。

## 层级

- `VISUAL`：必须实现 Page/Component、State、Variant、Viewport、Token、Asset 和适用 Motion。
- `USER_PATH`：包含 `VISUAL`，并绑定至少一个 `TC-###`。

## 状态与失效

Checklist 状态为 `draft | ready | stale`。任一直接源 revision 或实际字节 digest 改变后，相关项和所有下游证据为 `stale`。Validator 只判断结构、引用、闭包与新鲜度；人工视觉判断不属于机器 Ready。

Ready Authorization（就绪授权）只允许 `ready | stale`：Checklist 或 Figma Coverage/Evidence 变化后立即变为 `stale`，重新运行分布式 Validator 并锁定当前字节后才能恢复为 `ready`。
