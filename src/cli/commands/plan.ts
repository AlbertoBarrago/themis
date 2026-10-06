import { parseArgs } from "node:util";
import { availableAgents, DEFAULT_AGENT, runnerFor } from "../../adapters/registry.js";
import { formatQuestions } from "../../agents/format.js";
import { formatTotals } from "../../agents/structured.js";
import { plan, TasksFileError } from "../../plan/plan.js";
import type { TasksFile } from "../../plan/schema.js";
import type { Executor } from "../../runtime/executor.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";

export const PLAN_HELP = `Usage: themis plan [--spec <path>] [--agent <name>] [--force]

Asks the planner agent for a task graph, validates it against the spec and writes a draft
.themis/tasks.json. Review it, then run: themis approve plan

Options:
  --spec <path>     Spec file (default: spec.md)
  --agent <name>    Agent adapter (default: ${DEFAULT_AGENT})
  --force           Replace an already approved plan (resets the approval)
  -h, --help
`;

export async function planCommand(
  args: string[],
  io: CliIo,
  executor: Executor = new LocalExecutor(),
): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      spec: { type: "string", default: "spec.md" },
      agent: { type: "string", default: DEFAULT_AGENT },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(PLAN_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    io.stderr(`themis plan: unexpected argument "${positionals[0]}"\n\n${PLAN_HELP}`);
    return ExitCode.Usage;
  }
  const runner = runnerFor(values.agent, executor);
  if (runner === undefined) {
    io.stderr(
      `themis plan: unknown agent "${values.agent}" (available: ${availableAgents().join(", ")})\n`,
    );
    return ExitCode.Usage;
  }
  const specPath = values.spec.replaceAll("\\", "/").replace(/^\.\//, "");

  io.stderr("planning...\n");
  let outcome: Awaited<ReturnType<typeof plan>>;
  try {
    outcome = await plan({ root: io.cwd, specPath, force: values.force, runner });
  } catch (err) {
    if (err instanceof TasksFileError) {
      io.stderr(`themis plan: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }

  switch (outcome.kind) {
    case "not-initialized":
    case "spec-unreadable":
      io.stderr(`themis plan: ${outcome.message}\n`);
      return ExitCode.Usage;
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic(specPath, d)}\n`);
      io.stderr(`themis plan: ${specPath} is invalid, fix it first (themis check)\n`);
      return ExitCode.Invalid;
    case "already-approved":
      io.stderr("themis plan: the plan is already approved; use --force to replan\n");
      return ExitCode.Usage;
    case "agent-unavailable":
      io.stderr(
        `themis plan: agent unavailable: ${outcome.message}\n${formatTotals("planner", outcome.totals)}`,
      );
      return ExitCode.Usage;
    case "agent-failed":
      io.stderr(
        `themis plan: the planner failed: ${outcome.message}\n${formatTotals("planner", outcome.totals)}`,
      );
      return ExitCode.Usage;
    case "invalid-plan":
      io.stderr(
        `themis plan: no valid plan after ${outcome.totals.attempts} attempts:\n${outcome.errors.map((e) => `  - ${e}\n`).join("")}` +
          `Consider making the spec more explicit. Planner logs: .themis/runs/plan/\n${formatTotals("planner", outcome.totals)}`,
      );
      return ExitCode.Invalid;
    case "done":
      io.stdout(formatPlan(outcome.tasks));
      io.stdout(formatTotals("planner", outcome.totals));
      io.stdout(
        outcome.tasks.questions.some((q) => q.severity === "blocking")
          ? "draft written to .themis/tasks.json; resolve the blocking questions in the spec, then re-run themis plan\n"
          : "draft written to .themis/tasks.json; review it, then run: themis approve plan\n",
      );
      return ExitCode.Ok;
  }
}

/** Human-readable plan for the approval gate. */
export function formatPlan(tasks: TasksFile): string {
  const width = Math.max(...tasks.tasks.map((t) => t.id.length));
  const lines = [`Plan for ${tasks.spec} (${tasks.tasks.length} tasks, ${tasks.status}):`, ""];
  tasks.tasks.forEach((task, i) => {
    const after = task.dependsOn.length > 0 ? `  [after ${task.dependsOn.join(", ")}]` : "";
    lines.push(`${String(i + 1).padStart(3)}. ${task.id.padEnd(width)}  ${task.title}${after}`);
    lines.push(`       ${task.scope}`);
    for (const added of task.addedDependencies) {
      lines.push(`       + depends on ${added.id}: ${added.reason}`);
    }
  });
  const questions = formatQuestions(tasks.questions);
  return `${lines.join("\n")}\n${questions}\n`;
}
