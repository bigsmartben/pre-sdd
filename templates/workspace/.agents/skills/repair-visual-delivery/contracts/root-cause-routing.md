# Root Cause Routing

| Category | 唯一权威示例 | 失效下游 |
| --- | --- | --- |
| SCHEMA | `.agents/skills/visual-spec/schemas/` | Checklist → Figma → Ready → Flutter L1 → Optional L2 → Preview → Manifest |
| CHECKLIST_BASELINE | `01-product-design/.psp/models/functional-delivery-baseline.json` | Checklist → Figma → Ready → Flutter L1 → Optional L2 → Preview → Manifest |
| FIGMA_SOURCE | `figma://<file>/<node>` | Figma → Ready → Flutter L1 → Optional L2 → Preview → Manifest |
| FIGMA_BINDING | `.psp/visual-spec/figma-coverage.json` | Figma → Ready → Flutter L1 → Optional L2 → Preview → Manifest |
| FLUTTER_L1 | `lib/ui/` | Flutter L1 → Optional L2 → Preview → Manifest |
| MOCK_ADAPTER | `MockCase/` 或 `lib/testing/` | Flutter L2 → Preview → Manifest |
| FLUTTER_L2 | `lib/ui/` | Flutter L2 → Preview → Manifest |
| REVIEW_TOOL | `lib/review/` | Preview → Manifest |

Preview/Marker/Manifest 不直接补丁权威源。任何只改下游报告而没有修正上述最早来源的处理都不得进入 `resolved`。

`resolve` 不接受调用者自报 revision/digest：本地权威直接读取实际字节；JSON Artifact 同时读取实际 revision；`figma://` 权威绑定当前正式 `FIGMA-EVIDENCE` 的实际 revision/digest 作为可复核证据。
