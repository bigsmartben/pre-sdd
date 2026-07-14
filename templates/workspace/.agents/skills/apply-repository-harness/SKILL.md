---
name: apply-repository-harness
description: Resolve repository changes through the project-bound Harness manifest, run every returned validation command, and report manifest-shaped gate evidence. Use when Codex implements or reviews repository changes, checks readiness, selects required validation, or prepares a completion handoff.
---

# Apply Repository Harness

## Workflow

1. Read the applicable AGENTS.md chain, then read psp.project.yaml, `.psp/harness/HARNESS.md` and the manifest bound by the project file.
2. Preserve unrelated user changes and collect every intended repository-relative path in POSIX form.
3. Run:

       node .psp/harness/scripts/resolve-validation.mjs --path <path>... --intent change|readiness --json

   Use `readiness` only when claiming ready, consumable, deliverable, or formal handoff status.
4. Stop target writes when the resolver returns `BLOCKED`. Report its cataloged blockers; do not infer another Scope or Profile.
5. For explicit pure-workspace initialization, use the manifest-bound workspace operation: run `npm run init:workspace -- --dry-run`, review every bound stage root, then run `npm run init:workspace`. This operation may create only workspace markers and must leave every available stage `uninitialized`.
6. When the bound stage is `uninitialized`, do not create user artifacts unless the user explicitly starts that stage. Use the manifest-bound stage operation: run its `--dry-run` form, review every target and upstream readiness result, then run the operation without `--dry-run`. Product design uses `npm run init:product`; architecture design uses `npm run init:architecture` and requires the product strict Profile first.
7. Implement only the requested change. Never initialize a downstream stage to compensate for an unready upstream stage. Collect actual changed paths and resolve them again before verification.
8. Run every returned `commands` entry in order. Keep `FAIL`, `BLOCKED`, and `NOT_RUN` distinct from `PASS`.
9. Read `handoff.requiredFields` and `handoff.validationStates` from the manifest and use them for the final report.

## Evidence

- Report each exact command with its validation state.
- For failure, include the stable blocker code and shortest reproducible output.
- Never describe structure-only validation as delivery readiness.
