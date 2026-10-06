import { spawn } from "node:child_process";
import { ExecError, type ExecRequest, type ExecResult, type Executor } from "./executor.js";

export interface LocalExecutorOptions {
  /** Base environment; defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Time between SIGTERM and SIGKILL after a timeout. */
  killGraceMs?: number;
  /** Per-stream cap; older output is dropped first, since failures show up at the end. */
  maxOutputBytes?: number;
}

const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** Runs commands as child processes of the current Node process. */
export class LocalExecutor implements Executor {
  readonly #env: NodeJS.ProcessEnv;
  readonly #killGraceMs: number;
  readonly #maxOutputBytes: number;

  constructor(options: LocalExecutorOptions = {}) {
    this.#env = options.env ?? process.env;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...this.#env, ...request.env },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = new TailBuffer(this.#maxOutputBytes);
      const stderr = new TailBuffer(this.#maxOutputBytes);
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;

      const timeout =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              child.kill("SIGTERM");
              killTimer = setTimeout(() => child.kill("SIGKILL"), this.#killGraceMs);
            }, request.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      child.on("error", (err: NodeJS.ErrnoException) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        reject(
          new ExecError(err.code === "ENOENT" ? "not-found" : "spawn-failed", request.command, {
            cause: err,
          }),
        );
      });

      child.on("close", (exitCode, signal) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        resolve({
          exitCode,
          signal,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
          timedOut,
          durationMs: Math.round(performance.now() - started),
        });
      });

      // A child that exits without reading stdin closes the pipe; that is not our error.
      child.stdin.on("error", () => {});
      child.stdin.end(request.stdin ?? "");
    });
  }
}

/** Keeps the last `limit` bytes written to it. */
class TailBuffer {
  readonly #limit: number;
  #chunks: Buffer[] = [];
  #size = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.#limit && this.#chunks.length > 1) {
      this.#size -= this.#chunks.shift()?.length ?? 0;
    }
  }

  toString(): string {
    const all = Buffer.concat(this.#chunks);
    return all.subarray(Math.max(0, all.length - this.#limit)).toString("utf8");
  }
}
