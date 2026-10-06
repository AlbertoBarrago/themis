# 0003. YAML parser: `yaml`

Status: accepted (2026-10-06)

## Context

Frontmatter errors must report line, column and field. Common frontmatter helpers
(gray-matter, front-matter) return plain objects and lose source positions. `js-yaml` reports
positions only for syntax errors, not for individual values.

## Decision

Use `yaml` (eemeli/yaml): zero dependencies, YAML 1.2, and a document model where every node
keeps its source range. A `LineCounter` maps ranges to line and column. Frontmatter
delimiters are split by hand: no frontmatter library.

## Consequences

- Schema errors can point at the exact value, and unknown keys at the exact key.
- The raw source of `themis:` is read from the node range, so `0.10` is not mistaken for
  `0.1`.
- Duplicate keys are rejected by the parser (`uniqueKeys` default).
