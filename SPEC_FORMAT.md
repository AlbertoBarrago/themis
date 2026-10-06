# Ordito Spec Format, version 0.1

Status: draft. Version identifier: `0.1`.

This document defines the `spec.md` file format used by Ordito, together with the
contract that binds a spec to its acceptance tests and to its verifier. It is meant to be
useful on its own: a team can write specs, lock acceptance tests and run a verifier by hand,
following only this document, without the `ordito` CLI.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described
in RFC 2119.

## 1. Concepts

In weaving, the *warp* (Italian: *ordito*) is the set of fixed threads stretched on the loom;
the *weft* (*trama*) is what gets woven through them.

- **Warp, owned by humans.** The spec (decisions and acceptance criteria) and the locked
  acceptance tests that translate it into an executable contract. Agents read it and never
  change it.
- **Weft, produced by agents.** The implementation, iterated until the verifier passes.

Three human gates exist, and only three:

1. Approval of the plan derived from the spec.
2. Approval and locking of the acceptance tests.
3. Approval of configuration changes proposed by a retrospective.

Everything else is decided by the verifier.

## 2. File layout

A spec is a UTF-8 Markdown file, conventionally named `spec.md` and placed at the
repository root. A repository MAY hold several specs (for example `specs/<feature>.md`);
each one is self-contained.

A spec consists of, in order:

1. A YAML frontmatter block (section 3).
2. A Markdown body (section 4).

Line endings MAY be LF or CRLF. A leading byte order mark is ignored.

### 2.1 Minimal example

```markdown
---
ordito: 0.1
stack: node-ts
verify: [typecheck, lint, unit, acceptance]
---

# Greeting service

## Decisions
- `src/greet.ts` exports `greet(name: string): string`.

## AC-1 Greets by name
Depends: none
- Given the name "Ada"
- When greet is called
- Then it returns "Hello, Ada"
```

## 3. Frontmatter

The file MUST start with a line containing exactly `---`. The frontmatter ends at the next
line containing exactly `---`. Its content MUST be a YAML mapping.

| Field      | Required | Type                     | Default                                                    |
| ---------- | -------- | ------------------------ | ---------------------------------------------------------- |
| `ordito`   | yes      | version                  |                                                            |
| `stack`    | yes      | enum                     |                                                            |
| `verify`   | yes      | list of enum             |                                                            |
| `limits`   | no       | mapping                  | `{ max_iterations: 5, parallel: 3 }`                       |
| `models`   | no       | mapping                  | `{ planner: strong, worker: fast, reviewer: strong, retro: strong }` |

### 3.1 `ordito`

The format version. For this document it MUST be `0.1`. It MAY be written as a bare scalar
(`ordito: 0.1`) or a quoted string (`ordito: "0.1"`); tools MUST compare the literal source
text, so `0.10` is not `0.1`. Tools MUST reject versions they do not implement.

### 3.2 `stack`

The technology stack, which determines how the verifier runs each step. Version 0.1 defines
one value: `node-ts` (Node.js 22 or later, TypeScript, ESM, vitest).

### 3.3 `verify`

The verification steps enabled for this spec. A non-empty list of unique values from:

| Step         | Meaning                                                            |
| ------------ | ------------------------------------------------------------------ |
| `typecheck`  | Static type checking.                                              |
| `lint`       | Linting.                                                           |
| `unit`       | Unit tests (tests outside the acceptance directory).               |
| `infra`      | Starts the infrastructure the service needs (for example Docker Compose). |
| `migrate`    | Applies database migrations.                                       |
| `acceptance` | Acceptance tests. MUST be present.                                 |

The `guard` step (section 6.2) is always enabled and MUST NOT be listed. The order of the
list has no meaning: the verifier always runs steps in the order of section 6.1.

### 3.4 `limits`

| Key              | Type    | Range   | Default | Meaning                                              |
| ---------------- | ------- | ------- | ------- | ---------------------------------------------------- |
| `max_iterations` | integer | 1 to 50 | 5       | Verification attempts per acceptance criterion before it is marked failed. |
| `parallel`       | integer | 1 to 16 | 3       | Maximum number of criteria worked on concurrently.   |

