import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { approveTests, generateTests } from "../../src/acceptance/acceptance.js";
import type { AgentInvocation, AgentResult } from "../../src/adapters/agent-runner.js";
import { initCommand } from "../../src/cli/commands/init.js";
import { runCommand } from "../../src/cli/commands/run.js";
import { approvePlan, plan } from "../../src/plan/plan.js";
import { type RunEvent, run } from "../../src/run/run.js";
import { FakeAgentRunner, structured } from "../fakes/agent-runner.js";
import { FakeExecutor } from "../fakes/executor.js";
import { GitRouter } from "../fakes/router.js";
import { lines } from "../helpers.js";

const SPEC = lines(
  "---",
  "themis: 0.1",
  "stack: node-ts",
  "verify: [typecheck, acceptance]",
  "limits: { max_iterations: 3, parallel: 2 }",
  "---",
  "# S",
  "## Decisions",
  "- Each task writes src/<task>.ts.",
  "## AC-1 One",
  "Depends: none",
  "- Then one",
  "## AC-2 Two",
  "Depends: AC-1",
  "- Then two",
  "## AC-3 Three",
  "Depends: none",
  "- Then three",
);
const PLAN = {
  tasks: ["AC-1", "AC-2", "AC-3"].map((id) => ({
    id,
    title: id,
    scope: `Does ${id}.`,
    dependsOn: id === "AC-2" ? ["AC-1"] : [],
    addedDependencies: [],
  })),
  questions: [{ text: "Which quote style?", severity: "minor" }],
};
const TESTS = {
  files: ["AC-1", "AC-2", "AC-3"].map((id) => ({
    path: `tests/acceptance/${id.toLowerCase()}.test.ts`,
    content: `describe("${id}: ${id}", () => {});\n`,
  })),
  questions: [],
};

let root: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

/** Worker that writes src/<task>.ts in its worktree, optionally with given content. */
function worker(content?: string, choices: Array<{ question: string; decision: string }> = []) {
  return (inv: AgentInvocation): AgentResult => {
    const task = /Implement task (\S+)/.exec(inv.prompt)?.[1] ?? "x";
    mkdirSync(join(inv.cwd, "src"), { recursive: true });
    writeFileSync(
      join(inv.cwd, "src", `${task}.ts`),
      content ?? `export const ${task.replace("-", "")} = 1;\n`,
    );
    return structured({ summary: "ok", choices }, 0.1);
  };
}
const approve = () => structured({ verdict: "approve", reasons: [] }, 0.05);
const changes = (...reasons: string[]) => structured({ verdict: "changes", reasons }, 0.05);

type WorkerReply = AgentResult | ((inv: AgentInvocation) => AgentResult | Promise<AgentResult>);

