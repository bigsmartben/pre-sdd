---
name: lit-ui-workflow
description: Clarify Figma and UC inputs into the single Mapping.html artifact and wait for exact user confirmation.
---

# Lit UI Workflow

This skill only orchestrates source reading, clarification, Mapping updates, and confirmation.

1. Read the accepted Figma Acquisition Packet and UC.
2. Treat Figma as visual/source authority and UC as business authority. Never infer a missing business branch from a visual label.
3. Initialize `Mapping.html` with exact Figma and UC versions and SHA-256 values.
4. Add perceptual concepts and bind each ambiguity to a stable `conceptId`.
5. Ask the user, update incrementally, and repeat while any `gap` or open question remains.
6. Ask the user to confirm the exact Mapping. Confirmation must use `user:<identity>`.
7. Run `authorize-implementation`. Do not start Lit implementation unless it returns `PASS`.

The structure and decisions are defined by the Lit UI contracts and validator, not duplicated here. Never create `Preview.html`, mapping JSON, a public code plan, or source-code details in Mapping.
