import { parseArgs } from "node:util";
import { availableAgents, DEFAULT_AGENT, guardInstallerFor } from "../../adapters/registry.js";
import { init } from "../../init/init.js";
import type { Executor } from "../../runtime/executor.js";
import { LocalExecutor } from "../../runtime/local-executor.js";
import { EXECUTORS, executorFor } from "../../runtime/select.js";
import { formatDiagnostic } from "../../spec/diagnostics.js";
import { type CliIo, ExitCode } from "../io.js";

export const INIT_HELP = `Usage: themis init [--spec <path>] [--agent <name>] [--executor local|lima] [--force] [--skip-install]

Prepares the current directory for Themis: scaffolds a node-ts project if there is no
package.json, then writes .themis/ (verifier, guard, agent roles) and agent protections.

Options:
  --spec <path>     Spec file (default: spec.md)
  --agent <name>    Agent adapter (default: ${DEFAULT_AGENT})
  --executor <name> Where npm install runs: local (default) or lima (the project must then be
                    run with --executor lima too: native binaries differ per platform)
  --force           Overwrite generated files whose content differs
  --skip-install    Do not run npm install
  -h, --help
`;

/** `themis init`. The executor is injectable so tests never run npm. */
export async function initCommand(
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
      executor: { type: "string", default: "local" },
      "skip-install": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(INIT_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    io.stderr(`themis init: unexpected argument "${positionals[0]}"\n\n${INIT_HELP}`);
    return ExitCode.Usage;
  }
  const guards = guardInstallerFor(values.agent);
  if (guards === undefined) {
    io.stderr(
      `themis init: unknown agent "${values.agent}" (available: ${availableAgents().join(", ")})\n`,
    );
    return ExitCode.Usage;
  }

  const selected = executorFor(values.executor, executor);
  if (selected === undefined) {
    io.stderr(
      `themis init: unknown executor "${values.executor}" (available: ${EXECUTORS.join(", ")})\n`,
    );
    return ExitCode.Usage;
  }
  const specPath = values.spec.replaceAll("\\", "/").replace(/^\.\//, "");
  const outcome = await init({
    root: io.cwd,
    specPath,
    force: values.force,
    install: !values["skip-install"],
    guards,
    executor: selected,
  });

  switch (outcome.kind) {
    case "spec-unreadable":
      io.stderr(`themis init: ${outcome.message}\n`);
      return ExitCode.Usage;
    case "invalid-spec":
      for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic(specPath, d)}\n`);
      io.stderr(`themis init: ${specPath} is invalid, fix it first (themis check)\n`);
      return ExitCode.Invalid;
    case "incompatible":
      io.stderr(
        `themis init: this project is not set up for the node-ts stack:\n${outcome.problems.map((p) => `  - ${p}\n`).join("")}`,
      );
      return ExitCode.Usage;
    case "guard-error":
      io.stderr(`themis init: ${outcome.message}\n`);
      return ExitCode.Usage;
    case "done":
      break;
  }

  for (const d of outcome.diagnostics) io.stdout(`${formatDiagnostic(specPath, d)}\n`);
  if (outcome.scaffolded) io.stdout("scaffolded a new node-ts project\n");
  for (const change of outcome.changes) io.stdout(`${change.status.padEnd(9)} ${change.path}\n`);
  for (const warning of outcome.warnings) io.stderr(`warning: ${warning}\n`);

  switch (outcome.install.kind) {
    case "failed":
      io.stderr(`themis init: ${outcome.install.message}\n`);
      return ExitCode.Usage;
    case "skipped":
      io.stdout("dependencies not installed (--skip-install): run npm install\n");
      break;
    case "done":
      io.stdout("dependencies installed\n");
      break;
    case "not-needed":
      break;
  }
  io.stdout("next: themis plan\n");
  return ExitCode.Ok;
}
