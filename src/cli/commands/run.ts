import { parseArgs } from "node:util";
import { TestsFileError } from "../../acceptance/acceptance.js";
import { availableAgents, DEFAULT_AGENT, runnerFor } from "../../adapters/registry.js";
import { GitError } from "../../git/git.js";
import { TasksFileError } from "../../plan/plan.js";
import { type RunEvent, run } from "../../run/run.js";
import { StateFileError } from "../../run/state.js";
import type { Executor } from "../../runtime/executor.js";
import { chooseExecutor, LocalConfigError, readLocalConfig } from "../../runtime/local-config.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { EXECUTORS, executorFor } from "../../runtime/select.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";

export const RUN_HELP = `Usage: themis run [task] [--executor local|lima] [--agent <name>] [--spec <path>]

Runs the task graph: each task works in its own git worktree, up to limits.parallel at once.
A worker edits the code, Themis runs .themis/verify.sh itself, a reviewer reads the diff, and
Themis merges into the current branch and verifies it again. With a task id, runs that task
only. State is saved after every step: interrupt with Ctrl-C and run again to resume.

Exit codes: 0 every task done, 1 a task failed, 2 a task is blocked or the setup is not ready.

Options:
  --executor <name>  Where agents and the verifier run: local or lima (VM from
                     scripts/lima/create-vm.sh; instance THEMIS_LIMA_INSTANCE or "themis").
                     Default: the one themis init recorded, else local; a different one is
                     refused, because node_modules holds native binaries for the recorded one
  --agent <name>     Agent adapter (default: ${DEFAULT_AGENT})
  --spec <path>      Spec file (default: spec.md)
  -h, --help
`;

