# 0009. Claude Code adapter: `claude -p` contract

Status: accepted (2026-10-06)

## Context

The bootstrap requires verifying `claude` flags and output with `claude --help` and test
calls before writing the adapter. Findings below were observed with Claude Code 2.1.290 on
2026-10-06.

## Observed behavior

- `claude -p --output-format json` prints one JSON object. Relevant fields: `type: "result"`,
  `is_error`, `result` (final text), `structured_output` (present with `--json-schema`),
  `total_cost_usd`, `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`), `duration_ms`, `num_turns`, `session_id`,
  `permission_denials` (array of denied tool calls), `terminal_reason`.
- Errors (e.g. unknown model): exit code `1`, still a JSON object on stdout with
  `is_error: true`, a readable `result`, `api_error_status`, `terminal_reason: "api_error"`.
  `subtype` stays `"success"`, so it must not be used to detect failure.
- `--json-schema <schema>` makes the model return validated structured output in
  `structured_output`.
- The prompt can be passed on stdin (`echo ... | claude -p`), avoiding argv size limits.
- Model aliases `opus`, `sonnet`, `haiku` are accepted by `--model`.
- Deny rules, tested with `Edit(...)` on a file and `--permission-mode acceptEdits`:

  | Where                                      | Rule form          | Enforced |
  | ------------------------------------------ | ------------------ | -------- |
  | project `.claude/settings.json`            | `Edit(/note.txt)`  | yes (in a trusted directory; the docs say not in an untrusted one) |
  | `--settings '<inline json>'`               | `Edit(/note.txt)`  | **no**: the file was modified |
  | `--settings '<inline json>'`               | `Edit(./note.txt)` | yes      |
  | `--settings '<inline json>'`               | `Edit(//abs/path)` | yes      |
  | `--settings <file>`                        | `Edit(/note.txt)`  | yes (anchored to the file's directory) |
  | `--disallowedTools`                        | `Edit(./note.txt)` | yes      |

  Denied calls appear in `permission_denials`; the agent run itself still succeeds.

## Decision

- `ClaudeCodeRunner` implements `AgentRunner` by executing, through the `Executor`:
  `claude -p --output-format json --no-session-persistence --model <alias>
  --append-system-prompt <role instructions> --settings <inline json> [--tools ...]
  [--permission-mode ...] [--json-schema <schema>] [--max-budget-usd <n>]`, prompt on stdin,
  `cwd` = the project or worktree root.
- Protections are passed on **every** invocation with inline `--settings` and `./`-prefixed
  rules (relative to the agent's cwd, so they hold inside worktrees), never relying on project
  settings or workspace trust. The project `.claude/settings.json` from `init` remains, for
  interactive sessions.
- Failure = non-zero exit, unparsable stdout, or `is_error: true`. The `result` text is
  surfaced as the error message.
- Tiers map to aliases: `strong` = `opus`, `fast` = `sonnet`, overridable with
  `ORDITO_CLAUDE_MODEL_STRONG` / `ORDITO_CLAUDE_MODEL_FAST`.
- Usage recorded per call: duration, input/output/cache tokens, `total_cost_usd`, number of
  permission denials.

## Consequences

- The adapter depends on undocumented-but-observed JSON fields; parsing is defensive and a
  shape change yields an explicit adapter error, not a silent zero.
- Re-verify these findings when bumping the supported Claude Code version.
- Found in the first real `ordito plan` run: `claude -p` loads the user's global
  `~/.claude/CLAUDE.md`, so personal instructions (output language, "wait for confirmation
  before implementing", commit rules) reach Ordito's agents. Prompts therefore restate what
  must not be overridden (the planner prompt fixes English output). Before M4, find a way to
  isolate workers from user-level instructions, or document the requirement.
- Also found: `--json-schema` rejects schemas declaring `"$schema": ".../draft/2020-12/schema"`
  (what `z.toJSONSchema` emits), so the key is stripped before the call.
