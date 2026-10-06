#!/usr/bin/env node
import { ExitCode } from "./io.js";
import { runCli } from "./run.js";

try {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
} catch (err) {
  // An unexpected exception is a bug in Ordito, never a problem with the user's spec, so it
  // must not surface as exit code 1 ("fix your input").
  process.stderr.write(
    `ordito: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = ExitCode.Usage;
}
