# Flutter UI Implementation Contract

## Inputs

Accept only current Registry-bound `VISUAL-SPEC-READY-AUTHORIZATION`, `VISUAL-SPEC-CHECKLIST`, `FIGMA-COVERAGE`, and `FIGMA-EVIDENCE`. Add `USER-PATH-PLAN` and `MOCK-SCENARIO-SUITE` only when the Checklist declares `USER_PATH`.

## Output and authority

Write UI semantics only under `lib/ui/**`. Keep adapter interfaces in `lib/adapters/contracts/**`, real implementations in `lib/adapters/real/**`, Preview tooling in `lib/review/**`, test adapters in `lib/testing/**`, and the production entrypoint in `lib/main.dart`.

The operation may initialize these paths from `templates/flutter-workspace/` in a future generated workspace. It must fail on existing targets rather than overwrite user files.

## Isolation

Production imports must not reference `lib/review`, `lib/testing`, `MockCase`, `.psp`, screenshots, Figma locators, or Review Findings. Review and Test code must instantiate the production UI instead of copying it.

## Conformance matrix

| Scenario | Expected |
|---|---|
| Ready Visual/Figma sources, L1-only | implement `lib/ui/**` |
| Ready sources with `USER_PATH` | implement L1 then L2 in the same UI |
| Missing/stale authorization or Figma lock | `FLUTTER_IMPLEMENTATION_NOT_READY` |
| Missing required User Path/Mock input | `FLUTTER_IMPLEMENTATION_NOT_READY` |
| Existing Flutter target during initialization | `FLUTTER_INITIALIZE_CONFLICT` |
| Review/Test/Mock import in production | `FLUTTER_SOURCE_LEAK` |
| Lit/UIHTML request or input | `FLUTTER_LEGACY_INPUT_FORBIDDEN` |
