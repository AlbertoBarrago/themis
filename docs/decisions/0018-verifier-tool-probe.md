# 0018. The verifier probes its tools before trusting their exit code

Status: accepted (2026-10-07)

## Context

The verifier maps a non-zero exit of `tsc`, `biome` or `vitest` to `1`, "the code is wrong",
and reserves `2` for a missing binary or a command that cannot be executed (126/127). A tool
that is installed but crashes on start exits `1` too: in a real run, `tsc` from TypeScript 7
could not find its native package (`node_modules` installed in the Lima VM, verifier on macOS)
and the crash was reported as a type error. The worker cannot fix that, so the task spent its
whole budget, at full cost, before failing.

## Decision

Before the first step that uses a tool, `verify.sh` runs `<tool> --version`. If it does not
exit `0`, the step fails with exit `2` and `.verify.log` names the probe, a message pointing at
the install (another platform, or a broken install) and the probe's output. Each tool is
probed once per verification, even when two steps use it (`vitest` for unit and acceptance).

Amended 2026-11-17: the same reasoning covers two more cases where the tool never judged the code.

- Infra probes the Compose plugin with `docker compose version` after `docker info` and before
  `docker compose config -q`. Without the plugin every `docker compose` call fails, and
  `config` would report it as an invalid compose file (`1`); the probe fails with `2` instead.
- A step whose command is killed by a signal (status above `128`, such as `137` from the OOM
  killer or `143` from `SIGTERM`) exits `2`, like a command that cannot be executed (`126`/`127`).
  A tool that crashes on its own without a signal still exits `1`: the verifier cannot tell it
  from a failing check.

## Consequences

- An environment problem in the tools blocks the task at the first iteration instead of
  failing it after `max_iterations`.
- Each verification starts three extra short processes (a fraction of a second in total).
- `verify.sh` is part of the locked contract. Existing projects keep the previous verifier
  until `themis init --force` regenerates it; since that changes its digest, the contract must
  then be locked again with `themis approve tests` (the tests themselves are unchanged).