Omitted keys take their default. Unknown keys are errors.

### 3.5 `models`

Abstract model tiers per agent role. Keys: `planner`, `worker`, `reviewer`, `retro`. Values:
`strong` or `fast`. Mapping a tier to a concrete model is the responsibility of the agent
adapter, not of the spec. Omitted keys take their default. Unknown keys are errors.

### 3.6 Extensions

Top-level keys starting with `x-` are reserved for extensions and MUST be ignored by tools
that do not understand them. Any other unknown top-level key is an error, so that typos are
caught early.

## 4. Body

The body is CommonMark. Only ATX headings (`#`, `##`) carry structure. Lines inside fenced
code blocks (fences of three or more backticks or tildes) are never interpreted as
structure.

### 4.1 Title

The body MUST contain exactly one level-1 heading, `# <name>`, before any level-2 heading.
It names the service or feature.

### 4.2 Sections

Each level-2 heading opens a section that extends to the next level-2 heading or the end of
the file. Level-3 and deeper headings are ordinary content of the enclosing section.

| Heading                | Meaning                                    |
| ---------------------- | ------------------------------------------ |
| `## Decisions`         | Design decisions (section 4.3). At most one. |
| `## AC-<n> <title>`    | An acceptance criterion (section 4.4).     |
| any other              | Free context for humans and agents. Tools MAY pass it to agents and MUST NOT interpret it. |

### 4.3 Decisions

Design choices made by a human. Agents MUST respect them and MUST NOT reopen them. Each
top-level list item (`- ` or `* `) is one decision; indented lines that follow it belong to
it. A spec SHOULD contain a `## Decisions` section with at least one decision.

Because acceptance tests are written and locked before any implementation exists, the
decisions SHOULD fix the **public interface** those tests rely on: module paths and exported
signatures, HTTP routes and payloads, environment variables, ports, and the infrastructure
and migration mechanism. Anything the tests touch and the decisions leave open is an
ambiguity the implementation may legitimately resolve differently.

### 4.4 Acceptance criteria

A heading of the form `## AC-<n> <title>` declares an acceptance criterion, where `<n>` is a
positive integer without leading zeros and `<title>` is non-empty text. The identifier is
`AC-<n>`. Identifiers MUST be unique; they need not be contiguous or ordered.

A level-2 heading that starts with `AC` but does not match this form is an error.

Each criterion is a node of the dependency graph and the unit of work for the agents.

Its section contains:

- **`Depends:` line (optional).** At most one, before the first list item:
  - `Depends: none` declares that the criterion has no dependencies.
  - `Depends: AC-1, AC-3` declares dependencies, comma separated.
  - Omitting the line leaves dependencies unspecified: a planner MAY infer them, subject to
    human approval of the plan. A planner MAY add dependencies but MUST NOT remove declared
    ones.

  Every referenced identifier MUST exist in the spec. A criterion MUST NOT depend on itself,
  and the graph MUST be acyclic.
- **Clauses (required).** At least one top-level list item. Clauses SHOULD follow the
  Given / When / Then style (with `And` / `But` continuations) and SHOULD include at least one
  `Then` clause stating an observable outcome.
- **Description (optional).** Any other text, kept as free context.

## 5. Binding to acceptance tests

For each criterion `AC-<n>` there is a group of acceptance tests whose names start with
`AC-<n>:` (identifier, colon). The colon is mandatory: it prevents `AC-1` from matching
`AC-10` when tests are filtered by name.

For the `node-ts` stack:

- Acceptance tests live under `tests/acceptance/`.
- Each criterion has a top-level `describe("AC-<n>: <title>", ...)` block.
- Tests for a single criterion are selected with the name pattern `^AC-<n>:`.
- Shared test support code (harness, global setup, fixtures) lives under
  `tests/acceptance/` too, and is therefore part of the contract.

Once approved, acceptance tests are **locked**: the SHA-256 digest of every file in the
contract is recorded, and any later change to them is a verification failure. The contract
covers, at minimum, every file under the acceptance directory, the spec itself, the verifier,
and the tool configuration that could weaken verification (type checker, linter and test
runner configuration).

