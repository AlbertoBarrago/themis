import { parseArgs } from "node:util";
import { generateTests, TestsFileError } from "../../acceptance/acceptance.js";
import { coverage } from "../../acceptance/validate.js";
import { availableAgents, DEFAULT_AGENT, runnerFor } from "../../adapters/registry.js";
import { formatQuestions } from "../../agents/format.js";
import { formatTotals } from "../../agents/structured.js";
import { loadSpec, TasksFileError } from "../../plan/plan.js";
import type { Executor } from "../../runtime/executor.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";

export const TESTS_HELP = `Usage: themis tests [--spec <path>] [--agent <name>] [--force]

Asks the test-author agent for acceptance tests covering every criterion and writes them
under tests/acceptance/ as a draft. Read them (and edit them if needed), then run:
themis approve tests

Options:
  --spec <path>     Spec file (default: spec.md)
  --agent <name>    Agent adapter (default: ${DEFAULT_AGENT})
  --force           Replace existing acceptance tests and unlock the contract
  -h, --help
`;

export async function testsCommand(
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
    io.stdout(TESTS_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    io.stderr(`themis tests: unexpected argument "${positionals[0]}"\n\n${TESTS_HELP}`);
    return ExitCode.Usage;
  }
  const runner = runnerFor(values.agent, executor);
  if (runner === undefined) {
    io.stderr(
      `themis tests: unknown agent "${values.agent}" (available: ${availableAgents().join(", ")})\n`,
    );
    return ExitCode.Usage;
  }
  const specPath = values.spec.replaceAll("\\", "/").replace(/^\.\//, "");

  io.stderr("writing acceptance tests...\n");
  let outcome: Awaited<ReturnType<typeof generateTests>>;
  try {
    outcome = await generateTests({ root: io.cwd, specPath, force: values.force, runner });
  } catch (err) {
    if (err instanceof TasksFileError || err instanceof TestsFileError) {
      io.stderr(`themis tests: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }

  const fail = (message: string, code: ExitCode) => {
    io.stderr(`themis tests: ${message}\n`);
    return code;
  };
  switch (outcome.kind) {
    case "not-initialized":
    case "spec-unreadable":
      return fail(outcome.message, ExitCode.Usage);
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic(specPath, d)}\n`);
      return fail(`${specPath} is invalid, fix it first (themis check)`, ExitCode.Invalid);
    case "plan-not-approved":
      return fail(
        "the plan is not approved yet: run themis plan, then themis approve plan",
        ExitCode.Usage,
      );
    case "spec-changed":
      return fail(
        "the spec changed since the plan was approved; re-run themis plan",
        ExitCode.Invalid,
      );
    case "contract-locked":
      return fail(
        "the contract is already locked; use --force to unlock it and regenerate the tests",
        ExitCode.Usage,
      );
    case "acceptance-not-empty":
      return fail(
        `tests/acceptance/ already has ${outcome.files.length} files; use --force to replace them`,
        ExitCode.Usage,
      );
    case "agent-unavailable":
      return fail(
        `agent unavailable: ${outcome.message}\n${formatTotals("test author", outcome.totals)}`,
        ExitCode.Usage,
      );
    case "agent-failed":
      return fail(
        `the test author failed: ${outcome.message}\n${formatTotals("test author", outcome.totals)}`,
        ExitCode.Usage,
      );
    case "invalid-tests":
      return fail(
        `no valid tests after ${outcome.totals.attempts} attempts:\n${outcome.errors.map((e) => `  - ${e}\n`).join("")}` +
          `Logs: .themis/runs/tests/\n${formatTotals("test author", outcome.totals)}`,
        ExitCode.Invalid,
      );
    case "done":
      break;
  }

  const loaded = await loadSpec(io.cwd, specPath);
  io.stdout(`Acceptance tests (draft):\n\n`);
  for (const file of outcome.files) {
    io.stdout(`  ${file.path}  (${file.content.split("\n").length} lines)\n`);
  }
  if (loaded.ok) {
    io.stdout("\nCoverage:\n");
    for (const [id, paths] of coverage(loaded.spec, outcome.files)) {
      io.stdout(`  ${id.padEnd(6)} ${paths.join(", ")}\n`);
    }
  }
  io.stdout(formatQuestions(outcome.state.questions));
  io.stdout(`\n${formatTotals("test author", outcome.totals)}`);
  io.stdout(
    outcome.state.questions.some((q) => q.severity === "blocking")
      ? "resolve the blocking questions in the spec, then re-run themis plan and themis tests --force\n"
      : "read the tests (you may edit them), then run: themis approve tests\n",
  );
  return ExitCode.Ok;
}
