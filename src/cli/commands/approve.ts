import { parseArgs } from "node:util";
import { approveTests, TestsFileError } from "../../acceptance/acceptance.js";
import { DEFAULT_AGENT, guardInstallerFor } from "../../adapters/registry.js";
import type { Question } from "../../agents/questions.js";
import { approvePlan, TasksFileError } from "../../plan/plan.js";
import { approveRetro, RetroFileError } from "../../retro/retro.js";
import { RETRO_PATH } from "../../retro/schema.js";
import type { Executor } from "../../runtime/executor.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";
import { formatPlan } from "./plan.js";

export const APPROVE_HELP = `Usage: themis approve <gate> [--force]

Human approval gates:
  plan    Approve the draft .themis/tasks.json produced by themis plan
  tests   Approve tests/acceptance/ and lock the contract (.themis/lock.json)
  retro   Apply the changes to the agent instructions proposed by themis retro

Options:
  --force           Approve despite blocking questions
  --agent <name>    Agent adapter whose configuration is locked too (default: ${DEFAULT_AGENT})
`;

export async function approveCommand(
  args: string[],
  io: CliIo,
  executor: Executor = new LocalExecutor(),
): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      agent: { type: "string", default: DEFAULT_AGENT },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(APPROVE_HELP);
    return ExitCode.Ok;
  }
  const [gate, ...extra] = positionals;
  if ((gate !== "plan" && gate !== "tests" && gate !== "retro") || extra.length > 0) {
    io.stderr(
      `themis approve: expected a gate${gate === undefined ? "" : `, got "${positionals.join(" ")}"`}\n\n${APPROVE_HELP}`,
    );
    return ExitCode.Usage;
  }
  try {
    if (gate === "retro") return await approveRetroGate(io);
    return gate === "plan"
      ? await approvePlanGate(io, values.force)
      : await approveTestsGate(io, values.force, values.agent, executor);
  } catch (err) {
    if (
      err instanceof TasksFileError ||
      err instanceof TestsFileError ||
      err instanceof RetroFileError
    ) {
      io.stderr(`themis approve ${gate}: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }
}

async function approvePlanGate(io: CliIo, force: boolean): Promise<ExitCode> {
  const outcome = await approvePlan(io.cwd, { force });
  const fail = (message: string, code: ExitCode) => {
    io.stderr(`themis approve plan: ${message}\n`);
    return code;
  };
  switch (outcome.kind) {
    case "no-plan":
      return fail("no plan to approve; run themis plan first", ExitCode.Usage);
    case "spec-unreadable":
      return fail(outcome.message, ExitCode.Usage);
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic("spec", d)}\n`);
      return fail("the spec is invalid", ExitCode.Invalid);
    case "spec-changed":
      return fail("the spec changed since the plan was made; re-run themis plan", ExitCode.Invalid);
    case "blocked":
      return fail(blockedMessage(outcome.tasks.questions, "themis plan"), ExitCode.Invalid);
    case "already-approved":
      io.stdout("plan already approved\n");
      return ExitCode.Ok;
    case "approved":
      io.stdout(formatPlan(outcome.tasks));
      warnForced(io, outcome.tasks.questions);
      io.stdout("plan approved; next: themis tests\n");
      return ExitCode.Ok;
  }
}

async function approveTestsGate(
  io: CliIo,
  force: boolean,
  agent: string,
  executor: Executor,
): Promise<ExitCode> {
  const guards = guardInstallerFor(agent);
  if (guards === undefined) {
    io.stderr(`themis approve tests: unknown agent "${agent}"\n`);
    return ExitCode.Usage;
  }
  const outcome = await approveTests({
    root: io.cwd,
    executor,
    agentConfigFiles: guards.configFiles,
    force,
  });
  const fail = (message: string, code: ExitCode) => {
    io.stderr(`themis approve tests: ${message}\n`);
    return code;
  };
  switch (outcome.kind) {
    case "no-tests":
      return fail("no acceptance tests to approve; run themis tests first", ExitCode.Usage);
    case "spec-unreadable":
      return fail(outcome.message, ExitCode.Usage);
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic("spec", d)}\n`);
      return fail("the spec is invalid", ExitCode.Invalid);
    case "plan-not-approved":
      return fail("the plan is not approved; run themis approve plan first", ExitCode.Usage);
    case "spec-changed":
      return fail(
        "the spec changed since the tests were written; re-run themis plan and themis tests --force",
        ExitCode.Invalid,
      );
    case "invalid-tests":
      return fail(
        `tests/acceptance/ does not satisfy the contract rules:\n${outcome.errors.map((e) => `  - ${e}\n`).join("")}`.trimEnd(),
        ExitCode.Invalid,
      );
    case "blocked":
      return fail(
        blockedMessage(outcome.state.questions, "themis tests --force"),
        ExitCode.Invalid,
      );
    case "missing-contract-file":
      return fail(`${outcome.path} is missing; run themis init`, ExitCode.Usage);
    case "already-approved":
      io.stdout("tests already approved and locked\n");
      return ExitCode.Ok;
    case "approved": {
      const files = Object.keys(outcome.lock.files);
      warnForced(io, outcome.state.questions);
      io.stdout(
        `contract locked: ${files.length} files in .themis/lock.json` +
          `${outcome.lock.base === null ? " (no git commit: markers are checked on every file)" : ` (base ${outcome.lock.base.slice(0, 12)})`}\n` +
          files.map((f) => `  ${f}\n`).join("") +
          "next: themis run\n",
      );
      return ExitCode.Ok;
    }
  }
}

async function approveRetroGate(io: CliIo): Promise<ExitCode> {
  const outcome = await approveRetro(io.cwd);
  const fail = (message: string, code: ExitCode) => {
    io.stderr(`themis approve retro: ${message}\n`);
    return code;
  };
  switch (outcome.kind) {
    case "no-proposal":
      return fail("no proposal to approve; run themis retro first", ExitCode.Usage);
    case "changed":
      return fail(
        `changed since the proposal was made: ${outcome.files.join(", ")}; re-run themis retro`,
        ExitCode.Invalid,
      );
    case "invalid-proposal":
      return fail(
        `${RETRO_PATH} cannot be applied:\n${outcome.errors.map((e) => `  - ${e}\n`).join("")}`.trimEnd(),
        ExitCode.Invalid,
      );
    case "approved": {
      const paths = outcome.changes.map((c) => c.path);
      if (paths.length === 0) {
        io.stdout("no change proposed; proposal removed\n");
        return ExitCode.Ok;
      }
      io.stdout(
        `updated:\n${paths.map((p) => `  ${p}\n`).join("")}` +
          `commit them before the next themis run:\n  git add ${paths.join(" ")}\n  git commit -m "chore: apply themis retro"\n`,
      );
      return ExitCode.Ok;
    }
  }
}

function blockedMessage(questions: readonly Question[], redo: string): string {
  const blocking = questions.filter((q) => q.severity === "blocking");
  return (
    `${blocking.length} blocking ${blocking.length === 1 ? "question" : "questions"}:\n` +
    blocking.map((q) => `  ! ${q.text}\n`).join("") +
    `fix the spec and redo ${redo}, or approve anyway with --force`
  );
}

function warnForced(io: CliIo, questions: readonly Question[]): void {
  for (const q of questions.filter((q) => q.severity === "blocking")) {
    io.stderr(`warning: approved with blocking question (--force): ${q.text}\n`);
  }
}
