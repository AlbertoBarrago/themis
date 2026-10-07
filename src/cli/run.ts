import { readFileSync } from "node:fs";
import { approveCommand } from "./commands/approve.js";
import { check } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { newCommand } from "./commands/new.js";
import { planCommand } from "./commands/plan.js";
import { retroCommand } from "./commands/retro.js";
import { runCommand } from "./commands/run.js";
import { statusCommand } from "./commands/status.js";
import { testsCommand } from "./commands/tests.js";
import { type CliIo, ExitCode } from "./io.js";

const HELP = `Usage: themis <command> [options]

Commands:
  new [spec]     Write a spec skeleton to fill in, with a short wizard in a terminal
  check [spec]   Validate a spec file (default: spec.md)
  init           Prepare the project: verifier, guard, agent roles, protections
  plan           Ask the planner for a task graph (draft .themis/tasks.json)
  approve plan   Approve the draft plan (human gate)
  tests          Ask the test author for acceptance tests (draft tests/acceptance/)
  approve tests  Approve the tests and lock the contract (human gate)
  run [task]     Run the task graph, or one task (--executor lima for the VM)
  status         Show the gates and the state of every task
  retro          Ask the retro agent for changes to the agents' instructions
  approve retro  Apply the proposed changes (human gate)

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

type Command = (args: string[], io: CliIo) => Promise<ExitCode>;

const COMMANDS: Record<string, Command> = {
  new: (args, io) => newCommand(args, io),
  check,
  init: (args, io) => initCommand(args, io),
  plan: (args, io) => planCommand(args, io),
  tests: (args, io) => testsCommand(args, io),
  approve: (args, io) => approveCommand(args, io),
  run: (args, io) => runCommand(args, io),
  status: (args, io) => statusCommand(args, io),
  retro: (args, io) => retroCommand(args, io),
};

/** Dispatches a command line (without the node and script arguments) and returns the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<ExitCode> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "-h" || name === "--help" || name === "help") {
    io.stdout(HELP);
    return name === undefined ? ExitCode.Usage : ExitCode.Ok;
  }
  if (name === "-v" || name === "--version") {
    io.stdout(`${readVersion()}\n`);
    return ExitCode.Ok;
  }
  const command = COMMANDS[name];
  if (command === undefined) {
    io.stderr(`themis: unknown command "${name}"\n\n${HELP}`);
    return ExitCode.Usage;
  }
  try {
    return await command(rest, io);
  } catch (err) {
    // parseArgs throws TypeError with a code for unknown or malformed options.
    if (
      err instanceof TypeError &&
      "code" in err &&
      String(err.code).startsWith("ERR_PARSE_ARGS")
    ) {
      io.stderr(`themis ${name}: ${err.message}\n`);
      return ExitCode.Usage;
    }
    throw err;
  }
}

function readVersion(): string {
  // Both src/cli and dist/cli sit two levels below the package root.
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  );
  return typeof pkg === "object" && pkg !== null && "version" in pkg
    ? String(pkg.version)
    : "unknown";
}
