# 0010. `ordito plan`, `ordito approve plan` and `.ordito/tasks.json`

Status: accepted (2026-10-06)

## Decision

### Planner call

- Requires `ordito init` (`.ordito/agents/planner.md` must exist, else exit `2`) and a valid
  spec (else exit `1`).
- One planner call, model tier `models.planner`, **no tools**: the whole spec is in the prompt,
  and the output is constrained with a JSON schema generated from the zod schema
  (`z.toJSONSchema`, no extra dependency):
  `{ tasks: [{ id, title, scope, dependsOn, addedDependencies: [{ id, reason }] }], questions: [] }`.
- Ordito then validates the plan deterministically against the spec:
  - exactly one task per criterion, plus at most one task with id `setup`, nothing else;
  - every dependency declared with `Depends:` is kept;
  - `setup` may be added as a dependency of any task; criterion dependencies may be added only
    to criteria without a `Depends:` line; every added dependency appears in
    `addedDependencies` with a reason;
  - `setup` has no dependencies; the graph is acyclic.
- If validation fails, the errors are sent back to the planner, up to 3 attempts in total.
  Still invalid: exit `1`, nothing written (the usual fix is a clearer spec).

### `.ordito/tasks.json`

```json
{
  "ordito": "0.1",
  "spec": "spec.md",
  "specDigest": "<sha256 of the spec>",
  "status": "draft",
  "createdAt": "<ISO 8601>",
  "approvedAt": null,
  "tasks": [
    { "id": "setup", "title": "...", "scope": "...", "dependsOn": [], "addedDependencies": [] },
    { "id": "AC-1", "title": "...", "scope": "...", "dependsOn": ["setup"],
      "addedDependencies": [{ "id": "setup", "reason": "..." }] }
  ],
  "questions": []
}
```

Tasks are stored in topological order. The CLI prints a readable summary (order,
dependencies, added dependencies with reasons, open questions) for the human gate.

### Gate

- `ordito plan` refuses to replace an approved plan without `--force` (replanning resets the
  approval).
- `ordito approve plan` requires a draft whose `specDigest` matches the current spec (else
  exit `1`: "spec changed, re-run ordito plan"), sets `status: "approved"` and `approvedAt`.
  Open questions are printed as warnings but do not block: answering them is the human's call.
  Approving an approved plan is a no-op.

### Run log

Every agent call is logged to `.ordito/runs/plan/<timestamp>-<attempt>.json`: role, model
tier, duration, usage, cost, the structured output and the validation errors, if any.
