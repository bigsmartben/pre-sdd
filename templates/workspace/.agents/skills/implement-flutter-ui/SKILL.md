---
name: implement-flutter-ui
description: Implement a current Ready Visual Spec and Figma Evidence in the single Flutter lib/ui source, including all L1 Page/Widget/State/Variant/Viewport/Token/Asset/Motion work and optional L2 Route/Action/Event/Guard user paths. Use when creating or changing Flutter UI source from authorized Visual Spec inputs, initializing the owned Flutter workspace template, or checking implementation-source boundaries before flutter-ui coverage and preview work.
---

# Implement Flutter UI

## Check authorization first

Read only the Registry paths for `VISUAL-SPEC-READY-AUTHORIZATION`, current Checklist, `FIGMA-COVERAGE`, and `FIGMA-EVIDENCE`. Require `ready`, current revision/digest locks, and zero Gaps. Read `USER-PATH-PLAN` and `MOCK-SCENARIO-SUITE` only for Checklist items declared `USER_PATH`.

Run `node .agents/skills/implement-flutter-ui/scripts/validate-ready.mjs` before implementation. Stop on any blocker; do not guess missing visual or product facts.

## Implement one source

1. Initialize the owned Flutter skeleton only when `pubspec.yaml` and `lib/` do not exist: `node .agents/skills/implement-flutter-ui/scripts/initialize.mjs`.
2. Implement every Checklist item in `lib/ui/**` with stable route, Page, Widget identity, state, variant, viewport, content, token, asset, and applicable motion.
3. Keep service interfaces in `lib/adapters/contracts/**` and production implementations in `lib/adapters/real/**`.
4. Keep Review/Test adapters, fixtures, navigation, and markers in `lib/review/**` or `lib/testing/**`; import the real `lib/ui/**` Widget tree.
5. For `USER_PATH` only, implement Route/Action/Event/Guard in the same UI source and drive it with declared scenarios through Review/Test adapters.
6. Hand control to `$flutter-ui` for Coverage, Preview, Finding, acceptance, and Manifest operations. Do not make acceptance decisions here.

Example: implement `CheckoutPage` once in `lib/ui/pages/checkout_page.dart`; expose an `InventoryPort`; bind a real adapter in `lib/main.dart` and a fixture adapter in `lib/review/review_main.dart`.

Read [contracts/implementation.md](contracts/implementation.md) before changing boundaries. Never modify Checklist/Figma Evidence to fit code, copy a Preview Widget tree, let Mock facts become UI facts, or place Review/Test imports in production closure.
