import { ExecError, type ExecRequest, type ExecResult, type Executor } from "./executor.js";

const CHECK_TIMEOUT_MS = 30_000;

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

  /**
   * Status from `limactl list`, then a no-op command through the same path as real work: a VM
   * reported as running can still refuse SSH while it boots.
   */
  async check(cwd: string): Promise<string | undefined> {
    const vm = `Lima VM "${this.#instance}"`;
    let list: ExecResult;
    try {
      list = await this.#host.exec({
        command: this.#limactl,
        args: ["list", "--format", "{{.Status}}", this.#instance],
        cwd,
        timeoutMs: CHECK_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof ExecError && err.kind === "not-found")
        return "limactl is not installed: install Lima (https://lima-vm.io), then create the VM with scripts/lima/create-vm.sh";
      throw err;
    }
    const status = list.stdout.trim();
    if (list.exitCode !== 0 || status === "")
      return `${vm} does not exist: create it with scripts/lima/create-vm.sh, or name another instance with THEMIS_LIMA_INSTANCE`;
    if (status !== "Running")
      return `${vm} is ${status.toLowerCase()}: start it with limactl start ${this.#instance}`;

    const probe = await this.exec({ command: "true", args: [], cwd, timeoutMs: CHECK_TIMEOUT_MS });
    if (probe.exitCode === 0) return undefined;
    const detail = probe.timedOut
      ? "no answer within 30s"
      : (probe.stderr.trim().split("\n").at(-1) ?? `exit ${probe.exitCode}`);
    return (
      `${vm} is running but does not answer (still booting?): retry in a moment, or restart it ` +
      `with limactl stop ${this.#instance} && limactl start ${this.#instance} (${detail})`
    );
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
