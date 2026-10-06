import { readFileSync } from "node:fs";
import { check } from "./commands/check.js";
import { type CliIo, ExitCode } from "./io.js";

const HELP = `Usage: ordito <command> [options]

Commands:
  check [spec]   Validate a spec file (default: spec.md)

Options:
  -h, --help     Show help
  -v, --version  Show version
`;

type Command = (args: string[], io: CliIo) => Promise<ExitCode>;

const COMMANDS: Record<string, Command> = { check };

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
    io.stderr(`ordito: unknown command "${name}"\n\n${HELP}`);
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
      io.stderr(`ordito ${name}: ${err.message}\n`);
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
