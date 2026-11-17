# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-17

First public release, on npm as `themis-spec`.

### Added

- Spec format version `0.1` (`SPEC_FORMAT.md`): a `spec.md` with decisions and acceptance
  criteria, validated with stable diagnostic codes.
- `themis new` and `themis check`: write a spec skeleton and validate a spec.
- `themis init`: scaffold a project and generate `.themis/` and the agent protections.
- `themis plan` and `themis approve plan` (gate 1): planner agent with a checked task graph.
- `themis tests` and `themis approve tests` (gate 2): test-author agent and a locked contract
  in `.themis/lock.json`.
- `themis run`: one git worktree per task, verifier and reviewer on every iteration, parallel
  tasks up to `limits.parallel`, resumable state, `local` and `lima` executors.
- `themis status`: read-only report of gates, tasks, iterations and cost.
- `themis retro` and `themis approve retro` (gate 3): evidence-based proposals to improve the
  agent instructions.
- Shared exit code convention: `0` success, `1` fixable, `2` broken environment or invocation.

[0.1.0]: https://github.com/AlbertoBarrago/themis/releases/tag/v0.1.0
