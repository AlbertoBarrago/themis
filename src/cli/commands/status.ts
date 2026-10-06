import { parseArgs } from "node:util";
import { TestsFileError } from "../../acceptance/acceptance.js";
import { TasksFileError } from "../../plan/plan.js";
import { StateFileError } from "../../run/state.js";
import { LockFileError, type StatusReport, status } from "../../status/status.js";
import { type CliIo, ExitCode } from "../io.js";

export const STATUS_HELP = `Usage: themis status [--spec <path>] [--json]

Shows the gates (spec, plan, contract) and the state of every planned task: iterations,
cost, and why a task failed or is blocked. Read-only.

Exit codes: 0 report printed (whatever the state of the run), 2 a Themis file is unreadable.

Options:
  --spec <path>  Spec file (default: spec.md)
  --json         Print the report as JSON
  -h, --help
`;

export async function statusCommand(args: string[], io: CliIo): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      spec: { type: "string", default: "spec.md" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(STATUS_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    io.stderr(`themis status: unexpected argument "${positionals[0]}"\n\n${STATUS_HELP}`);
    return ExitCode.Usage;
  }
  const specPath = values.spec.replaceAll("\\", "/").replace(/^\.\//, "");

  let report: StatusReport;
  try {
    report = await status(io.cwd, specPath);
  } catch (err) {
    if (
      err instanceof TasksFileError ||
      err instanceof TestsFileError ||
      err instanceof StateFileError ||
      err instanceof LockFileError
    ) {
      io.stderr(`themis status: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }
  io.stdout(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));
  return ExitCode.Ok;
}

export function formatStatus(report: StatusReport): string {
  const contract =
    report.contract.state === "modified"
      ? `locked, but changed since: ${report.contract.files.join(", ")}`
      : report.contract.state;
  const lines = [
    `spec      ${report.spec.path}: ${report.spec.ok ? "valid" : report.spec.problem}`,
    `plan      ${report.plan === "stale" ? "approved for a different spec (re-plan)" : report.plan}`,
    `contract  ${contract}`,
  ];
  if (report.tasks.length > 0) {
    const width = Math.max(...report.tasks.map((t) => t.id.length));
    const statusWidth = Math.max(...report.tasks.map((t) => t.status.length));
    lines.push("");
    for (const t of report.tasks) {
      const budget =
        t.maxIterations === null ? `${t.iterations}` : `${t.iterations}/${t.maxIterations}`;
      const total = t.totalIterations > t.iterations ? ` (${t.totalIterations} total)` : "";
      lines.push(
        `${t.id.padEnd(width)}  ${t.status.padEnd(statusWidth)}  ${budget} iterations${total}${formatCost(t.costUsd, ", ")}`,
      );
      if (t.note !== null) lines.push(`${" ".repeat(width)}  ${t.note}`);
    }
    lines.push(
      "",
      `total     ${report.totals.iterations} iterations${formatCost(report.totals.costUsd, ", ")}`,
    );
  }
  if (report.retroPending)
    lines.push("retro     proposal pending: review it, then run themis approve retro");
  return `${lines.join("\n")}\n`;
}

function formatCost(cost: number | null, prefix: string): string {
  return cost === null ? "" : `${prefix}$${cost.toFixed(4)}`;
}
