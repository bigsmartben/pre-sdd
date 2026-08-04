# Flutter UI Contract

## Artifact identities

| Artifact | Owner | Formal path | States |
|---|---|---|---|
| `FLUTTER-VISUAL-COVERAGE` | `flutter-ui` | `.psp/ui-spec/flutter-visual-coverage.json` | `draft → ready → stale` |
| `FLUTTER-USER-PATH-COVERAGE` | `flutter-ui` | `.psp/ui-spec/flutter-user-path-coverage.json` | `draft → ready → stale` |
| `FLUTTER-UI-PREVIEW` | `flutter-ui` | `.psp/ui-spec/preview-manifest.json` | `built → reviewing → accepted → stale` |
| `REVIEW-FINDINGS` | `flutter-ui` | `.psp/ui-spec/review-findings.json` | collection: `open → triaged → repairing → resolved → verified → closed` |
| `UI-SPEC-MANIFEST` | `flutter-ui` | `.psp/ui-spec/manifest.json` | `accepted → stale` |

All artifacts use `psp.dev/flutter-ui/v1`, deterministic JSON plus one trailing newline, and reject unknown fields.

## Authority and isolation

`lib/ui/**` owns UI meaning. `lib/adapters/contracts/**` may enter the source closure because UI imports its interfaces. `lib/adapters/real/**`, `lib/main.dart`, declared assets/fonts, `pubspec.yaml`, `pubspec.lock`, and every Git-tracked file under `android/**`, `ios/**`, and `web/**` complete production execution. `lib/review/**`, `lib/testing/**`, fixtures, screenshots, build output, machine-local generated platform files, and `.psp/**` never become accepted UI source. Recheck Git cleanliness after all Flutter commands so generated work cannot be attributed to an older commit.

## Freshness

Compute every digest from actual bytes. A changed upstream lock or source-closure file makes downstream artifacts stale in this order:

`FLUTTER-VISUAL-COVERAGE → optional FLUTTER-USER-PATH-COVERAGE → FLUTTER-UI-PREVIEW → REVIEW-FINDINGS context → UI-SPEC-MANIFEST`.

Changing the Preview target creates a new target-bound revision and build digest. Never reuse acceptance.

## Completeness and acceptance

Require all Checklist dimensions in L1 and all declared User Path steps in L2. Resolve every local Asset, Font, Token, and Motion reference to a declared closure file. Require `sourceCoverage=100`, `specCoverage=100`, `undeclaredInference=0`, `openBlockerMajor=0`, and `staleArtifacts=0` before Manifest generation.

Human acceptance is valid only when the selected target, source digest, Preview build digest, accepted person, and ISO time are present. A validator may verify these facts but must never create subjective acceptance.

L1 metadata and required L2 metadata must be `ready`; only their covered items/paths may be `accepted`. L1-only delivery forbids an extra L2 lock. Preview validation rejects `stale` metadata or acceptance, and target, runtime profile, and build path form one fixed tuple.

## Stable failures

| Code | Meaning |
|---|---|
| `FLUTTER_TARGET_REQUIRED` | No explicit supported target was provided. |
| `FLUTTER_DEVICE_REQUIRED` | Android/iOS Preview opening lacks an explicit device ID. |
| `FLUTTER_SDK_MISSING` | The requested target cannot run because Flutter or its platform SDK is unavailable. |
| `FLUTTER_SOURCE_CLOSURE_INCOMPLETE` | A declared source/dependency/asset/font/token/motion is absent or undeclared. |
| `FLUTTER_SOURCE_LEAK` | Review, Test, Mock, build, or evidence content entered the production closure. |
| `FLUTTER_SOURCE_DIGEST_STALE` | Actual source bytes differ from a lock. |
| `FLUTTER_COVERAGE_INCOMPLETE` | L1 or required L2 is missing, rejected, or stale. |
| `FLUTTER_PREVIEW_NOT_ACCEPTED` | The current selected-target Preview lacks valid human acceptance. |
| `FLUTTER_PREVIEW_STALE` | Target, source, adapter, coverage, or build bytes differ from the Preview lock. |
| `FLUTTER_FINDING_OPEN` | A Blocker or Major Finding is not closed. |
| `FLUTTER_MANIFEST_INCOMPLETE` | The final transitive closure or acceptance conditions are incomplete. |
| `FLUTTER_LEGACY_INPUT_FORBIDDEN` | A Lit/UIHTML-era input or field was supplied. |

## Conformance matrix

| Scenario | Expected |
|---|---|
| Ready L1-only → Android Preview → acceptance → Manifest | PASS |
| Ready L1 + required L2 → selected target → Manifest | PASS |
| Android/iOS/Web explicit target schema and routing | PASS |
| Missing target | `FLUTTER_TARGET_REQUIRED` |
| Missing Android/iOS device ID while opening | `FLUTTER_DEVICE_REQUIRED` |
| Missing target SDK | `FLUTTER_SDK_MISSING` |
| Source/Preview/Manifest digest drift | stale blocker |
| Unclosed Asset/Font/Token/Motion | `FLUTTER_SOURCE_CLOSURE_INCOMPLETE` |
| Mock/Review/Test path in production closure | `FLUTTER_SOURCE_LEAK` |
| Preview not accepted | `FLUTTER_PREVIEW_NOT_ACCEPTED` |
| Open Blocker/Major Finding | `FLUTTER_FINDING_OPEN` |
| Lit/UIHTML input | `FLUTTER_LEGACY_INPUT_FORBIDDEN` |
| Repair followed by regenerated coverage/preview/acceptance | PASS; old artifacts remain stale |
