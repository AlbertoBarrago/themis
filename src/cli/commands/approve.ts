import { parseArgs } from "node:util";
import { approvePlan, TasksFileError } from "../../plan/plan.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";
import { formatPlan } from "./plan.js";

export const APPROVE_HELP = `Usage: ordito approve <gate>

Human approval gates:
  plan    Approve the draft .ordito/tasks.json produced by ordito plan
`;

export async function approveCommand(args: string[], io: CliIo): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h", default: false } },
  });
  if (values.help) {
    io.stdout(APPROVE_HELP);
    return ExitCode.Ok;
  }
  const [gate, ...extra] = positionals;
  if (gate !== "plan" || extra.length > 0) {
    io.stderr(
      `ordito approve: expected a gate${gate === undefined ? "" : `, got "${positionals.join(" ")}"`}\n\n${APPROVE_HELP}`,
    );
    return ExitCode.Usage;
  }

  let outcome: Awaited<ReturnType<typeof approvePlan>>;
  try {
    outcome = await approvePlan(io.cwd);
  } catch (err) {
    if (err instanceof TasksFileError) {
      io.stderr(`ordito approve plan: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }

  switch (outcome.kind) {
    case "no-plan":
      io.stderr("ordito approve plan: no plan to approve; run ordito plan first\n");
      return ExitCode.Usage;
    case "spec-unreadable":
      io.stderr(`ordito approve plan: ${outcome.message}\n`);
      return ExitCode.Usage;
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic("spec", d)}\n`);
      io.stderr("ordito approve plan: the spec is invalid\n");
      return ExitCode.Invalid;
    case "spec-changed":
      io.stderr(
        "ordito approve plan: the spec changed since the plan was made; re-run ordito plan\n",
      );
      return ExitCode.Invalid;
    case "already-approved":
      io.stdout("plan already approved\n");
      return ExitCode.Ok;
    case "approved":
      io.stdout(formatPlan(outcome.tasks));
      for (const q of outcome.tasks.questions)
        io.stderr(`warning: approved with open question: ${q}\n`);
      io.stdout("plan approved; next: ordito tests\n");
      return ExitCode.Ok;
  }
}
