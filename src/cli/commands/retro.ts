import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { availableAgents, DEFAULT_AGENT, runnerFor } from "../../adapters/registry.js";
import { formatTotals } from "../../agents/structured.js";
import { Git, GitError } from "../../git/git.js";
import { TasksFileError } from "../../plan/plan.js";
import type { Evidence } from "../../retro/evidence.js";
import { type FileChange, retro } from "../../retro/retro.js";
import { instructionsPath, type Proposal, RETRO_PATH } from "../../retro/schema.js";
import { StateFileError } from "../../run/state.js";
import { ExecError, type Executor } from "../../runtime/executor.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";

export const RETRO_HELP = `Usage: themis retro [--spec <path>] [--agent <name>]

Analyses the run recorded in .themis/state.json and asks the retro agent for changes to the
planner, test-author, worker and reviewer instructions. Every change cites the evidence it is
based on. The proposal is written to ${RETRO_PATH}; review it, then run: themis approve retro

Options:
  --spec <path>     Spec file (default: spec.md)
  --agent <name>    Agent adapter (default: ${DEFAULT_AGENT})
  -h, --help
`;

/** Where proposed contents are written to be diffed; git-ignored like every run log. */
const PROPOSED_DIR = ".themis/runs/retro/proposed";

export async function retroCommand(
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
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(RETRO_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    io.stderr(`themis retro: unexpected argument "${positionals[0]}"\n\n${RETRO_HELP}`);
    return ExitCode.Usage;
  }
  const runner = runnerFor(values.agent, executor);
  if (runner === undefined) {
    io.stderr(
      `themis retro: unknown agent "${values.agent}" (available: ${availableAgents().join(", ")})\n`,
    );
    return ExitCode.Usage;
  }
  const specPath = values.spec.replaceAll("\\", "/").replace(/^\.\//, "");

  io.stderr("analysing the run...\n");
  let outcome: Awaited<ReturnType<typeof retro>>;
  try {
    outcome = await retro({ root: io.cwd, specPath, runner });
  } catch (err) {
    if (err instanceof TasksFileError || err instanceof StateFileError) {
      io.stderr(`themis retro: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }

  switch (outcome.kind) {
    case "not-initialized":
    case "spec-unreadable":
      io.stderr(`themis retro: ${outcome.message}\n`);
      return ExitCode.Usage;
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic(specPath, d)}\n`);
      io.stderr(`themis retro: ${specPath} is invalid, fix it first (themis check)\n`);
      return ExitCode.Invalid;
    case "nothing-to-analyse":
      io.stderr("themis retro: no task has finished yet; run themis run first\n");
      return ExitCode.Usage;
    case "no-evidence":
      warn(io, outcome.warnings);
      io.stdout("nothing to improve: every task passed at its first iteration\n");
      return ExitCode.Ok;
    case "agent-unavailable":
      io.stderr(
        `themis retro: agent unavailable: ${outcome.message}\n${formatTotals("retro", outcome.totals)}`,
      );
      return ExitCode.Usage;
    case "agent-failed":
      io.stderr(
        `themis retro: the retro agent failed: ${outcome.message}\n${formatTotals("retro", outcome.totals)}`,
      );
      return ExitCode.Usage;
    case "invalid-proposal":
      io.stderr(
        `themis retro: no valid proposal after ${outcome.totals.attempts} attempts:\n${outcome.errors.map((e) => `  - ${e}\n`).join("")}` +
          `Retro logs: .themis/runs/retro/\n${formatTotals("retro", outcome.totals)}`,
      );
      return ExitCode.Invalid;
    case "done": {
      warn(io, outcome.warnings);
      io.stdout(formatProposals(outcome.proposals, outcome.evidence));
      io.stdout(await formatDiffs(new Git(executor), io.cwd, outcome.changes));
      io.stdout(formatTotals("retro", outcome.totals));
      io.stdout(
        outcome.proposals.length === 0
          ? "no change proposed\n"
          : `proposal written to ${RETRO_PATH}; review it, then run: themis approve retro\n`,
      );
      return ExitCode.Ok;
    }
  }
}

export function formatProposals(
  proposals: readonly Proposal[],
  evidence: readonly Evidence[],
): string {
  const details = new Map(evidence.map((e) => [e.id, e.detail]));
  const lines: string[] = [];
  proposals.forEach((p, i) => {
    lines.push(`${i + 1}. ${instructionsPath(p.role)}: ${p.pattern}`);
    for (const id of p.evidence) lines.push(`     ${id}: ${details.get(id) ?? "(unknown)"}`);
  });
  return lines.length === 0 ? "" : `${lines.join("\n")}\n\n`;
}

/**
 * Unified diff of every changed file. The proposed content is written next to the run logs
 * so `git diff --no-index` can compare it; the headers then name the real file.
 */
export async function formatDiffs(
  git: Git,
  root: string,
  changes: readonly FileChange[],
): Promise<string> {
  let out = "";
  await mkdir(join(root, PROPOSED_DIR), { recursive: true });
  for (const change of changes) {
    const proposed = `${PROPOSED_DIR}/${basename(change.path)}`;
    await writeFile(join(root, proposed), change.after);
    try {
      out += (await git.diffFiles(root, change.path, proposed)).replaceAll(proposed, change.path);
    } catch (err) {
      if (!(err instanceof GitError || err instanceof ExecError)) throw err;
      out += `(no diff for ${change.path}: ${err.message}; proposed content in ${proposed})\n`;
    }
  }
  return out === "" ? "" : `${out}\n`;
}

function warn(io: CliIo, warnings: readonly string[]): void {
  for (const w of warnings) io.stderr(`warning: ${w}\n`);
}
