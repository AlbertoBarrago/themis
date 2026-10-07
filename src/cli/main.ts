#!/usr/bin/env node
import { createInterface, type Interface } from "node:readline";
import { ExitCode } from "./io.js";
import { runCli } from "./run.js";

const terminal = process.stdin.isTTY ? ttyPrompter() : undefined;
try {
  process.exitCode = await runCli(process.argv.slice(2), {
    cwd: process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    ...(terminal === undefined ? {} : { prompt: terminal.prompt }),
  });
} catch (err) {
  // An unexpected exception is a bug in Themis, never a problem with the user's spec, so it
  // must not surface as exit code 1 ("fix your input").
  process.stderr.write(
    `themis: internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exitCode = ExitCode.Usage;
} finally {
  terminal?.close();
}

/**
 * Line-by-line prompts on the terminal. A single readline interface, opened on the first
 * question, queues every line it reads: pasted answers arrive in one chunk, and readline emits
 * the extra lines while no question is pending, so `question()` alone would drop them. Ctrl+C
 * and Ctrl+D close the interface, which answers every pending and later prompt with `undefined`.
 */
function ttyPrompter(): {
  prompt: (question: string) => Promise<string | undefined>;
  close: () => void;
} {
  let rl: Interface | undefined;
  let closed = false;
  const lines: string[] = [];
  const waiting: Array<(line: string | undefined) => void> = [];

  const open = (): Interface => {
    const created = createInterface({ input: process.stdin, output: process.stdout });
    created.on("line", (line) => {
      const next = waiting.shift();
      if (next === undefined) lines.push(line);
      else next(line);
    });
    created.on("SIGINT", () => created.close());
    created.on("close", () => {
      if (waiting.length > 0) process.stdout.write("\n");
      closed = true;
      for (const next of waiting.splice(0)) next(undefined);
    });
    return created;
  };

  return {
    prompt: (question) => {
      const queued = lines.shift();
      if (queued !== undefined) {
        // Pasted ahead of the question: show the pair so the transcript reads like typed input.
        process.stdout.write(`${question}${queued}\n`);
        return Promise.resolve(queued);
      }
      if (closed) return Promise.resolve(undefined);
      rl ??= open();
      rl.setPrompt(question);
      rl.prompt();
      return new Promise((resolve) => waiting.push(resolve));
    },
    // Without this, the open interface would keep the process alive after the command returns.
    close: () => rl?.close(),
  };
}
