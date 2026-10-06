import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { approveTests, generateTests } from "../../src/acceptance/acceptance.js";
import type { AgentResult } from "../../src/adapters/agent-runner.js";
import { initCommand } from "../../src/cli/commands/init.js";
import { runCommand } from "../../src/cli/commands/run.js";
import { approvePlan, plan } from "../../src/plan/plan.js";
import { type RunEvent, runTask } from "../../src/run/run.js";
import { FakeAgentRunner, structured } from "../fakes/agent-runner.js";
import { FakeExecutor } from "../fakes/executor.js";
import { lines } from "../helpers.js";

const SPEC = lines(
  "---",
  "themis: 0.1",
  "stack: node-ts",
  "verify: [typecheck, acceptance]",
  "limits: { max_iterations: 2 }",
  "---",
  "# S",
  "## Decisions",
  "- Export greet from src/greet.ts.",
  "## Harness",
  "Tests import src/greet.js.",
  "## AC-1 Greets",
  "Depends: none",
  "- Given Ada",
  "- Then it says hello",
  "## AC-2 Shouts",
  "Depends: AC-1",
  "- Then it shouts",
);
const PLAN = {
  tasks: [
    { id: "AC-1", title: "Greets", scope: "Adds greet.", dependsOn: [], addedDependencies: [] },
    {
      id: "AC-2",
      title: "Shouts",
      scope: "Adds shout.",
      dependsOn: ["AC-1"],
      addedDependencies: [],
    },
  ],
  questions: [{ text: "Trailing newline?", severity: "minor" }],
};
const TESTS = {
  files: [
    { path: "tests/acceptance/ac-1.test.ts", content: 'describe("AC-1: Greets", () => {});\n' },
    { path: "tests/acceptance/ac-2.test.ts", content: 'describe("AC-2: Shouts", () => {});\n' },
  ],
  questions: [],
};

let root: string;
const worker = (choices: Array<{ question: string; decision: string }> = []) =>
  structured({ summary: "done", choices }, 0.25);

/** Verifier fake: each call pops an exit code and writes a matching .verify.log. */
function verifier(...exits: number[]) {
  return new FakeExecutor({
    ".themis/verify.sh": () => {
      const exit = exits.shift() ?? 0;
      if (exit !== 0)
        writeFileSync(
          join(root, ".verify.log"),
          `step: typecheck\nexit: ${exit}\ncommand: tsc\nsrc/greet.ts(1,1): error TS2304\n`,
        );
      return { exitCode: exit };
    },
  });
}

