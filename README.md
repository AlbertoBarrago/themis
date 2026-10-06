# Ordito

An open format and a reference CLI for spec-driven agentic development with a verification
loop.

In weaving, the *ordito* (warp) is the set of fixed threads on the loom and the *trama*
(weft) is what gets woven through them. In Ordito, humans own the warp: a `spec.md` with
decisions and acceptance criteria, plus locked acceptance tests that turn it into a contract.
Agents produce the weft: the code, iterated until a single objective verifier passes.

The point is not generating a plan. It is **guaranteeing convergence**: an immutable
contract, one verifier with semantic exit codes, guards against shortcuts, and a
retrospective loop that improves the agent configuration over time.

> Status: early development (milestone M0). The format is at version `0.1`.

## The format

[`SPEC_FORMAT.md`](SPEC_FORMAT.md) is the standard. It is meant to be useful without the CLI.
A complete example lives in [`examples/webhook-service/spec.md`](examples/webhook-service/spec.md).

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

## CLI

```sh
ordito check [spec.md] [--json]   # validate a spec, every error with line, column and field
```

Exit codes: `0` valid (warnings allowed), `1` invalid spec, `2` usage or I/O error.

Planned commands: `init`, `plan`, `approve plan`, `tests`, `approve tests`, `run`, `status`,
`retro`.

## Development

Requires Node.js 22 or later.

```sh
npm install
npm run check   # typecheck + lint (Biome) + tests (vitest)
npm run build
```

Design decisions are recorded in [`docs/decisions/`](docs/decisions/).
