# Review guide: Themis

Check only the rules whose trigger matches a path in the diff. For each finding, name the rule (R1, R2, ...) or say "outside REVIEW.md" when it is a bug no rule covers. Report real defects with a concrete failure scenario; skip anything listed under "Do not flag".

This file is read from the base branch. Change it in its own commit, never together with the code it judges.

## Rules

### R1: The spec format stays normative
Trigger: `src/spec/**`, `SPEC_FORMAT.md`
Check: any change in what the parser accepts, rejects or reports is mirrored in `SPEC_FORMAT.md` in the same diff; a new or renamed `DiagnosticCode` in `src/spec/diagnostics.ts` appears in the diagnostic table of section 7, and vice versa.
Why: `SPEC_FORMAT.md` must stay usable without the CLI; drift silently breaks other implementations (source: CLAUDE.md).

### R2: Verifier exit codes keep their meaning
Trigger: `templates/node-ts/verify.sh`, `templates/node-ts/guard.mjs`, `src/cli/**`, `src/run/**`
Check: exit `1` only for a problem the agent can fix in code or input; exit `2` for usage, environment or internal problems (corrupt lock, git unavailable, and any tool that never got to judge the code: missing, installed but not starting, built for another platform, killed by a signal, missing a plugin). A new failure path picks the right one and is covered by `tests/stack/`.
Why: a tool that could not start was reported as exit 1, so agents tried to fix code for an environment problem (fixes: dbcf6c2; source: ADR 0007, ADR 0018).

### R3: The locked contract cannot be bypassed
Trigger: `templates/node-ts/guard.mjs`, `src/acceptance/**`, `src/init/**`, `src/adapters/claude-code/**`
Check: protected paths (lock, acceptance tests, spec, verifier) stay in both the guard digest and the agent deny rules; the forbidden-marker list stays identical in `guard.mjs` and `src/acceptance/validate.ts`; agent protections are still passed on every call as inline `--settings` with `./`-prefixed rules.
Why: inline `Edit(/x)` rules are not enforced, and any gap lets an agent edit the tests that judge it (source: ADR 0007, ADR 0009, ADR 0011).

### R4: Agent output is never trusted
Trigger: `src/plan/**`, `src/acceptance/**`, `src/agents/**`
Check: everything an agent returns (plan graph, test files, paths) goes through validation before it is written or reaches the human gate: relative paths under the allowed folder, no `..`, size limits, known criteria only. Themis writes the files, never the agent.
Why: a malformed or hostile agent response must not write outside the project or skip the gate (source: ADR 0011, CLAUDE.md).

### R5: Claude Code stays behind the adapter
Trigger: `src/**` outside `src/adapters/`
Check: no import from `src/adapters/claude-code`, no `claude` CLI flags or `.claude/` paths; agent work goes through `AgentRunner` and the registry. Process execution goes through `Executor`, never `child_process` directly.
Why: the core must stay agent-neutral and testable with `FakeAgentRunner` and `FakeExecutor` (source: ADR 0006, CLAUDE.md).

### R6: The CLI never calls an LLM API
Trigger: `package.json`, `src/**`
Check: no HTTP client or SDK for model providers; agents run only as CLI subprocesses through `AgentRunner`.
Why: design constraint of the project (source: CLAUDE.md).

### R7: New runtime dependencies need an ADR
Trigger: `package.json`, `package-lock.json`
Check: a new entry under `dependencies` comes with a new ADR in `docs/decisions/` in the same diff. `devDependencies` are exempt.
Why: every runtime dependency ships to users of `themis-spec` (source: CLAUDE.md, ADR 0001 to 0005).

### R8: Optional fields are built, not assigned undefined
Trigger: `src/**/*.ts`
Check: with `exactOptionalPropertyTypes`, optional properties are added conditionally (`...(x ? { key: x } : {})`), never set to `undefined`; casts that hide it (`as`, `!`) are a finding.
Why: tsc accepts some casts that later break JSON output and equality checks (source: CLAUDE.md).

### R9: Git and state writes stay serialised
Trigger: `src/run/**`, `src/git/**`
Check: operations on the main tree go through `#withMain`, state writes through `#save`; no direct `git` call or `state.json` write from parallel task code. Themis never commits user changes it did not make.
Why: parallel tasks race on the main tree and on state otherwise (source: ADR 0014).

### R10: Generated files respect the user's edits
Trigger: `src/init/**`, `src/fs/**`, `templates/**`
Check: generated files are written through `writeGenerated`: identical content left alone, different content skipped unless `--force`; validation happens before the first write.
Why: `init` must never overwrite a user's edit or leave a half-initialised project (source: CLAUDE.md).

## Do not flag

- Formatting, import order and lint-level style: Biome enforces them (`npm run check`).
- Missing CommonMark features in `src/spec/body.ts`: the line-based parser is deliberately minimal (source: CLAUDE.md).
- `depends: null` versus `depends: []`: they mean different things on purpose (source: CLAUDE.md).
- No CLI library: arguments are parsed with `node:util` `parseArgs` by choice (source: ADR 0002).