async function run(
  executor: FakeExecutor,
  runner: FakeAgentRunner,
  task?: string,
  events?: RunEvent[],
) {
  return runTask({
    root,
    specPath: "spec.md",
    runner,
    executor,
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
});

describe("runTask", () => {
  it("runs the worker with edit tools and minimal context, then verifies on its own", async () => {
    const runner = new FakeAgentRunner([
      worker([{ question: "Trailing newline?", decision: "none" }]),
    ]);
    const executor = verifier(0);
    const outcome = await run(executor, runner);
    expect(outcome).toMatchObject({
      kind: "finished",
      task: "AC-1",
      state: { status: "done", reason: null },
    });

    const call = runner.invocations[0];
    expect(call).toMatchObject({ role: "worker", tier: "fast", tools: "edit", cwd: root });
    expect(call?.instructions).toContain("# Role: worker");
    expect(call?.protectedPaths).toContain(".themis/**");
    expect(call?.prompt).toContain(
      "Implement task AC-1 of the Themis spec spec.md. Iteration 1 of 2.",
    );
    expect(call?.prompt).toContain(
      "Acceptance criterion AC-1: Greets\n- Given Ada\n- Then it says hello",
    );
    expect(call?.prompt).toContain("<decisions>\n- Export greet from src/greet.ts.\n</decisions>");
    expect(call?.prompt).toContain(
      '<context heading="Harness">\nTests import src/greet.js.\n</context>',
    );
    expect(call?.prompt).toContain("- Trailing newline?");
    expect(call?.prompt).not.toContain("<verify-log>");
    expect(call?.prompt).not.toContain("Shouts");

    expect(executor.requests).toEqual([
      { command: ".themis/verify.sh", args: ["AC-1"], cwd: root, timeoutMs: 1_800_000 },
    ]);
    expect((await state()).tasks["AC-1"]).toMatchObject({
      status: "done",
      attemptStart: 0,
      choices: [{ question: "Trailing newline?", decision: "none" }],
      iterations: [
        { iteration: 1, verifyExit: 0, failedStep: null, worker: { ok: true, costUsd: 0.25 } },
      ],
    });
  });

  it("feeds the verifier log back after a failed verification", async () => {
    const runner = new FakeAgentRunner([worker(), worker()]);
    const events: RunEvent[] = [];
    const outcome = await run(verifier(1, 0), runner, undefined, events);
    expect(outcome).toMatchObject({ state: { status: "done" } });
    expect(runner.invocations[1]?.prompt).toContain("Iteration 2 of 2.");
    expect(runner.invocations[1]?.prompt).toContain("<verify-log>\nstep: typecheck\nexit: 1");
    expect(events.map((e) => e.type)).toEqual([
      "iteration-start",
      "worker-done",
      "verify-done",
      "iteration-start",
      "worker-done",
      "verify-done",
    ]);
    expect(events[2]).toEqual({
      type: "verify-done",
      task: "AC-1",
      iteration: 1,
      exit: 1,
      failedStep: "typecheck",
    });
  });

  it("fails after max_iterations", async () => {
    const outcome = await run(verifier(1, 1), new FakeAgentRunner([worker(), worker()]));
    expect(outcome).toMatchObject({
      state: {
        status: "failed",
        reason: "the verifier still fails after 2 iterations (last step: typecheck)",
      },
    });
  });

  it("blocks on verifier exit 2 without another iteration", async () => {
    const runner = new FakeAgentRunner([worker()]);
    const outcome = await run(verifier(2), runner);
    expect(outcome).toMatchObject({
      state: { status: "blocked", reason: "verifier exited 2 at typecheck" },
    });
    expect(runner.invocations).toHaveLength(1);
  });

  it("blocks without verifying when the agent is unavailable", async () => {
    const executor = verifier();
    const runner = new FakeAgentRunner([
      { ok: false, kind: "unavailable", error: "not logged in", usage: null, durationMs: 0 },
    ]);
    expect(await run(executor, runner)).toMatchObject({
      state: { status: "blocked", reason: "agent unavailable: not logged in" },
    });
    expect(executor.requests).toEqual([]);
  });

  it("still verifies when a worker call fails, since it may have changed files", async () => {
    const failed: AgentResult = {
      ok: false,
      kind: "failed",
      error: "overloaded",
      usage: null,
      durationMs: 5,
    };
    const outcome = await run(verifier(0), new FakeAgentRunner([failed]));
    expect(outcome).toMatchObject({
      state: { status: "done", iterations: [{ worker: { ok: false, error: "overloaded" } }] },
    });
  });

  it("blocks when the verifier cannot run", async () => {
    const outcome = await run(new FakeExecutor(), new FakeAgentRunner([worker()]));
    expect(outcome).toMatchObject({
      state: {
        status: "blocked",
        reason: "the verifier could not run: command not found: .themis/verify.sh",
      },
    });
  });

  it("respects dependencies and picks the next ready task", async () => {
    expect(await run(verifier(), new FakeAgentRunner([]), "AC-2")).toEqual({
      kind: "dependencies-not-done",
      task: "AC-2",
      missing: ["AC-1"],
    });
    await run(verifier(0), new FakeAgentRunner([worker()]));
    expect(await run(verifier(0), new FakeAgentRunner([worker()]))).toMatchObject({
      task: "AC-2",
      state: { status: "done" },
    });
    expect(await run(verifier(), new FakeAgentRunner([]))).toEqual({
      kind: "nothing-to-run",
      done: ["AC-1", "AC-2"],
      blocked: [],
    });
    expect(await run(verifier(), new FakeAgentRunner([]), "AC-1")).toEqual({
      kind: "already-done",
      task: "AC-1",
    });
  });

  it("resumes an interrupted attempt within its budget", async () => {
    await run(verifier(1, 1), new FakeAgentRunner([worker(), worker()]));
    const s = await state();
    // Simulate Ctrl-C during the second attempt's first iteration.
    s.tasks["AC-1"].status = "verifying";
    s.tasks["AC-1"].attemptStart = 1;
    await writeFile(join(root, ".themis/state.json"), JSON.stringify(s));

    const runner = new FakeAgentRunner([worker()]);
    const outcome = await run(verifier(0), runner);
    expect(runner.invocations[0]?.prompt).toContain("Iteration 2 of 2.");
    expect(runner.invocations[0]?.prompt).toContain("<verify-log>");
    expect(outcome).toMatchObject({ state: { status: "done", attemptStart: 1 } });
    expect(
      (await state()).tasks["AC-1"].iterations.map((i: { iteration: number }) => i.iteration),
    ).toEqual([1, 2, 3]);
  });

  it("gives a failed task a fresh attempt when run again", async () => {
    await run(verifier(1, 1), new FakeAgentRunner([worker(), worker()]));
    expect(await run(verifier(), new FakeAgentRunner([]))).toEqual({
      kind: "nothing-to-run",
      done: [],
      blocked: ["AC-1"],
    });
    const runner = new FakeAgentRunner([worker()]);
    const outcome = await run(verifier(0), runner, "AC-1");
    expect(runner.invocations[0]?.prompt).toContain("Iteration 1 of 2.");
    expect(outcome).toMatchObject({ state: { status: "done", attemptStart: 2 } });
  });

  it("requires a locked contract", async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(root, ".themis/lock.json"));
    expect(await run(verifier(), new FakeAgentRunner([]))).toMatchObject({ kind: "not-ready" });
  });
});

describe("themis run CLI", () => {
  it("reports progress and the outcome", async () => {
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
    const host = new FakeExecutor({
      claude: () => ({
        stdout: JSON.stringify({
          type: "result",
          is_error: false,
          result: "",
          structured_output: { summary: "s", choices: [] },
          total_cost_usd: 1.5,
          usage: {},
        }),
        durationMs: 42_000,
      }),
      ".themis/verify.sh": () => ({ exitCode: 0 }),
    });
    expect(await runCommand([], io, host)).toBe(0);
    expect(err).toBe(
      "AC-1 iteration 1/2: worker...\nAC-1 iteration 1: worker done in 42s, $1.5000; verifying...\nAC-1 iteration 1: verify PASS\n",
    );
    expect(out).toBe("AC-1: done after 1 iteration, $1.5000\n");
    expect(await runCommand(["--executor", "docker"], io, host)).toBe(2);
  });
});
