---
name: mockcase
description: Build an independent MockCase Suite from neutral Business and Component Cases without becoming product UI authority.
---

# MockCase

MockCase consumes `Cases/ui-cases.json` read-only. It owns Fixture（样例数据）、Mock Scenario（模拟场景）、candidate apply authorization（候选应用授权）、Review（评审）和 evidence（证据）。 It does not own UC, Mapping, Lit modules, product state, or UIHTML.

具体例子：Business Case 声明“提交订单走 SubmitOrderPort 并可能失败”；MockCase 可以为同一 Port 提供一个失败 Fixture，但不能直接把页面 DOM 改成失败态。

Workflow:

1. Analyze the current case digest and gaps without writing.
2. Prepare a candidate Suite whose scenarios cite Business Case IDs.
3. Apply only with the exact `APPLY_MOCKCASE_CANDIDATE` authorization.
4. Build Mock adapters only in a separate review/test composition.
5. Record user Review evidence separately. Never import MockCase from `src/ui/main.ts` or include it in UIHTML.
