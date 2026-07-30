---
name: implement-lit-ui
description: Implement an exactly confirmed Mapping.html as native Lit and TypeScript modules.
---

# Implement Lit UI

Before editing, run the Lit UI workflow authorization check. If it reports `LIT_IMPLEMENTATION_NOT_AUTHORIZED`, stop.

Implement confirmed concepts directly under `src/ui/`. Do not generate a central UI table. Routes select Pages; Pages compose Components; Components emit typed events; Ports own host/service boundaries; Motion owns visual feedback only. Compose a real adapter at the product entry and keep Mock adapters outside the production graph.

Build and validate both the direct product entry and the independent Review entry. Product delivery is only `UIHTML/`.
