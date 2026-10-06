import type { FileChange } from "../fs/generated.js";

export interface GuardSpec {
  /**
   * Project-relative POSIX paths agents must not modify. A trailing `/**` protects a whole
   * directory.
   */
  protectedPaths: readonly string[];
}

/** Thrown when existing agent configuration cannot be merged safely. */
export class GuardInstallError extends Error {
  override readonly name = "GuardInstallError";
}

/**
 * Installs agent-specific write protections. This is defense in depth: the verifier's guard
 * step is what actually enforces the contract, since an agent can always write files through
 * a shell.
 */
export interface GuardInstaller {
  /** Agent adapter name, e.g. `claude-code`. */
  readonly agent: string;
  /** Files this adapter writes, which must themselves be protected and locked. */
  readonly configFiles: readonly string[];
  installGuards(root: string, spec: GuardSpec): Promise<FileChange[]>;
}
