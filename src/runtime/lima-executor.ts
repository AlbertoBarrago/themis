import type { ExecRequest, ExecResult, Executor } from "./executor.js";

export interface LimaExecutorOptions {
  /** Executor that runs `limactl` on the host. */
  host: Executor;
  instance: string;
  /** `limactl` executable; defaults to `limactl`. */
  limactl?: string;
}

/**
 * Runs every command inside a Lima VM (ADR 0013). Lima mounts host directories at the same
 * path in the guest, so `cwd` is passed through unchanged.
 *
 * Commands go through a login shell so the guest profile's PATH applies (Claude Code installs
 * to `~/.local/bin`). The command and its arguments are passed as positional parameters of
 * `exec "$@"`, never interpolated into the script, so they need no shell quoting by Themis.
 */
export class LimaExecutor implements Executor {
  readonly #host: Executor;
  readonly #instance: string;
  readonly #limactl: string;

  constructor(options: LimaExecutorOptions) {
    this.#host = options.host;
    this.#instance = options.instance;
    this.#limactl = options.limactl ?? "limactl";
  }

  exec(request: ExecRequest): Promise<ExecResult> {
    const env = Object.entries(request.env ?? {}).map(([key, value]) => `${key}=${value}`);
    const inner: ExecRequest = {
      command: this.#limactl,
      args: [
        "shell",
        "--tty=false",
        "--workdir",
        request.cwd,
        this.#instance,
        "--",
        "env",
        ...env,
        "bash",
        "-lc",
        'exec "$@"',
        "themis",
        request.command,
        ...request.args,
      ],
      cwd: request.cwd,
    };
    if (request.timeoutMs !== undefined) inner.timeoutMs = request.timeoutMs;
    if (request.stdin !== undefined) inner.stdin = request.stdin;
    return this.#host.exec(inner);
  }
}
