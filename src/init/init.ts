import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { GuardInstallError, type GuardInstaller } from "../adapters/guard-installer.js";
import { type FileChange, isNotFound, readIfExists, writeGenerated } from "../fs/generated.js";
import { ExecError, type Executor } from "../runtime/executor.js";
import { LOCAL_CONFIG_PATH, type LocalConfig, renderLocalConfig } from "../runtime/local-config.js";
import type { ExecutorName } from "../runtime/select.js";
import type { Diagnostic } from "../spec/diagnostics.js";
import { parseSpec } from "../spec/parse.js";
import { protectedPaths } from "../stack/node-ts/contract.js";
import { detectNodeTs } from "../stack/node-ts/detect.js";
import {
  type GeneratedFile,
  gitignoreEntries,
  scaffoldFiles,
  themisFiles,
} from "../stack/node-ts/files.js";

export interface InitOptions {
  root: string;
  /** Project-relative POSIX path of the spec. */
  specPath: string;
  force: boolean;
  /** Run `npm install` when needed. */
  install: boolean;
  guards: GuardInstaller;
  executor: Executor;
  /** Name of `executor`, recorded in `.themis/local.json`. */
  executorName: ExecutorName;
  /** What a previous `init` recorded, if anything. */
  recorded: LocalConfig | undefined;
}

export type InitOutcome =
  | { kind: "spec-unreadable"; message: string }
  | { kind: "invalid-spec"; diagnostics: Diagnostic[] }
  | { kind: "incompatible"; problems: string[] }
  | { kind: "guard-error"; message: string }
  | { kind: "executor-mismatch"; recorded: ExecutorName; requested: ExecutorName }
  | {
      kind: "done";
      scaffolded: boolean;
      changes: FileChange[];
      /** Spec warnings (never errors: those end in `invalid-spec`). */
      diagnostics: Diagnostic[];
      warnings: string[];
      install: InstallOutcome;
    };

export type InstallOutcome =
  | { kind: "not-needed" }
  | { kind: "skipped" }
  | { kind: "done" }
  | { kind: "failed"; message: string };

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const GITIGNORE_HEADER = "# Themis";

/**
 * `themis init` for the node-ts stack: validates the spec, scaffolds an empty directory or
 * checks an existing project, then writes the verifier, guard, agent roles and protections.
 *
 * Nothing is written before the spec and the project have been validated, and agent
 * protections are merged first, so a refusal leaves the directory untouched.
 */
export async function init(options: InitOptions): Promise<InitOutcome> {
  const { root, force } = options;

  let source: string;
  try {
    source = await readFile(join(root, options.specPath), "utf8");
  } catch (err) {
    return {
      kind: "spec-unreadable",
      message: isNotFound(err)
        ? `${options.specPath} not found; write a spec first (see SPEC_FORMAT.md)`
        : `cannot read ${options.specPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const { spec, diagnostics } = parseSpec(source);
  if (spec === undefined) return { kind: "invalid-spec", diagnostics };

  const detection = await detectNodeTs(root, spec.frontmatter.verify);
  if (detection.kind === "incompatible")
    return { kind: "incompatible", problems: detection.problems };
  const scaffolded = detection.kind === "empty";
  // Installed dependencies hold native binaries for the executor that installed them.
  if (
    detection.kind === "node-ts" &&
    detection.hasNodeModules &&
    options.recorded !== undefined &&
    options.recorded.executor !== options.executorName
  )
    return {
      kind: "executor-mismatch",
      recorded: options.recorded.executor,
      requested: options.executorName,
    };

  const changes: FileChange[] = [];
  try {
    changes.push(
      ...(await options.guards.installGuards(root, {
        protectedPaths: protectedPaths(options.specPath),
      })),
    );
  } catch (err) {
    if (err instanceof GuardInstallError) return { kind: "guard-error", message: err.message };
    throw err;
  }

  const files: GeneratedFile[] = [
    ...(scaffolded ? await scaffoldFiles(root) : []),
    ...(await themisFiles(spec.frontmatter)),
  ];
  for (const file of files) {
    const writeOptions = file.mode === undefined ? { force } : { force, mode: file.mode };
    changes.push(await writeGenerated(root, file.path, file.content, writeOptions));
  }
  changes.push(
    await writeGenerated(
      root,
      LOCAL_CONFIG_PATH,
      renderLocalConfig({ executor: options.executorName }),
      // Always current: a conflicting record was refused above, or has no node_modules behind it.
      { force: true },
    ),
  );
  changes.push(await mergeGitignore(root, await gitignoreEntries()));

  const warnings = changes
    .filter((c) => c.status === "skipped")
    .map((c) => `${c.path} was not updated: ${c.reason ?? "skipped"}`);
  if (!(await isGitRepository(options.executor, root))) {
    warnings.push("not a git repository: `themis run` needs git for worktrees and the guard diff");
  }

  const needsInstall = scaffolded || (detection.kind === "node-ts" && !detection.hasNodeModules);
  let install: InstallOutcome = { kind: "not-needed" };
  if (needsInstall) {
    install = options.install ? await npmInstall(options.executor, root) : { kind: "skipped" };
  }

  return { kind: "done", scaffolded, changes, diagnostics, warnings, install };
}

/** Appends missing entries under an `# Themis` header, never reordering existing lines. */
async function mergeGitignore(root: string, entries: string[]): Promise<FileChange> {
  const path = ".gitignore";
  const existing = await readIfExists(join(root, path));
  const present = new Set((existing ?? "").split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !present.has(e));
  if (missing.length === 0) return { path, status: "unchanged" };

  const prefix =
    existing === undefined || existing === ""
      ? ""
      : existing.endsWith("\n")
        ? existing
        : `${existing}\n`;
  const header = present.has(GITIGNORE_HEADER)
    ? ""
    : `${prefix === "" ? "" : "\n"}${GITIGNORE_HEADER}\n`;
  await writeFile(join(root, path), `${prefix}${header}${missing.join("\n")}\n`);
  return { path, status: existing === undefined ? "created" : "updated" };
}

async function isGitRepository(executor: Executor, root: string): Promise<boolean> {
  try {
    const result = await executor.exec({
      command: "git",
      args: ["rev-parse", "--is-inside-work-tree"],
      cwd: root,
    });
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch (err) {
    // Without git the answer is simply "no"; anything else is unexpected.
    if (err instanceof ExecError && err.kind === "not-found") return false;
    throw err;
  }
}

async function npmInstall(executor: Executor, root: string): Promise<InstallOutcome> {
  try {
    const result = await executor.exec({
      command: "npm",
      args: ["install", "--no-audit", "--no-fund"],
      cwd: root,
      timeoutMs: INSTALL_TIMEOUT_MS,
    });
    if (result.exitCode === 0) return { kind: "done" };
    const reason = result.timedOut
      ? "timed out"
      : `exited with ${result.exitCode ?? result.signal}`;
    const tail = result.stderr.trim().split("\n").slice(-20).join("\n");
    return { kind: "failed", message: `npm install ${reason}${tail === "" ? "" : `\n${tail}`}` };
  } catch (err) {
    if (err instanceof ExecError) return { kind: "failed", message: err.message };
    throw err;
  }
}
