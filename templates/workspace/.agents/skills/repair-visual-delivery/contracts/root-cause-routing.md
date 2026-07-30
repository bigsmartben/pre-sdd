# Root Cause Routing

| Category | 唯一权威示例 | 失效下游 |
| --- | --- | --- |
| SCHEMA | `.agents/skills/visual-spec/schemas/` | Checklist → Figma → Ready → L1；Checklist → Path Plan → Mock → L2；随后 Delivery → UIHTML |
| CHECKLIST_BASELINE | `01-product-design/.psp/models/functional-delivery-baseline.json` | Checklist → Figma → Ready → L1；Checklist → Path Plan → Mock → L2；随后 Delivery → UIHTML |
| FIGMA_SOURCE | `figma://<file>/<node>` | Figma → Ready → L1 → L2 → Delivery → UIHTML |
| FIGMA_BINDING | `.psp/visual-spec/figma-coverage.json` | Figma → Ready → L1 → L2 → Delivery → UIHTML |
| LIT_L1 | `src/ui/` | L1 → L2 → Delivery → UIHTML |
| MOCK_ADAPTER | `MockCase/` 或 `src/testing/` | L2 → Delivery → UIHTML |
| LIT_L2 | `src/ui/` | L2 → Delivery → UIHTML |
| REVIEW_TOOL | `src/review/` | Delivery |

Delivery/Marker 不直接补丁权威源。任何只改下游报告而没有修正上述最早来源的处理都不得进入 `resolved`。
