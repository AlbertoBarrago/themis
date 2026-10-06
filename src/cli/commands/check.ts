import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatDiagnostic, hasErrors } from "../../spec/diagnostics.js";
import { parseSpec } from "../../spec/parse.js";
import { type CliIo, ExitCode } from "../io.js";

export const CHECK_HELP = `Usage: ordito check [spec] [--json]

Validates a spec file against the Ordito format (default: spec.md).

Options:
  --json    Print diagnostics as JSON
  -h, --help
`;

/** `ordito check`: parse and validate a spec, printing every diagnostic. */
export async function check(args: string[], io: CliIo): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(CHECK_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 1) {
    io.stderr(`ordito check: expected at most one spec path\n\n${CHECK_HELP}`);
    return ExitCode.Usage;
  }

  const path = resolve(io.cwd, positionals[0] ?? "spec.md");
  // Relative paths are shorter to read, but only when the file is inside the working directory.
  const rel = relative(io.cwd, path);
  const display = rel === "" || rel.startsWith("..") ? path : rel;
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.stderr(`ordito check: cannot read ${display}: ${reason}\n`);
    return ExitCode.Usage;
  }

  const { spec, diagnostics } = parseSpec(source);
  const failed = hasErrors(diagnostics);

  if (values.json) {
    io.stdout(`${JSON.stringify({ file: display, valid: !failed, diagnostics }, null, 2)}\n`);
  } else {
    for (const d of diagnostics) io.stdout(`${formatDiagnostic(display, d)}\n`);
    if (spec !== undefined) {
      io.stdout(
        `${display}: valid (${plural(spec.criteria.length, "acceptance criterion", "acceptance criteria")}, ${plural(spec.decisions.length, "decision", "decisions")})\n`,
      );
    } else {
      const errors = diagnostics.filter((d) => d.severity === "error").length;
      io.stdout(`${display}: invalid (${plural(errors, "error", "errors")})\n`);
    }
  }
  return failed ? ExitCode.Invalid : ExitCode.Ok;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}
