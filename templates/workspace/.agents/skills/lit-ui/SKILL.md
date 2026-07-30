---
name: lit-ui
description: Build confirmed Mapping.html decisions as real Lit modules and deliver isolated UIHTML.
---

# Lit UI

Use this skill for the project chain:

`Figma + UC → Mapping.html → user confirmation → Lit UI Spec → UIHTML`

## Authorities

- `contracts/framework.yaml` defines reusable LitSpec concepts and dependency rules.
- A project `Mapping.html` defines perceptual concepts, source interpretation, gaps, and the exact user confirmation.
- Real modules under `src/ui/{models,components,pages,routes,events,motions,ports}` own implementation.
- `UIHTML/` is the standalone product delivery and never reads Mapping, Review Tools, Mock, or Cases.

There is no Preview Artifact, public code-plan Artifact, hidden mapping projection, or generic UI runtime IR.

## Workflow

1. Use `$lit-ui-workflow` until `authorize-implementation` returns `PASS`.
2. Copy only the engineering skeleton from `template/`; replace placeholders with project modules that implement the confirmed Mapping.
3. Keep Route URL ownership in `routes/`, rendering in `pages/`, reusable interaction in `components/`, business I/O in `ports/`, and typed communication in `events/`.
4. Inject real and Mock adapters at the composition boundary. Page and Component code must not inspect the environment.
5. Build the product and Review Tools with their separate Vite entries.
6. Run `validate:lit-ui`; strict validation auto-discovers the confirmed `01-product-design/Lit-UI/Mapping.html` and actual `UIHTML/` boundary.
7. Run `validate:uihtml`; it applies the delivery Schema, binds the current UIHTML hash, launches every declared Route in headless Chromium, and fails on missing assets or runtime errors.
8. Deliver only `UIHTML/` as the product bundle. Review output and Case data remain outside its hash boundary.

Review Tools use `ReviewDriver` to locate, observe, and dispatch against stable `conceptId` values. A tool failure must never prevent the product entry from loading.
