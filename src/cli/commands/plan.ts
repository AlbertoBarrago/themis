import { parseArgs } from "node:util";
import { availableAgents, DEFAULT_AGENT, runnerFor } from "../../adapters/registry.js";
import { type PlanTotals, plan, TasksFileError } from "../../plan/plan.js";
import type { TasksFile } from "../../plan/schema.js";
import type { Executor } from "../../runtime/executor.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";

export const PLAN_HELP = `Usage: ordito plan [--spec <path>] [--agent <name>] [--force]

Asks the planner agent for a task graph, validates it against the spec and writes a draft
.ordito/tasks.json. Review it, then run: ordito approve plan

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
    io.stderr(`ordito plan: unexpected argument "${positionals[0]}"\n\n${PLAN_HELP}`);
    return ExitCode.Usage;
  }
  const runner = runnerFor(values.agent, executor);
  if (runner === undefined) {
    io.stderr(
      `ordito plan: unknown agent "${values.agent}" (available: ${availableAgents().join(", ")})\n`,
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
      io.stderr(`ordito plan: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }

  switch (outcome.kind) {
    case "not-initialized":
    case "spec-unreadable":
      io.stderr(`ordito plan: ${outcome.message}\n`);
      return ExitCode.Usage;
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic(specPath, d)}\n`);
      io.stderr(`ordito plan: ${specPath} is invalid, fix it first (ordito check)\n`);
      return ExitCode.Invalid;
    case "already-approved":
      io.stderr("ordito plan: the plan is already approved; use --force to replan\n");
      return ExitCode.Usage;
    case "agent-unavailable":
      io.stderr(
        `ordito plan: agent unavailable: ${outcome.message}\n${formatTotals(outcome.totals)}`,
      );
      return ExitCode.Usage;
    case "agent-failed":
      io.stderr(
        `ordito plan: the planner failed: ${outcome.message}\n${formatTotals(outcome.totals)}`,
      );
      return ExitCode.Usage;
    case "invalid-plan":
      io.stderr(
        `ordito plan: no valid plan after ${outcome.totals.attempts} attempts:\n${outcome.errors.map((e) => `  - ${e}\n`).join("")}` +
          `Consider making the spec more explicit. Planner logs: .ordito/runs/plan/\n${formatTotals(outcome.totals)}`,
      );
      return ExitCode.Invalid;
    case "done":
      io.stdout(formatPlan(outcome.tasks));
      io.stdout(formatTotals(outcome.totals));
      io.stdout("draft written to .ordito/tasks.json; review it, then run: ordito approve plan\n");
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
  if (tasks.questions.length > 0) {
    lines.push("", "Open questions (resolve them in the spec before approving, or approve as is):");
    for (const q of tasks.questions) lines.push(`  ? ${q}`);
  }
  return `${lines.join("\n")}\n\n`;
}

function formatTotals(totals: PlanTotals): string {
  const cost = totals.costUsd === null ? "" : `, $${totals.costUsd.toFixed(4)}`;
  const attempts = `${totals.attempts} ${totals.attempts === 1 ? "attempt" : "attempts"}`;
  return `planner: ${attempts}, ${(totals.durationMs / 1000).toFixed(1)}s${cost}\n`;
}
