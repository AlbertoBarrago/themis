import { parseArgs } from "node:util";
import { TestsFileError } from "../../acceptance/acceptance.js";
import { availableAgents, DEFAULT_AGENT, runnerFor } from "../../adapters/registry.js";
import { TasksFileError } from "../../plan/plan.js";
import { type RunEvent, runTask } from "../../run/run.js";
import { StateFileError } from "../../run/state.js";
import type { Executor } from "../../runtime/executor.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { EXECUTORS, executorFor } from "../../runtime/select.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";

export const RUN_HELP = `Usage: themis run [task] [--executor local|lima] [--agent <name>] [--spec <path>]

Runs one task until the verifier passes: the worker agent edits the code, then Themis runs
.themis/verify.sh itself. Without a task id, runs the first task whose dependencies are done.
State is saved after every step: interrupt with Ctrl-C and run again to resume.

Options:
  --executor <name>  Where agents and the verifier run: local (default) or lima
                     (VM from scripts/lima/create-vm.sh; instance THEMIS_LIMA_INSTANCE or "themis")
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
      executor: { type: "string", default: "local" },
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
  const executor = executorFor(values.executor, host);
  if (executor === undefined) {
    io.stderr(
      `themis run: unknown executor "${values.executor}" (available: ${EXECUTORS.join(", ")})\n`,
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
  const specPath = values.spec.replaceAll("\\", "/").replace(/^\.\//, "");

  let outcome: Awaited<ReturnType<typeof runTask>>;
  try {
    outcome = await runTask({
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
      err instanceof StateFileError
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
    case "nothing-to-run":
      if (outcome.blocked.length > 0) {
        return fail(
          `no runnable task; failed or blocked: ${outcome.blocked.join(", ")} (run them explicitly to retry)`,
          ExitCode.Invalid,
        );
      }
      io.stdout(`all tasks are done (${outcome.done.length})\n`);
      return ExitCode.Ok;
    case "finished": {
      const { state, task } = outcome;
      const cost = state.iterations
        .slice(state.attemptStart)
        .reduce((sum, it) => sum + (it.worker.costUsd ?? 0), 0);
      const used = state.iterations.length - state.attemptStart;
      io.stdout(
        `${task}: ${state.status} after ${used} ${used === 1 ? "iteration" : "iterations"}, $${cost.toFixed(4)}\n`,
      );
      for (const choice of state.choices)
        io.stdout(`  decided: ${choice.question} -> ${choice.decision}\n`);
      if (state.status === "done") return ExitCode.Ok;
      io.stderr(
        `${task} ${state.status}: ${state.reason ?? ""}\nsee .verify.log and .themis/runs/${task}/\n`,
      );
      return state.status === "blocked" ? ExitCode.Usage : ExitCode.Invalid;
    }
  }
}

function formatEvent(event: RunEvent): string {
  switch (event.type) {
    case "iteration-start":
      return `${event.task} iteration ${event.iteration}/${event.max}: worker...\n`;
    case "worker-done": {
      const cost = event.costUsd === null ? "" : `, $${event.costUsd.toFixed(4)}`;
      const status = event.ok ? "done" : `failed (${event.error ?? "unknown error"})`;
      return `${event.task} iteration ${event.iteration}: worker ${status} in ${(event.durationMs / 1000).toFixed(0)}s${cost}; verifying...\n`;
    }
    case "verify-done":
      return event.exit === 0
        ? `${event.task} iteration ${event.iteration}: verify PASS\n`
        : `${event.task} iteration ${event.iteration}: verify exit ${event.exit ?? "none"}${event.failedStep === null ? "" : ` at ${event.failedStep}`}\n`;
  }
}
