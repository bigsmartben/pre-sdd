---
name: repair-lit-ui
description: Repair an existing Lit UI implementation without changing confirmed Mapping or weakening delivery isolation.
---

# Repair Lit UI

Repair only the implementation defect authorized by the user. Preserve the confirmed Mapping, UC facts, Port contract, product/review build split, and product hash boundary. A Repair session never refreshes a hidden projection and never changes confirmation.

After repair, rerun the failing check plus `validate:lit-ui` and `validate:uihtml`. If a source or Mapping decision must change, return to `$lit-ui-workflow` and require reconfirmation.
