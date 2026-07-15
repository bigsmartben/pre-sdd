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
5. 当 resolver 返回 `upstreamScopes` 时，先执行其 `upstreamCommands`。任何 FAIL、BLOCKED 或 NOT_RUN 都禁止生成下游事实，只报告对应上游缺口。
6. For explicit pure-workspace initialization, use the manifest-bound workspace operation: run `npm run init:workspace -- --dry-run`, review every bound stage root, then run `npm run init:workspace`. This operation may create only workspace markers and must leave every available stage `uninitialized`.
7. When the bound stage is `uninitialized`, do not create user artifacts unless the user explicitly starts that stage. Resolve the stage operation from the Manifest, run its `--dry-run` form, review every target and upstream readiness result, then run the same registered operation without `--dry-run`. Do not hardcode a domain command, Profile, template, or upstream rule in this Skill.
8. Implement only the artifact or area explicitly requested by the user. Never fill a downstream artifact to compensate for an unready upstream dependency. Collect actual changed paths and resolve them again before verification.
9. Run every returned validation command in order. Read `evidenceReport.requiredFields` and `evidenceReport.validationStates` from the manifest and use them for the technical report.
10. When all readiness commands pass, execute `npm run handoff -- --from <source-scope> --to <consumer-scope> --json`. Only a fresh `PASS` receipt authorizes a conversational handoff. Include the current artifact, consumer, and an explicit example of the user request that would start the next task, then end without starting it.

## Evidence

- Report each exact command with its validation state.
- For failure, include the stable blocker code and shortest reproducible output.
- Never describe structure-only validation as delivery readiness.
- Keep the Harness evidence report and non-persistent handoff receipt separate from the conversational handoff. Harness evidence contains only Scope, Changes, Validation, and Residuals.