/** Waits until `task` is done in the state file, so a test can order parallel tasks. */
async function untilDone(task: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const source = await readFile(join(root, ".themis/state.json"), "utf8").catch(() => "{}");
    if (JSON.parse(source).tasks?.[task]?.status === "done") return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${task} never finished`);
}

/** Routes worker and reviewer calls; replies are queued per role, or per task with a map. */
function agents(workers: WorkerReply[] | Record<string, WorkerReply[]>, reviews: AgentResult[]) {
  const byTask = Array.isArray(workers)
    ? undefined
    : Object.fromEntries(Object.entries(workers).map(([k, v]) => [k, [...v]]));
  const w = Array.isArray(workers) ? [...workers] : [];
  const total = Array.isArray(workers) ? workers.length : Object.values(workers).flat().length;
  const r = [...reviews];
  const invocations: AgentInvocation[] = [];
  const runner = new FakeAgentRunner(
    Array.from({ length: total + reviews.length }, () => (inv: AgentInvocation) => {
      invocations.push(inv);
      const task = /task (AC-\d+|setup)/.exec(inv.prompt)?.[1] ?? "";
      const next = inv.role === "worker" ? (byTask?.[task] ?? w).shift() : r.shift();
      if (next === undefined) throw new Error(`no scripted ${inv.role} reply for ${task}`);
      return typeof next === "function" ? next(inv) : next;
    }),
  );
  return { runner, invocations };
}

/**
 * Verifier fake: exit codes queued separately for the main tree and the worktrees, or per task
 * worktree (`perTask`) when parallel tasks must be told apart.
 */
function executor(
  options: { worktree?: number[]; main?: number[]; perTask?: Record<string, number[]> } = {},
) {
  const wt = [...(options.worktree ?? [])];
  const main = [...(options.main ?? [])];
  const perTask = Object.fromEntries(
    Object.entries(options.perTask ?? {}).map(([k, v]) => [k, [...v]]),
  );
  const verifyCalls: Array<{ cwd: string; args: readonly string[] }> = [];
  const router = new GitRouter({
    npm: (req) => {
      mkdirSync(join(req.cwd, "node_modules"), { recursive: true });
      writeFileSync(join(req.cwd, "node_modules/.package-lock.json"), "{}");
      return {};
    },
    ".themis/verify.sh": (req) => {
      verifyCalls.push({ cwd: req.cwd, args: req.args });
      const task = req.cwd.split("/").at(-1) ?? "";
      const exit = (req.cwd === root ? main.shift() : (perTask[task] ?? wt).shift()) ?? 0;
      if (exit !== 0)
        writeFileSync(join(req.cwd, ".verify.log"), `step: typecheck\nexit: ${exit}\n`);
      return { exitCode: exit };
    },
  });
  return { router, verifyCalls };
}

async function go(exec: GitRouter, runner: FakeAgentRunner, task?: string, events?: RunEvent[]) {
  return run({
    root,
    specPath: "spec.md",
    runner,
    executor: exec,
    ...(task === undefined ? {} : { task }),
    ...(events === undefined ? {} : { onEvent: (e: RunEvent) => events.push(e) }),
  });
}

const state = async () => JSON.parse(await readFile(join(root, ".themis/state.json"), "utf8"));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "themis-run-"));
  await writeFile(join(root, "spec.md"), SPEC);
  const quiet = { cwd: root, stdout: () => {}, stderr: () => {} };
  await initCommand(
    ["--skip-install"],
    quiet,
    new FakeExecutor({ git: () => ({ stdout: "true\n" }) }),
  );
  await plan({
    root,
    specPath: "spec.md",
    force: false,
    runner: new FakeAgentRunner([structured(PLAN)]),
  });
  await approvePlan(root);
  await generateTests({
    root,
    specPath: "spec.md",
    force: false,
    runner: new FakeAgentRunner([structured(TESTS)]),
  });
  await approveTests({ root, executor: new FakeExecutor(), agentConfigFiles: [] });
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "node_modules"));
  git(root, "add", "-A");
  git(root, "commit", "-qm", "contract");
});

describe("preconditions", () => {
  it("requires a clean, committed working tree", async () => {
    await writeFile(join(root, "notes.txt"), "wip");
    const outcome = await go(executor().router, new FakeAgentRunner([]));
    expect(outcome).toMatchObject({
      kind: "git-not-ready",
      commands: ["git add -A", 'git commit -m "themis contract"'],
    });
  });
});

describe("run", () => {
  it("runs a task in its worktree, reviews the diff, merges and verifies the branch", async () => {
    const { runner, invocations } = agents([worker()], [approve()]);
    const { router, verifyCalls } = executor();
    const events: RunEvent[] = [];
    const outcome = await go(router, runner, "AC-1", events);
    expect(outcome).toMatchObject({ kind: "finished", ran: ["AC-1"] });
    expect((await state()).tasks["AC-1"]).toMatchObject({
      status: "done",
      iterations: [{ iteration: 1, verifyExit: 0, review: { verdict: "approve", costUsd: 0.05 } }],
    });

    const wt = join(root, ".themis/worktrees/AC-1");
    expect(invocations[0]).toMatchObject({ role: "worker", cwd: wt, tools: "edit" });
    expect(invocations[0]?.prompt).toContain("Implement only what task AC-1 requires");
    expect(invocations[1]).toMatchObject({
      role: "reviewer",
      cwd: wt,
      tools: "read-only",
      tier: "strong",
    });
    expect(invocations[1]?.prompt).toContain("+export const AC1 = 1;");
    expect(verifyCalls).toEqual([
      { cwd: wt, args: ["AC-1"] },
      { cwd: root, args: ["AC-1"] },
    ]);
    expect(existsSync(join(root, "src/AC-1.ts"))).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(git(root, "log", "--first-parent", "--format=%s")).toBe("themis: merge AC-1\ncontract");
    expect(git(root, "log", "-1", "--format=%s", "HEAD^2")).toBe("themis: AC-1 iteration 1");
    expect(git(root, "log", "-1", "--format=%an <%ae>", "HEAD^2")).toBe(
      "Themis <themis@localhost>",
    );
    expect(events.map((e) => e.type)).toEqual([
      "task-start",
      "iteration-start",
      "worker-done",
      "verify-done",
      "review-done",
      "merged",
      "task-end",
    ]);
  });

  it("sends review changes back to the worker, consuming an iteration", async () => {
    const { runner, invocations } = agents(
      [worker("bad\n"), worker()],
      [changes("Out of scope: implements AC-2."), approve()],
    );
    await go(executor().router, runner, "AC-1");
    expect(invocations[2]?.prompt).toContain(
      "The reviewer asked for changes to your previous iteration:\n- Out of scope: implements AC-2.",
    );
    expect(
      (await state()).tasks["AC-1"].iterations.map(
        (i: { review?: { verdict: string } }) => i.review?.verdict,
      ),
    ).toEqual(["changes", "approve"]);
    expect(await readFile(join(root, "src/AC-1.ts"), "utf8")).toBe("export const AC1 = 1;\n");
  });

  it("undoes its merge when the merged branch fails the verifier, then retries", async () => {
    const head = git(root, "rev-parse", "HEAD");
    const { runner, invocations } = agents([worker(), worker()], [approve(), approve()]);
    const events: RunEvent[] = [];
    await go(executor({ main: [1, 0] }).router, runner, "AC-1", events);
    expect(events.some((e) => e.type === "merge-reverted")).toBe(true);
    expect(invocations[2]?.prompt).toContain("<verify-log>\nstep: typecheck");
    const s = (await state()).tasks["AC-1"];
    expect(s.status).toBe("done");
    expect(s.iterations[0].mergeReverted).toBe(true);
    // Exactly one Themis merge survives on top of the original head.
    expect(git(root, "rev-list", "--merges", `${head}..HEAD`).split("\n")).toHaveLength(1);
  });

  it("turns a merge conflict into a worker-resolved sync, never a broken branch", async () => {
    const shared =
      (text: string) =>
      (inv: AgentInvocation): AgentResult => {
        mkdirSync(join(inv.cwd, "src"), { recursive: true });
        writeFileSync(join(inv.cwd, "src/shared.ts"), text);
        return structured({ summary: "ok", choices: [] });
      };
    // AC-3 writes src/shared.ts only after AC-1 merged its own version, so AC-3's merge
    // conflicts; its next iteration resolves the conflict brought in by the sync.
    const { runner, invocations } = agents(
      {
        "AC-1": [shared("one\n")],
        "AC-2": [worker()],
        "AC-3": [
          async (inv) => {
            await untilDone("AC-1");
            return shared("three\n")(inv);
          },
          shared("one and three\n"),
        ],
      },
      [approve(), approve(), approve(), approve()],
    );
    const events: RunEvent[] = [];
    await go(executor().router, runner, undefined, events);
    expect(events).toContainEqual({
      type: "merge-conflict",
      task: "AC-3",
      conflicts: ["src/shared.ts"],
    });
    const resolving = invocations.filter((i) => i.prompt.includes("Implement task AC-3")).at(1);
    expect(resolving?.prompt).toContain("stopped with conflicts in: src/shared.ts");
    const s = (await state()).tasks;
    expect(s["AC-3"]).toMatchObject({
      status: "done",
      iterations: [{ mergeConflicts: ["src/shared.ts"] }, {}],
    });
    expect(await readFile(join(root, "src/shared.ts"), "utf8")).toBe("one and three\n");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("runs independent tasks in parallel and dependents after their dependencies", async () => {
    const { runner } = agents([worker(), worker(), worker()], [approve(), approve(), approve()]);
    const events: RunEvent[] = [];
    const outcome = await go(executor().router, runner, undefined, events);
    expect(outcome).toMatchObject({ kind: "finished", ran: ["AC-1", "AC-3", "AC-2"] });
    const order = events
      .filter((e) => e.type === "task-start" || e.type === "task-end")
      .map((e) => `${e.type}:${e.task}`);
    // Both roots start before either ends; AC-2 starts only after AC-1 ended.
    expect(order.slice(0, 2)).toEqual(["task-start:AC-1", "task-start:AC-3"]);
    expect(order.indexOf("task-start:AC-2")).toBeGreaterThan(order.indexOf("task-end:AC-1"));
    expect(
      Object.values((await state()).tasks).map((t) => (t as { status: string }).status),
    ).toEqual(["done", "done", "done"]);
    for (const id of ["AC-1", "AC-2", "AC-3"])
      expect(existsSync(join(root, `src/${id}.ts`))).toBe(true);
  });

  it("syncs a running task with work merged meanwhile and verifies only merged criteria", async () => {
    // AC-1 and AC-3 start together; AC-3's first worker finishes only once AC-1 is merged, and
    // its first verification fails, so its second iteration must start from the merged AC-1.
    const { runner, invocations } = agents(
      {
        "AC-1": [worker()],
        "AC-2": [worker()],
        "AC-3": [
          async (inv) => {
            await untilDone("AC-1");
            return worker()(inv);
          },
          worker(),
        ],
      },
      [approve(), approve(), approve()],
    );
    const { router, verifyCalls } = executor({ perTask: { "AC-3": [1, 0] } });
    await go(router, runner);
    const ac3 = verifyCalls.filter((c) => c.cwd.endsWith("AC-3")).map((c) => c.args);
    expect(ac3[0]).toEqual(["AC-3"]);
    expect(ac3[1]).toEqual(["AC-3", "AC-1"]);
    const second = invocations
      .filter((i) => i.role === "worker" && i.prompt.includes("task AC-3"))
      .at(1);
    expect(second?.prompt).toContain("Run `.themis/verify.sh AC-3 AC-1` yourself");
    expect((await state()).tasks["AC-3"].status).toBe("done");
  });

  it("hands sync conflicts to the worker and completes the merge with its resolution", async () => {
    const writes =
      (text: string) =>
      (inv: AgentInvocation): AgentResult => {
        mkdirSync(join(inv.cwd, "src"), { recursive: true });
        writeFileSync(join(inv.cwd, "src/shared.ts"), text);
        return structured({ summary: "ok", choices: [] });
      };
    // AC-3 fails verification once while AC-1 merges a conflicting src/shared.ts.
    const { runner, invocations } = agents(
      {
        "AC-1": [writes("one\n")],
        "AC-2": [worker()],
        "AC-3": [
          async (inv) => {
            await untilDone("AC-1");
            return writes("three\n")(inv);
          },
          writes("resolved\n"),
        ],
      },
      [approve(), approve(), approve()],
    );
    await go(executor({ perTask: { "AC-3": [1, 0] } }).router, runner);
    const resolving = invocations.find((i) =>
      i.prompt.includes("stopped with conflicts in: src/shared.ts"),
    );
    expect(resolving?.prompt).toContain("Implement task AC-3");
    expect((await state()).tasks["AC-3"].status).toBe("done");
    expect(await readFile(join(root, "src/shared.ts"), "utf8")).toBe("resolved\n");
  });

  it("passes minor decisions from earlier tasks to later ones", async () => {
    const { runner, invocations } = agents(
      [worker(undefined, [{ question: "Which quote style?", decision: "double" }]), worker()],
      [approve(), approve()],
    );
    await go(executor().router, runner, "AC-1");
    await go(executor().router, runner, "AC-2");
    // AC-2 is verified against its own criterion and AC-1 (done), never AC-3 (not run yet).
    expect(invocations[2]?.prompt).toContain("Run `.themis/verify.sh AC-2 AC-1` yourself");
    expect(invocations[2]?.prompt).toContain(
      "Questions other tasks already decided. Treat these as fixed decisions:\n- Which quote style? -> double (decided in AC-1)",
    );
  });

  it("blocks on verifier exit 2", async () => {
    const { runner } = agents([worker()], []);
    await go(executor({ worktree: [2] }).router, runner, "AC-1");
    expect((await state()).tasks["AC-1"]).toMatchObject({
      status: "blocked",
      reason: "verifier exited 2 at typecheck",
    });
  });

  it("marks an interrupted merge as done when the branch is already merged", async () => {
    await go(executor().router, agents([worker()], [approve()]).runner, "AC-1");
    const s = await state();
    s.tasks["AC-1"].status = "merging";
    await writeFile(join(root, ".themis/state.json"), JSON.stringify(s));
    git(root, "branch", "-f", "themis/AC-1", "HEAD");
    const events: RunEvent[] = [];
    await go(executor().router, new FakeAgentRunner([]), "AC-1", events);
    expect(events.map((e) => e.type)).toEqual(["task-start", "task-end"]);
    expect((await state()).tasks["AC-1"].status).toBe("done");
  });
});

describe("themis run CLI", () => {
  it("reports progress and exits by outcome", async () => {
    let out = "";
    let err = "";
    const io = {
      cwd: root,
      stdout: (t: string) => {
        out += t;
      },
      stderr: (t: string) => {
        err += t;
      },
    };
    const claude = (inv: { args: readonly string[]; cwd: string }) => {
      const review = inv.args.includes("Read,Grep,Glob");
      if (!review) writeFileSync(join(inv.cwd, "x.ts"), "export {};\n");
      return {
        stdout: JSON.stringify({
          type: "result",
          is_error: false,
          result: "",
          structured_output: review
            ? { verdict: "approve", reasons: [] }
            : { summary: "s", choices: [] },
          total_cost_usd: 1,
          usage: {},
        }),
        durationMs: 1000,
      };
    };
    const host = new GitRouter({
      claude,
      npm: (req) => {
        mkdirSync(join(req.cwd, "node_modules"), { recursive: true });
        writeFileSync(join(req.cwd, "node_modules/.package-lock.json"), "{}");
        return {};
      },
      ".themis/verify.sh": () => ({ exitCode: 0 }),
    });
    expect(await runCommand(["AC-1"], io, host)).toBe(0);
    expect(err).toContain(
      "AC-1 iteration 1: review approved ($1.0000); merging...\nAC-1: merged and verified\nAC-1: done\n",
    );
    expect(out).toBe("AC-1: done after 1 iteration, $2.0000\n");
  });
});
