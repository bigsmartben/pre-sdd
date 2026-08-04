---
name: flutter-ui
description: Validate and operate the Flutter UI specification chain from FLUTTER-VISUAL-COVERAGE through optional FLUTTER-USER-PATH-COVERAGE, explicit-target FLUTTER-UI-PREVIEW acceptance, REVIEW-FINDINGS, and the final UI-SPEC-MANIFEST. Use for Flutter L1/L2 coverage, Android/iOS/Web preview builds, preview findings or acceptance, source-closure freshness, stale propagation, and final UI Spec manifest generation.
---

# Flutter UI

## Keep one authority

Treat accepted `lib/ui/**` as the only UI semantic source of truth (SSOT). Let Review, Test, Preview, and Production replace adapters, fixtures, navigation, or finding markers only. Never copy the Widget tree into a second preview implementation or into `UI-SPEC-MANIFEST`.

Example: keep the checkout page in `lib/ui/pages/checkout_page.dart`; let `lib/review/` inject a fake inventory adapter without recreating `CheckoutPage`.

## Follow the only flow

1. Require current `VISUAL-SPEC-READY-AUTHORIZATION`, `FIGMA-COVERAGE`, and `FIGMA-EVIDENCE`.
2. Require accepted `FLUTTER-VISUAL-COVERAGE` for every Checklist item.
3. Require accepted `FLUTTER-USER-PATH-COVERAGE` only when the Checklist contains `USER_PATH`.
4. Build one real Preview with an explicit `target=android|ios|web`.
5. Record and close Review Findings against that target, Widget, state, source digest, and build digest.
6. Record human acceptance for the selected target.
7. Generate accepted `UI-SPEC-MANIFEST` only after all locks and closure checks pass.

Run only the operation the user requested. Do not infer a target, accept a preview, switch targets, publish, or advance another lifecycle automatically.

## Use the owned operations

- Validate structure or freshness: `node .agents/skills/flutter-ui/scripts/validate.mjs --phase coverage|preview|manifest`.
- Build a Preview: `node .agents/skills/flutter-ui/scripts/build-preview.mjs --target android|ios|web --commit <git-head>`.
- Open a built Preview: `node .agents/skills/flutter-ui/scripts/open-preview.mjs --target android|ios|web [--device <explicit-device-id>]`; require `--device` for Android/iOS and use the declared Web runtime for Web.
- Accept the selected Preview: `node .agents/skills/flutter-ui/scripts/accept-preview.mjs --accepted-by <person> --accepted-at <iso-time>`.
- Record a Finding: `node .agents/skills/flutter-ui/scripts/mark-finding.mjs ...`.
- Generate the terminal Manifest: `node .agents/skills/flutter-ui/scripts/generate-manifest.mjs`.

Read [contracts/flutter-ui.md](contracts/flutter-ui.md) before changing an Artifact or operation. Validate every candidate against its Schema. Return stable blocker codes and fail closed on missing inputs, unknown fields, invalid references, digest drift, open Blocker/Major findings, unaccepted Preview, leaked Review/Test code, or unavailable SDK.

## Enforce boundaries

- Include tracked Dart source, `pubspec.yaml`, `pubspec.lock`, Flutter SDK constraints, every tracked Android/iOS/Web production configuration file, and declared local Asset/Font/Token/Motion files in the source closure.
- Confirm the closure is clean against the declared Git HEAD both before and after `flutter pub get/analyze/test/build`; generated commands must not silently rewrite committed inputs.
- Reject Review/Test/Mock files from the accepted production source closure.
- Mark Coverage, Preview, acceptance, and Manifest stale when any locked byte changes.
- Bind acceptance to the selected target, current source digest, and current Preview build digest.
- Open only the target recorded by the current Preview. Never infer a mobile device from installed simulators, attached hardware, or prior runs. `android-emulator-fixed` accepts only an explicitly named Android Emulator; `web-chrome-fixed` launches Chrome rather than the system default browser.
- Accept normal Flutter platform adaptation; do not require cross-target pixel parity or repeated visual acceptance.
- Reject Lit, Vite, DOM, HTML Review, and UIHTML as formal inputs with `FLUTTER_LEGACY_INPUT_FORBIDDEN`.

The final artifact is `.psp/ui-spec/manifest.json`. Do not append another handoff, UIHTML publication, or hidden preview after it.
