---
name: project-consistency
description: Run a user-requested, read-only project consistency inspection across project DAG nodes and edges. Use only when the user explicitly invokes $project-consistency or explicitly asks for a project consistency report; never run from hooks, ordinary validation, file saves, or inferred follow-up work.
---

# Project Consistency

## Invocation boundary

- Run this Skill only after the user explicitly invokes `$project-consistency` or explicitly requests a project consistency inspection.
- Never infer modification authority from a finding. This Skill reports facts and optional actions only.
- Never initialize a stage, render or synchronize an artifact, repair UI, run handoff, or advance a downstream node.

## Workflow

1. Read `psp.project.yaml`, the bound Harness Manifest, its `projectDag`, Artifact Contracts, and the Validator commands declared on DAG nodes.
2. For the full project, run:

       npm run check:project-consistency -- --json

   For one or more requested DAG Scopes, run:

       npm run check:project-consistency -- --scope <scope-id> --json

3. Treat a requested Scope as the starting node. Inspect it and its downstream impact closure in DAG topological order; include incoming boundary edges as context.
4. Report the returned node results, edge results, concrete evidence, impact, and optional actions. Keep `changes` empty.
5. If a node is uninitialized or unavailable, report `NOT_RUN` or `BLOCKED` exactly as returned. Do not initialize it.
6. If upstream facts and UI implementation disagree, present both correction directions as optional actions. Do not select an authority for the user.

## Evidence

- Preserve the result's `scope`, `changes`, `validation`, and `residuals` fields.
- Validation states are only `PASS`, `FAIL`, `BLOCKED`, and `NOT_RUN`.
- A `PASS` result means the selected read-only inspection found no inconsistency; it is not readiness or handoff authorization.
- A `BLOCKED` result is evidence for a separate user decision, not permission to edit.

