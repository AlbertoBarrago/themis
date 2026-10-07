/** A single command execution. Commands are never run through a shell. */
export interface ExecRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  /** Merged over the executor's base environment. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  stdin?: string;
}

export interface ExecResult {
  /** `null` when the process was terminated by a signal. */
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export type ExecErrorKind = "not-found" | "spawn-failed";

/**
 * Raised only when the command could not be started at all. A command that starts and exits
 * non-zero is a normal {@link ExecResult}, because for the verifier loop a failing command is
 * information, not an exceptional condition.
 */
export class ExecError extends Error {
  readonly kind: ExecErrorKind;
  readonly command: string;

  constructor(kind: ExecErrorKind, command: string, options?: { cause?: unknown }) {
    super(
      kind === "not-found" ? `command not found: ${command}` : `could not start: ${command}`,
      options,
    );
    this.name = "ExecError";
    this.kind = kind;
    this.command = command;
  }
}

/**
 * Boundary for every process Themis starts, including agent CLIs. Implementations decide
 * where commands run (the local machine today, a sandbox later); callers must not assume
 * anything else about the host.
 */
export interface Executor {
  exec(request: ExecRequest): Promise<ExecResult>;
  /**
   * Returns why commands cannot run right now, with what to do about it, or `undefined` when
   * they can. Commands call it before any work, so an unreachable sandbox is reported once and
   * clearly instead of as the failure of whatever command happened to run first. Executors
   * that are always available omit it.
   */
  check?(cwd: string): Promise<string | undefined>;
}
