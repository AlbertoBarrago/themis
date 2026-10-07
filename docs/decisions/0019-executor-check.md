# 0019. Executors check they can run before a command starts

Status: accepted (2026-10-07)

## Context

With `--executor lima`, a stopped or still-booting VM surfaced as the failure of whatever ran
first, for example `themis init: npm install exited with 255` followed by
`ssh: connect to host 127.0.0.1 port 58153: Connection refused`. Nothing pointed at the VM or
at `limactl start`.

## Decision

`Executor` gets an optional `check(cwd)` that returns why commands cannot run, with the remedy,
or `undefined`. `themis init` and `themis run` call it once, after validating their arguments
and before any work; a problem is printed as is and exits `2`.

`LimaExecutor.check` runs `limactl list --format {{.Status}} <instance>`, then a no-op `true`
through `limactl shell` (the same path as real commands, since a VM reported as running can
still refuse SSH while it boots). Each step has a 30 s timeout. Messages:

- `limactl` missing: install Lima, then `scripts/lima/create-vm.sh`;
- instance missing: `scripts/lima/create-vm.sh`, or `THEMIS_LIMA_INSTANCE`;
- not running: `limactl start <instance>`;
- running but not answering: retry, or `limactl stop` then `start`, with the last line of the
  error (or "no answer within 30s").

The local executor has no check.

## Consequences

- Two extra `limactl` calls at the start of `init` and `run` with Lima (about a second).
- `plan`, `tests` and the gates run on the host and are unaffected.
