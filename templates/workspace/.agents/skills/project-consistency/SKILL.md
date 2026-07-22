---
name: project-consistency
description: Activate this read-only project consistency Skill only for an explicit user request. The separately registered project-consistency Command may also run when a Handoff or strict CI/CD Profile schedules it; neither path grants modification authority.
---

# Project Consistency

## Invocation boundary

- Activate this Skill only after the user explicitly invokes `$project-consistency` or explicitly requests a project consistency inspection.
- Treat the Manifest command `project-consistency` as a separate execution entrypoint: Handoff and strict CI/CD Profiles may schedule that read-only Command without activating this Skill.
- Never activate the Skill or schedule the Command from hooks, file saves, ordinary `local-edit`, or inferred follow-up work.
- Never infer modification authority from a finding. This Skill reports facts and optional actions only.
- Never initialize a stage, render or synchronize an artifact, repair UI, run handoff, or advance a downstream node.

## Workflow

1. Read `psp.project.yaml`, the bound Harness Manifest, its `projectDag`, Artifact Contracts, and the Validator commands declared on DAG nodes.
2. For the full project, run:

       npm run check:project-consistency -- --json

   For one or more requested DAG Scopes, run:

       npm run check:project-consistency -- --scope <scope-id> --json

3. Treat only `dependency` edges as data relationships. Ignore `handoff` edges for closure and topological order, even when both edge types exist on the same node pair.
4. Report `dependencies`, `diagnostics`, `acceptedRisks`, and `suggestedOperations` from the shared Consistency Report Schema. Keep `changes` empty.
5. Validate the complete report against the registered Consistency Report Schema before returning it.
6. If a node is uninitialized or unavailable, report `NOT_RUN` or `BLOCKED` exactly as returned. Do not initialize it.
7. If upstream facts and UI implementation disagree, present both correction directions as optional actions. Do not select an authority for the user.

## Evidence

- Preserve the result's `scope`, `changes`, `validation`, and `residuals` fields.
- Validation states are only `PASS`, `FAIL`, `BLOCKED`, and `NOT_RUN`.
- A `PASS` result means the selected read-only inspection found no inconsistency; it is not readiness or handoff authorization.
- A `BLOCKED` result is evidence for a separate user decision, not permission to edit.
