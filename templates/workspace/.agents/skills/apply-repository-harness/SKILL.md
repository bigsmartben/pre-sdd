---
name: apply-repository-harness
description: Resolve generated-workspace changes through the local Harness Standard v3 project binding, execute the returned plan, and report gate evidence. Use for repository changes, validation planning, or a user-explicit Handoff preflight; never infer approval or advance downstream work.
---

# Apply Repository Harness v3

## Workflow

1. Read the applicable `AGENTS.md`, `psp.project.yaml`, `.psp/harness/HARNESS.md`, and the bound Manifest. Require `pre-sdd-harness/v3`.
2. Preserve unrelated changes and collect intended POSIX repository-relative paths.
3. For ordinary edits run:

       node .psp/harness/scripts/resolve-validation.mjs --path <path>... --context local-edit --json

4. Stop writes on `BLOCKED`; otherwise implement only the requested Artifact or Area. `local-edit` must not expand through Dependency or Handoff edges.
5. Initialize a workspace or stage only after the user explicitly requests that Operation. Use its `--dry-run` first and never chain readiness or Handoff.
6. Resolve all actual paths again and execute every `plan` item in order. Preserve `selectedBy`, `scopeExpansionPath`, cost, cache, timeout, duration, and `NOT_RUN` evidence.
7. Activate the `project-consistency` Skill only for an explicit user request. The separately registered read-only Command may run when a Handoff Profile or strict CI/CD Profile schedules it; never schedule it from hooks or ordinary `local-edit`.
8. When the user explicitly requests Handoff, run only preflight first:

       npm run handoff -- --from <source> --to <consumer> --json

   Show validation, risks, hashes, and the token, then stop. Confirm only after a new explicit user decision by passing `--confirm --actor <identity> --preflight-token <token>` and one `--accept-risk <code>` for every displayed risk. A valid Receipt still has `downstreamAction: NOT_RUN`.

## Evidence

- Validation states are only `PASS`, `FAIL`, `BLOCKED`, and `NOT_RUN`.
- Keep validation, user decision, and Receipt status separate.
- Never treat structure PASS, risk acceptance, or Handoff as downstream execution or release authorization.
