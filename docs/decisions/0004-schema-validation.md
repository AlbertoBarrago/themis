# 0004. Schema validation: `zod`

Status: accepted (2026-10-06)

## Context

The frontmatter schema is small but has defaults, enums, ranges and nested strict objects,
and later commands (`tasks.json`, `state.json`, `lock.json`) will need validation too.

## Decision

Use `zod` v4. Issues carry a path, which is resolved against the YAML document to obtain a
position. Messages are rewritten by Themis (`describeIssue`) so that they are stable and
short, independent of zod's default wording. Unknown top-level keys are detected by hand to
allow the `x-` extension prefix; nested objects use `strictObject`.

## Consequences

- One runtime dependency (no transitive dependencies), reused for every Themis JSON file.
- Types are inferred from the schema, avoiding a second, hand-written type that could drift.
