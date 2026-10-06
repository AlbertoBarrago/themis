import type { ExecResult, Executor } from "../runtime/executor.js";

/** Identity for commits Themis makes, so they are recognisable in history. */
const THEMIS_IDENTITY = ["-c", "user.name=Themis", "-c", "user.email=themis@localhost"];

export class GitError extends Error {
  override readonly name = "GitError";
}

export type MergeResult = { ok: true } | { ok: false; conflicts: string[]; output: string };

/**
 * The git operations the orchestrator needs, run through the executor so they happen where
 * the agents run (host or VM). Every method names its working directory explicitly: the main
 * tree and the task worktrees are different checkouts of the same repository.
 */
export class Git {
  readonly #executor: Executor;

  constructor(executor: Executor) {
    this.#executor = executor;
  }

  async #run(cwd: string, args: string[], allowFailure = false): Promise<ExecResult> {
    const result = await this.#executor.exec({
      command: "git",
      args: [...THEMIS_IDENTITY, ...args],
      cwd,
    });
    if (!allowFailure && result.exitCode !== 0) {
      throw new GitError(
        `git ${args.join(" ")} failed (${result.exitCode}): ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return result;
  }

  async topLevel(cwd: string): Promise<string | undefined> {
    const result = await this.#run(cwd, ["rev-parse", "--show-toplevel"], true);
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  /** Current branch, or `undefined` on a detached HEAD or an unborn branch. */
  async currentBranch(cwd: string): Promise<string | undefined> {
    const result = await this.#run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], true);
    if (result.exitCode !== 0) return undefined;
    const head = await this.#run(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], true);
    return head.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  async head(cwd: string): Promise<string> {
    return (await this.#run(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  }

  /** Paths with uncommitted changes, untracked files included, ignored files excluded. */
  async dirtyPaths(cwd: string): Promise<string[]> {
    const out = (await this.#run(cwd, ["status", "--porcelain", "--untracked-files=all"])).stdout;
    return out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => l.slice(3));
  }

  async isTracked(cwd: string, path: string): Promise<boolean> {
    return (await this.#run(cwd, ["ls-files", "--error-unmatch", "--", path], true)).exitCode === 0;
  }

  async branchExists(cwd: string, branch: string): Promise<boolean> {
    return (
      (await this.#run(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], true))
        .exitCode === 0
    );
  }

  /** True when `branch` is already contained in `into`. */
  async isMerged(cwd: string, branch: string, into: string): Promise<boolean> {
    return (
      (await this.#run(cwd, ["merge-base", "--is-ancestor", branch, into], true)).exitCode === 0
    );
  }

  /** Adds a worktree, creating `branch` from `base` unless it already exists. */
  async addWorktree(root: string, path: string, branch: string, base: string): Promise<void> {
    const args = (await this.branchExists(root, branch))
      ? ["worktree", "add", path, branch]
      : ["worktree", "add", "-b", branch, path, base];
    await this.#run(root, args);
  }

  async removeWorktree(root: string, path: string): Promise<void> {
    await this.#run(root, ["worktree", "remove", "--force", path]);
  }

  /** Commits every change in `cwd`; returns false when there was nothing to commit. */
  async commitAll(cwd: string, message: string): Promise<boolean> {
    await this.#run(cwd, ["add", "-A"]);
    const staged = await this.#run(cwd, ["diff", "--cached", "--quiet"], true);
    if (staged.exitCode === 0) return false;
    await this.#run(cwd, ["commit", "--no-verify", "-q", "-m", message]);
    return true;
  }

  async diff(cwd: string, from: string, to = "HEAD"): Promise<string> {
    return (await this.#run(cwd, ["diff", "--no-color", "--no-ext-diff", `${from}..${to}`])).stdout;
  }

  /** Changes on the current branch since it forked from `other` (three-dot diff). */
  async diffSince(cwd: string, other: string): Promise<string> {
    return (await this.#run(cwd, ["diff", "--no-color", "--no-ext-diff", `${other}...HEAD`]))
      .stdout;
  }

  /** Unified diff between two files, repository or not (`git diff --no-index`). */
  async diffFiles(cwd: string, a: string, b: string): Promise<string> {
    // Explicit prefixes: user settings such as diff.mnemonicPrefix would change the headers.
    const args = [
      "diff",
      "--no-index",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      a,
      b,
    ];
    const result = await this.#run(cwd, args, true);
    // --no-index exits 1 when the files differ.
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new GitError(
        `git ${args.join(" ")} failed (${result.exitCode}): ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return result.stdout;
  }

  async changedFiles(cwd: string, from: string, to = "HEAD"): Promise<string[]> {
    const out = (await this.#run(cwd, ["diff", "--name-only", `${from}..${to}`])).stdout;
    return out.split("\n").filter((l) => l !== "");
  }

  /** `git merge --no-ff`; on conflict the merge is aborted and the conflicting paths returned. */
  async merge(cwd: string, branch: string, message: string): Promise<MergeResult> {
    const result = await this.#run(
      cwd,
      ["merge", "--no-ff", "--no-edit", "-m", message, branch],
      true,
    );
    if (result.exitCode === 0) return { ok: true };
    const conflicts = (
      await this.#run(cwd, ["diff", "--name-only", "--diff-filter=U"], true)
    ).stdout
      .split("\n")
      .filter((l) => l !== "");
    await this.#run(cwd, ["merge", "--abort"], true);
    return { ok: false, conflicts, output: (result.stdout + result.stderr).trim() };
  }

  /**
   * Brings `branch` into the checkout at `cwd` (a task worktree), committing pending work first.
   * Unlike {@link merge}, a conflict is left in place for the worker to resolve: the next
   * {@link commitAll} completes the merge.
   */
  async syncWith(
    cwd: string,
    branch: string,
    message: string,
  ): Promise<{ kind: "up-to-date" | "merged" } | { kind: "conflict"; conflicts: string[] }> {
    if (await this.isMerged(cwd, branch, "HEAD")) return { kind: "up-to-date" };
    await this.commitAll(cwd, `${message} (pending work)`);
    const result = await this.#run(cwd, ["merge", "--no-edit", "-m", message, branch], true);
    if (result.exitCode === 0) return { kind: "merged" };
    const conflicts = (
      await this.#run(cwd, ["diff", "--name-only", "--diff-filter=U"], true)
    ).stdout
      .split("\n")
      .filter((l) => l !== "");
    if (conflicts.length === 0) {
      throw new GitError(
        `git merge ${branch} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return { kind: "conflict", conflicts };
  }

  /**
   * Undoes the merge commit Themis has just made. Only ever called right after a successful
   * {@link merge} on a tree Themis verified clean, so nothing else can be lost.
   */
  async undoLastMerge(cwd: string): Promise<void> {
    await this.#run(cwd, ["reset", "--hard", "-q", "ORIG_HEAD"]);
  }
}
