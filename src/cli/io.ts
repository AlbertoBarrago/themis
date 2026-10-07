/** Process boundary for commands, injected so tests never touch the real process. */
export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /**
   * Asks the user one question and resolves with the answer, or `undefined` when input ended
   * (Ctrl+C, Ctrl+D). Absent when there is no interactive terminal: commands must then fall back
   * to non-interactive behavior instead of waiting on input that never comes.
   */
  prompt?: (question: string) => Promise<string | undefined>;
}

/**
 * CLI exit codes. They intentionally mirror the verifier contract: `1` means the input
 * (the spec) is wrong and can be fixed, `2` means the invocation or environment is broken.
 */
export const ExitCode = {
  Ok: 0,
  Invalid: 1,
  Usage: 2,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
