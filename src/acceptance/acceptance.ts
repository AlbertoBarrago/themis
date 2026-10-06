import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRunner } from "../adapters/agent-runner.js";
import { hasBlocking } from "../agents/questions.js";
import { callStructured, type Totals } from "../agents/structured.js";
import { sha256 } from "../fs/digest.js";
import { isNotFound, readIfExists } from "../fs/generated.js";
import { loadSpec, readTasks, zodErrors } from "../plan/plan.js";
import type { TasksFile } from "../plan/schema.js";
import { ExecError, type Executor } from "../runtime/executor.js";
import type { Diagnostic } from "../spec/diagnostics.js";
import {
  ACCEPTANCE_DIR,
  contractFiles,
  LOCK_PATH,
  protectedPaths,
} from "../stack/node-ts/contract.js";
import { testAuthorPrompt } from "./prompt.js";
import {
  type GeneratedTestFile,
  type LockFile,
  TESTS_PATH,
  type TestsFile,
  testAuthorOutput,
  testAuthorOutputJsonSchema,
  testsFile,
} from "./schema.js";
import { validateTestFiles } from "./validate.js";

export const TEST_AUTHOR_INSTRUCTIONS = ".themis/agents/test-author.md";

/**
 * The test author returns every file in one structured answer: on the webhook example (6
 * criteria, ~1100 lines) a real run took 896 s, just under the adapter's 15-minute default.
 */
const TEST_AUTHOR_TIMEOUT_MS = 45 * 60 * 1000;

/** A `.themis/tests.json` that exists but cannot be used; never silently replaced. */
export class TestsFileError extends Error {
  override readonly name = "TestsFileError";
}

type SpecProblem =
  | { kind: "spec-unreadable"; message: string }
  | { kind: "invalid-spec"; diagnostics: Diagnostic[] };

/** Preconditions shared by both commands: a valid spec and a plan approved for it. */
type PlanProblem = { kind: "plan-not-approved" } | { kind: "spec-changed" };

export type GenerateOutcome =
  | { kind: "not-initialized"; message: string }
  | SpecProblem
  | PlanProblem
  | { kind: "contract-locked" }
  | { kind: "acceptance-not-empty"; files: string[] }
  | { kind: "agent-unavailable" | "agent-failed"; message: string; totals: Totals }
  | { kind: "invalid-tests"; errors: string[]; totals: Totals }
  | { kind: "done"; state: TestsFile; files: GeneratedTestFile[]; totals: Totals };

export interface GenerateOptions {
  root: string;
  specPath: string;
  /** Replace existing acceptance tests and remove the lock. */
  force: boolean;
  runner: AgentRunner;
  now?: () => Date;
}

/**
 * `themis tests`: asks the test-author agent for acceptance tests, validates them and writes
 * them under `tests/acceptance/` as a draft for the human gate (ADR 0011). Existing tests and
 * the lock are only removed with `force`, and only after a valid answer came back.
 */
export async function generateTests(options: GenerateOptions): Promise<GenerateOutcome> {
  const { root, specPath, runner } = options;
  const now = options.now ?? (() => new Date());

  const instructions = await readIfExists(join(root, TEST_AUTHOR_INSTRUCTIONS));
  if (instructions === undefined) {
    return {
      kind: "not-initialized",
      message: `${TEST_AUTHOR_INSTRUCTIONS} not found; run themis init first (or themis init again after upgrading)`,
    };
  }
  const loaded = await loadSpec(root, specPath);
  if (!loaded.ok) return loaded.outcome;
  const tasks = await readTasks(root);
  const planProblem = checkPlan(tasks, loaded.digest);
  if (planProblem !== undefined) return planProblem;
  if (tasks === undefined) return { kind: "plan-not-approved" };

  const existing = await listFiles(root, ACCEPTANCE_DIR);
  if (!options.force) {
    if ((await readIfExists(join(root, LOCK_PATH))) !== undefined)
      return { kind: "contract-locked" };
    if (existing.length > 0) return { kind: "acceptance-not-empty", files: existing };
  }

  const { spec, source, digest } = loaded;
  const outcome = await callStructured({
    runner,
    root,
    logDir: "tests",
    now,
    invocation: (rejected) => ({
      role: "test-author",
      tier: spec.frontmatter.models.planner,
      cwd: root,
      instructions,
      prompt: testAuthorPrompt(specPath, source, tasks, rejected),
      tools: "read-only",
      protectedPaths: protectedPaths(specPath),
      outputSchema: testAuthorOutputJsonSchema,
      timeoutMs: TEST_AUTHOR_TIMEOUT_MS,
    }),
    validate: (structured) => {
      const parsed = testAuthorOutput.safeParse(structured);
      if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
      const errors = validateTestFiles(spec, parsed.data.files);
      return errors.length === 0 ? { ok: true, value: parsed.data } : { ok: false, errors };
    },
  });

  switch (outcome.kind) {
    case "unavailable":
      return { kind: "agent-unavailable", message: outcome.message, totals: outcome.totals };
    case "failed":
      return { kind: "agent-failed", message: outcome.message, totals: outcome.totals };
    case "invalid":
      return { kind: "invalid-tests", errors: outcome.errors, totals: outcome.totals };
    case "ok":
      break;
  }

  // --force: the user asked to replace the contract. Unlock and clear only now that a valid
  // replacement exists, so a failed regeneration never leaves the project without tests.
  if (options.force) {
    await rm(join(root, LOCK_PATH), { force: true });
    await rm(join(root, ACCEPTANCE_DIR), { recursive: true, force: true });
  }
  for (const file of outcome.value.files) {
    await mkdir(dirname(join(root, file.path)), { recursive: true });
    await writeFile(join(root, file.path), file.content);
  }
  const state: TestsFile = {
    themis: "0.1",
    spec: specPath,
    specDigest: digest,
    status: "draft",
    createdAt: now().toISOString(),
    approvedAt: null,
    files: outcome.value.files.map((f) => f.path).sort(),
    questions: outcome.value.questions,
  };
  await writeState(root, state);
  return { kind: "done", state, files: outcome.value.files, totals: outcome.totals };
}

