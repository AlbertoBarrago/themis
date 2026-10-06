import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type FileStatus = "created" | "updated" | "unchanged" | "skipped";

/** What happened to one generated file, reported back to the user by `init`. */
export interface FileChange {
  /** Project-relative POSIX path. */
  path: string;
  status: FileStatus;
  /** Why a file was skipped. */
  reason?: string;
}

export interface WriteOptions {
  /** Overwrite a file whose content differs. */
  force: boolean;
  /** File mode, e.g. `0o755` for scripts. */
  mode?: number;
}

/**
 * Writes a file Themis owns, idempotently: identical content is left alone and different
 * content is only replaced with `force`, so re-running `init` never clobbers local edits
 * silently.
 */
export async function writeGenerated(
  root: string,
  path: string,
  content: string,
  options: WriteOptions,
): Promise<FileChange> {
  const absolute = join(root, path);
  const existing = await readIfExists(absolute);
  if (existing === content) return { path, status: "unchanged" };
  if (existing !== undefined && !options.force) {
    return { path, status: "skipped", reason: "exists with different content (use --force)" };
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  if (options.mode !== undefined) await chmod(absolute, options.mode);
  return { path, status: existing === undefined ? "created" : "updated" };
}

/** Returns `undefined` only when the file does not exist; any other I/O error propagates. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw err;
  }
}

export function isNotFound(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ENOENT";
}