export async function runCommand(
  args: string[],
  io: CliIo,
  host: Executor = new LocalExecutor(),
): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      executor: { type: "string" },
      agent: { type: "string", default: DEFAULT_AGENT },
      spec: { type: "string", default: "spec.md" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(RUN_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 1) {
    io.stderr(`themis run: expected at most one task id\n\n${RUN_HELP}`);
    return ExitCode.Usage;
  }
  let choice: ReturnType<typeof chooseExecutor>;
  try {
    choice = chooseExecutor(values.executor, await readLocalConfig(io.cwd));
  } catch (err) {
    if (!(err instanceof LocalConfigError)) throw err;
    io.stderr(`themis run: ${err.message}\n`);
    return ExitCode.Usage;
  }
  if (choice.kind === "conflict") {
    io.stderr(
      `themis run: this project was initialised with --executor ${choice.recorded}: node_modules holds native binaries for it, which do not run with ${choice.requested}.\n` +
        `Run without --executor (or with --executor ${choice.recorded}). To switch, remove node_modules (and .themis/worktrees/*/node_modules), then run themis init --executor ${choice.requested}.\n`,
    );
    return ExitCode.Usage;
  }
  const executor = executorFor(choice.name, host);
  if (executor === undefined) {
    io.stderr(
      `themis run: unknown executor "${choice.name}" (available: ${EXECUTORS.join(", ")})\n`,
    );
    return ExitCode.Usage;
  }
  const runner = runnerFor(values.agent, executor);
  if (runner === undefined) {
    io.stderr(
      `themis run: unknown agent "${values.agent}" (available: ${availableAgents().join(", ")})\n`,
    );
    return ExitCode.Usage;
  }
  const unavailable = await executor.check?.(io.cwd);
  if (unavailable !== undefined) {
    io.stderr(`themis run: ${unavailable}\n`);
    return ExitCode.Usage;
  }
  const specPath = values.spec.replaceAll("\\", "/").replace(/^\.\//, "");

  let outcome: Awaited<ReturnType<typeof run>>;
  try {
    outcome = await run({
      root: io.cwd,
      specPath,
      runner,
      executor,
      onEvent: (event) => io.stderr(formatEvent(event)),
      ...(positionals[0] === undefined ? {} : { task: positionals[0] }),
    });
  } catch (err) {
    if (
      err instanceof TasksFileError ||
      err instanceof TestsFileError ||
      err instanceof StateFileError ||
      err instanceof GitError
    ) {
      io.stderr(`themis run: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }

  const fail = (message: string, code: ExitCode) => {
    io.stderr(`themis run: ${message}\n`);
    return code;
  };
  switch (outcome.kind) {
    case "not-initialized":
    case "spec-unreadable":
    case "not-ready":
      return fail(outcome.message, ExitCode.Usage);
    case "git-not-ready":
      return fail(
        `${outcome.message}. Run:\n${outcome.commands.map((c) => `  ${c}\n`).join("")}`.trimEnd(),
        ExitCode.Usage,
      );
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic(specPath, d)}\n`);
      return fail(`${specPath} is invalid`, ExitCode.Invalid);
    case "unknown-task":
      return fail(`no task "${outcome.task}" in the approved plan`, ExitCode.Usage);
    case "already-done":
      io.stdout(`${outcome.task} is already done\n`);
      return ExitCode.Ok;
    case "dependencies-not-done":
      return fail(
        `${outcome.task} depends on ${outcome.missing.join(", ")}, not done yet`,
        ExitCode.Usage,
      );
    case "finished":
      break;
  }

  if (outcome.ran.length === 0) {
    const stuck = Object.entries(outcome.tasks).filter(
      ([, t]) => t.status === "failed" || t.status === "blocked",
    );
    if (stuck.length > 0) {
      return fail(
        `no runnable task; failed or blocked: ${stuck.map(([id]) => id).join(", ")} (run them explicitly to retry)`,
        ExitCode.Invalid,
      );
    }
    io.stdout("all tasks are done\n");
    return ExitCode.Ok;
  }
  let code: ExitCode = ExitCode.Ok;
  for (const id of outcome.ran) {
    const state = outcome.tasks[id];
    if (state === undefined) continue;
    const attempt = state.iterations.slice(state.attemptStart);
    const cost = attempt.reduce(
      (sum, it) => sum + (it.worker?.costUsd ?? 0) + (it.review?.costUsd ?? 0),
      0,
    );
    io.stdout(
      `${id}: ${state.status} after ${attempt.length} ${attempt.length === 1 ? "iteration" : "iterations"}, $${cost.toFixed(4)}${state.reason === null ? "" : ` (${state.reason})`}\n`,
    );
    if (state.status === "blocked") code = ExitCode.Usage;
    else if (state.status === "failed" && code === ExitCode.Ok) code = ExitCode.Invalid;
  }
  if (code !== ExitCode.Ok)
    io.stderr("see .verify.log in the task worktree and .themis/runs/<task>/\n");
  return code;
}

function formatEvent(event: RunEvent): string {
  const t = event.task;
  switch (event.type) {
    case "task-start":
      return `${t}: ${event.resumed ? "resuming" : "starting"}\n`;
    case "iteration-start":
      return `${t} iteration ${event.iteration}/${event.max}: worker...\n`;
    case "worker-done": {
      const cost = event.costUsd === null ? "" : `, $${event.costUsd.toFixed(4)}`;
      const status = event.ok ? "done" : `failed (${event.error ?? "unknown error"})`;
      return `${t} iteration ${event.iteration}: worker ${status} in ${(event.durationMs / 1000).toFixed(0)}s${cost}; verifying...\n`;
    }
    case "verify-done":
      return event.exit === 0
        ? `${t} iteration ${event.iteration}: verify PASS; reviewing...\n`
        : `${t} iteration ${event.iteration}: verify exit ${event.exit ?? "none"}${event.failedStep === null ? "" : ` at ${event.failedStep}`}\n`;
    case "review-done": {
      const cost = event.costUsd === null ? "" : ` ($${event.costUsd.toFixed(4)})`;
      return event.verdict === "approve"
        ? `${t} iteration ${event.iteration}: review approved${cost}; merging...\n`
        : `${t} iteration ${event.iteration}: review asked for changes${cost}:\n${event.reasons.map((r) => `    - ${r}\n`).join("")}`;
    }
    case "merged":
      return `${t}: merged and verified\n`;
    case "merge-reverted":
      return `${t}: merged result failed the verifier${event.failedStep === null ? "" : ` at ${event.failedStep}`}; merge undone\n`;
    case "merge-conflict":
      return `${t}: merge conflict on ${event.conflicts.join(", ")}; the worker will resolve it\n`;
    case "task-end":
      return `${t}: ${event.status}${event.reason === null ? "" : ` (${event.reason})`}\n`;
  }
}