export type ApproveTestsOutcome =
  | { kind: "no-tests" }
  | SpecProblem
  | PlanProblem
  | { kind: "invalid-tests"; errors: string[] }
  | { kind: "blocked"; state: TestsFile }
  | { kind: "missing-contract-file"; path: string }
  | { kind: "already-approved"; state: TestsFile }
  | { kind: "approved"; state: TestsFile; lock: LockFile };

export interface ApproveTestsOptions {
  root: string;
  executor: Executor;
  /** Agent configuration files to lock too (e.g. `.claude/settings.json`), when present. */
  agentConfigFiles: readonly string[];
  /** Approve despite blocking questions. */
  force?: boolean;
  now?: () => Date;
}

/**
 * `themis approve tests`: the gate that turns the tests into the contract. Re-validates the
 * files on disk (the human may have edited them), then records the digests in `lock.json`.
 */
export async function approveTests(options: ApproveTestsOptions): Promise<ApproveTestsOutcome> {
  const { root } = options;
  const now = options.now ?? (() => new Date());
  const state = await readState(root);
  if (state === undefined) return { kind: "no-tests" };
  const locked = (await readIfExists(join(root, LOCK_PATH))) !== undefined;
  if (state.status === "approved" && locked) return { kind: "already-approved", state };

  const loaded = await loadSpec(root, state.spec);
  if (!loaded.ok) return loaded.outcome;
  if (loaded.digest !== state.specDigest) return { kind: "spec-changed" };
  const planProblem = checkPlan(await readTasks(root), loaded.digest);
  if (planProblem !== undefined) return planProblem;

  const paths = await listFiles(root, ACCEPTANCE_DIR);
  const files = await Promise.all(
    paths.map(async (path) => ({ path, content: await readFile(join(root, path), "utf8") })),
  );
  const errors = validateTestFiles(loaded.spec, files);
  if (errors.length > 0) return { kind: "invalid-tests", errors };
  if (!options.force && hasBlocking(state.questions)) return { kind: "blocked", state };

  const { required, optional } = contractFiles(state.spec);
  const digests: Record<string, string> = {};
  for (const path of [...paths, ...required, ...optional, ...options.agentConfigFiles]) {
    let content: Buffer;
    try {
      content = await readFile(join(root, path));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      if (required.includes(path)) return { kind: "missing-contract-file", path };
      continue;
    }
    digests[path] = sha256(content);
  }

  const lock: LockFile = {
    themis: "0.1",
    lockedAt: now().toISOString(),
    base: await headCommit(options.executor, root),
    dirs: [ACCEPTANCE_DIR],
    files: Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b))),
  };
  await writeFile(join(root, LOCK_PATH), `${JSON.stringify(lock, null, 2)}\n`);
  const approved: TestsFile = {
    ...state,
    status: "approved",
    approvedAt: now().toISOString(),
    files: paths,
  };
  await writeState(root, approved);
  return { kind: "approved", state: approved, lock };
}

function checkPlan(tasks: TasksFile | undefined, specDigest: string): PlanProblem | undefined {
  if (tasks === undefined || tasks.status !== "approved") return { kind: "plan-not-approved" };
  if (tasks.specDigest !== specDigest) return { kind: "spec-changed" };
  return undefined;
}

/** Files under `dir`, recursively, as sorted project-relative POSIX paths. */
async function listFiles(root: string, dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
  return entries
    .filter((e) => e.isFile())
    .map((e) =>
      `${dir}/${join(e.parentPath, e.name).slice(join(root, dir).length + 1)}`.replaceAll(
        "\\",
        "/",
      ),
    )
    .sort();
}

/**
 * The commit the guard diffs against for forbidden markers. `null` (full scan instead) when
 * the folder is not a git repository or has no commit yet.
 */
async function headCommit(executor: Executor, root: string): Promise<string | null> {
  try {
    const result = await executor.exec({
      command: "git",
      args: ["rev-parse", "--verify", "HEAD"],
      cwd: root,
    });
    const sha = result.stdout.trim();
    return result.exitCode === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch (err) {
    if (err instanceof ExecError && err.kind === "not-found") return null;
    throw err;
  }
}

export async function readState(root: string): Promise<TestsFile | undefined> {
  const source = await readIfExists(join(root, TESTS_PATH));
  if (source === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new TestsFileError(
      `${TESTS_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = testsFile.safeParse(data);
  if (!parsed.success)
    throw new TestsFileError(
      `${TESTS_PATH} is invalid: ${zodErrors(parsed.error)[0] ?? "unknown"}`,
    );
  return parsed.data;
}

async function writeState(root: string, state: TestsFile): Promise<void> {
  await writeFile(join(root, TESTS_PATH), `${JSON.stringify(state, null, 2)}\n`);
}