## 6. Verification contract

A single verifier is the only judge of whether the implementation satisfies the spec. It
takes an optional criterion identifier as argument.

### 6.1 Steps

Steps run in order of increasing cost and stop at the first failure:

1. `guard` (always)
2. `typecheck`
3. `lint`
4. `unit`
5. `infra`
6. `migrate`
7. `acceptance` for the given criterion, if one was given
8. `acceptance` for all criteria (regression)

Steps not enabled in `verify` are skipped.

### 6.2 Guard

The guard step fails when:

- any locked file differs from its recorded digest, or is missing; or
- the changes made since the contract was locked introduce any of these markers in source
  or test files:

  - test focus and skip: `.only(`, `.skip(`, `.todo(`
  - type checker suppressions: `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `as any`
  - linter suppressions: `eslint-disable`, `biome-ignore`, `oxlint-disable`

### 6.3 Exit codes

| Code | Meaning                | Expected reaction                         |
| ---- | ---------------------- | ----------------------------------------- |
| `0`  | Pass.                  | The criterion is satisfied.               |
| `1`  | The code is wrong.     | The agent fixes the implementation and retries. |
| `2`  | The environment is broken. | The loop stops; a human must intervene. |

Exit code `2` covers failures the implementation cannot fix by itself: a missing tool or
dependency installation, infrastructure that cannot start (for example the container runtime
is not running), a missing or corrupt lock. Infrastructure definitions and migrations are
part of the implementation: a missing or invalid definition, or a failing migration, is exit
code `1`.

### 6.4 Failure log

On failure the verifier writes `.verify.log` containing only the failed step and the last
lines of its output, without ANSI escape sequences. Tests run without retries: a flaky test
is a failing test.

## 7. Diagnostics

Tools that validate a spec SHOULD report every problem found, each with a line, a column, a
stable code and, for frontmatter problems, the dotted field path (for example
`limits.parallel`). Errors make a spec invalid; warnings do not.

| Code                     | Severity | Meaning                                           |
| ------------------------ | -------- | ------------------------------------------------- |
| `frontmatter-missing`    | error    | The file does not start with `---`.               |
| `frontmatter-unclosed`   | error    | No closing `---`.                                 |
| `yaml-syntax`            | error    | The frontmatter is not valid YAML.                |
| `frontmatter-not-mapping`| error    | The frontmatter is not a YAML mapping.            |
| `unsupported-version`    | error    | `ordito` is not a version the tool implements.    |
| `unknown-field`          | error    | Unknown frontmatter key.                          |
| `invalid-field`          | error    | A frontmatter value is missing or has the wrong type or value. |
| `title-missing`          | error    | No level-1 heading.                               |
| `title-duplicate`        | error    | More than one level-1 heading.                    |
| `content-before-title`   | error    | A level-2 heading precedes the title.             |
| `decisions-duplicate`    | error    | More than one `## Decisions` section.             |
| `decisions-missing`      | warning  | No `## Decisions` section, or it has no items.    |
| `ac-heading-malformed`   | error    | A heading starts with `AC` but is not `AC-<n> <title>`. |
| `ac-duplicate`           | error    | Two criteria share an identifier.                 |
| `ac-no-clauses`          | error    | A criterion has no list items.                    |
| `ac-missing-then`        | warning  | A criterion has no `Then` clause.                 |
| `no-acceptance-criteria` | error    | The spec defines no criteria.                     |
| `depends-malformed`      | error    | The `Depends:` value is not `none` or a list of identifiers. |
| `depends-duplicate`      | error    | More than one `Depends:` line, or a repeated identifier. |
| `depends-misplaced`      | error    | `Depends:` appears after the first clause.        |
| `depends-unknown`        | error    | A dependency names a criterion that does not exist. |
| `depends-self`           | error    | A criterion depends on itself.                    |
| `depends-cycle`          | error    | The dependency graph has a cycle.                 |

## 8. Versioning

The `ordito` field identifies the format version. While the format is in `0.x`, a minor
version change MAY be incompatible. Tools MUST reject a spec whose version they do not
implement rather than guess.
