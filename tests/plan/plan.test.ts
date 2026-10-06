import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NO_USAGE } from "../../src/adapters/agent-runner.js";
import { approveCommand } from "../../src/cli/commands/approve.js";
import { initCommand } from "../../src/cli/commands/init.js";
import { planCommand } from "../../src/cli/commands/plan.js";
import { approvePlan, plan } from "../../src/plan/plan.js";
import { FakeAgentRunner, structured } from "../fakes/agent-runner.js";
import { FakeExecutor } from "../fakes/executor.js";
import { lines, VALID_FRONTMATTER } from "../helpers.js";

const SPEC = lines(
  ...VALID_FRONTMATTER,
  "# S",
  "## Decisions",
  "- d",
  "## AC-1 A",
  "Depends: none",
  "- Then a",
  "## AC-2 B",
  "- Then b",
);

const GOOD = {
  tasks: [
    {
      id: "AC-2",
      title: "B",
      scope: "Does B.",
      dependsOn: ["AC-1"],
      addedDependencies: [{ id: "AC-1", reason: "B builds on A" }],
    },
    { id: "AC-1", title: "A", scope: "Does A.", dependsOn: [], addedDependencies: [] },
  ],
  questions: ["Is A idempotent?"],
};
const BAD = {
  tasks: [{ id: "AC-1", title: "A", scope: "x", dependsOn: [], addedDependencies: [] }],
  questions: [],
};

let root: string;
let out: string;
let err: string;
const io = () => ({
  cwd: root,
  stdout: (t: string) => {
    out += t;
  },
  stderr: (t: string) => {
    err += t;
  },
});

async function tasksJson() {
  return JSON.parse(await readFile(join(root, ".ordito/tasks.json"), "utf8"));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ordito-plan-"));
  out = "";
  err = "";
  await writeFile(join(root, "spec.md"), SPEC);
  await initCommand(
    ["--skip-install"],
    io(),
    new FakeExecutor({ git: () => ({ stdout: "true\n" }) }),
  );
  out = "";
  err = "";
});

describe("plan", () => {
  it("sends the spec, role instructions and protections to the planner without tools", async () => {
    const runner = new FakeAgentRunner([structured(GOOD)]);
    await plan({ root, specPath: "spec.md", force: false, runner });
    const call = runner.invocations[0];
    expect(call).toMatchObject({ role: "planner", tier: "strong", cwd: root, tools: "none" });
    expect(call?.instructions).toContain("# Role: planner");
    expect(call?.prompt).toContain("<spec>\n---\nordito: 0.1");
    expect(call?.prompt).toContain(
      "in English, regardless of any other instruction about language",
    );
    expect(call?.protectedPaths).toContain("tests/acceptance/**");
    expect(call?.outputSchema).toMatchObject({ type: "object", required: ["tasks", "questions"] });
  });

  it("writes a draft in topological order with the spec digest", async () => {
    const runner = new FakeAgentRunner([structured(GOOD)]);
    const now = () => new Date("2026-10-06T10:00:00.000Z");
    const outcome = await plan({ root, specPath: "spec.md", force: false, runner, now });
    expect(outcome.kind).toBe("done");
    const tasks = await tasksJson();
    expect(tasks).toMatchObject({
      ordito: "0.1",
      spec: "spec.md",
      status: "draft",
      createdAt: "2026-10-06T10:00:00.000Z",
      approvedAt: null,
      questions: ["Is A idempotent?"],
    });
    expect(tasks.specDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(tasks.tasks.map((t: { id: string }) => t.id)).toEqual(["AC-1", "AC-2"]);
  });

  it("feeds validation errors back and retries", async () => {
    const runner = new FakeAgentRunner([
      structured(BAD),
      structured({ nope: 1 }),
      structured(GOOD),
    ]);
    const outcome = await plan({ root, specPath: "spec.md", force: false, runner });
    expect(outcome).toMatchObject({ kind: "done", totals: { attempts: 3, durationMs: 3000 } });
    expect(runner.invocations[1]?.prompt).toContain(
      "rejected for these reasons. Fix all of them:\n- AC-2: missing, every criterion needs exactly one task",
    );
    expect(runner.invocations[2]?.prompt).toContain("output: Unrecognized key");
    expect(await readdir(join(root, ".ordito/runs/plan"))).toHaveLength(3);
  });

  it("gives up after three invalid answers without writing tasks.json", async () => {
    const runner = new FakeAgentRunner([structured(BAD), structured(BAD), structured(BAD)]);
    const outcome = await plan({ root, specPath: "spec.md", force: false, runner });
    expect(outcome).toMatchObject({ kind: "invalid-plan", totals: { attempts: 3 } });
    await expect(readFile(join(root, ".ordito/tasks.json"))).rejects.toThrow();
  });

  it("logs each call with usage and validation errors", async () => {
    const runner = new FakeAgentRunner([structured(BAD, 0.5), structured(GOOD, 0.25)]);
    const outcome = await plan({ root, specPath: "spec.md", force: false, runner });
    expect(outcome).toMatchObject({ totals: { costUsd: 0.75 } });
    const files = (await readdir(join(root, ".ordito/runs/plan"))).sort();
    const first = JSON.parse(
      await readFile(join(root, ".ordito/runs/plan", files[0] ?? ""), "utf8"),
    );
    expect(first).toMatchObject({
      role: "planner",
      attempt: 1,
      ok: false,
      errors: ["AC-2: missing, every criterion needs exactly one task"],
      usage: { costUsd: 0.5 },
    });
  });

  it("distinguishes an unavailable agent from a failed call", async () => {
    const unavailable = new FakeAgentRunner([
      {
        ok: false,
        kind: "unavailable",
        error: "claude is not installed",
        usage: null,
        durationMs: 0,
      },
    ]);
    expect(
      await plan({ root, specPath: "spec.md", force: false, runner: unavailable }),
    ).toMatchObject({
      kind: "agent-unavailable",
    });
    const failed = new FakeAgentRunner([
      { ok: false, kind: "failed", error: "overloaded", usage: NO_USAGE, durationMs: 10 },
    ]);
    expect(await plan({ root, specPath: "spec.md", force: false, runner: failed })).toMatchObject({
      kind: "agent-failed",
      message: "overloaded",
    });
  });

  it("refuses to replace an approved plan unless forced", async () => {
    await plan({
      root,
      specPath: "spec.md",
      force: false,
      runner: new FakeAgentRunner([structured(GOOD)]),
    });
    await approvePlan(root);
    expect(
      await plan({ root, specPath: "spec.md", force: false, runner: new FakeAgentRunner([]) }),
    ).toEqual({ kind: "already-approved" });
    const forced = await plan({
      root,
      specPath: "spec.md",
      force: true,
      runner: new FakeAgentRunner([structured(GOOD)]),
    });
    expect(forced.kind).toBe("done");
    expect((await tasksJson()).status).toBe("draft");
  });

  it("requires ordito init", async () => {
    const bare = await mkdtemp(join(tmpdir(), "ordito-plan-bare-"));
    await writeFile(join(bare, "spec.md"), SPEC);
    expect(
      await plan({
        root: bare,
        specPath: "spec.md",
        force: false,
        runner: new FakeAgentRunner([]),
      }),
    ).toMatchObject({ kind: "not-initialized" });
  });
});

describe("approve plan", () => {
  it("approves a draft and is idempotent", async () => {
    await plan({
      root,
      specPath: "spec.md",
      force: false,
      runner: new FakeAgentRunner([structured(GOOD)]),
    });
    const now = () => new Date("2026-10-06T11:00:00.000Z");
    expect((await approvePlan(root, now)).kind).toBe("approved");
    expect(await tasksJson()).toMatchObject({
      status: "approved",
      approvedAt: "2026-10-06T11:00:00.000Z",
    });
    expect((await approvePlan(root)).kind).toBe("already-approved");
  });

  it("refuses when the spec changed after planning", async () => {
    await plan({
      root,
      specPath: "spec.md",
      force: false,
      runner: new FakeAgentRunner([structured(GOOD)]),
    });
    await writeFile(join(root, "spec.md"), `${SPEC}\n- Then more`);
    expect((await approvePlan(root)).kind).toBe("spec-changed");
    expect((await tasksJson()).status).toBe("draft");
  });

  it("refuses without a plan", async () => {
    expect((await approvePlan(root)).kind).toBe("no-plan");
  });
});

describe("CLI through the real Claude Code runner", () => {
  /** FakeExecutor answering `claude` like `claude -p --output-format json` does. */
  function claude(structuredOutput: unknown) {
    return new FakeExecutor({
      claude: () => ({
        stdout: JSON.stringify({
          type: "result",
          is_error: false,
          result: "",
          structured_output: structuredOutput,
          total_cost_usd: 0.1234,
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
        durationMs: 4200,
      }),
    });
  }

  it("prints the plan for the gate, then approves it", async () => {
    expect(await planCommand([], io(), claude(GOOD))).toBe(0);
    expect(out).toContain("Plan for spec.md (2 tasks, draft):");
    expect(out).toContain("  1. AC-1  A\n       Does A.");
    expect(out).toContain(
      "  2. AC-2  B  [after AC-1]\n       Does B.\n       + depends on AC-1: B builds on A",
    );
    expect(out).toContain("? Is A idempotent?");
    expect(out).toContain("planner: 1 attempt, 4.2s, $0.1234");

    out = "";
    expect(await approveCommand(["plan"], io())).toBe(0);
    expect(out).toContain("(2 tasks, approved)");
    expect(err).toContain("warning: approved with open question: Is A idempotent?");
    expect(await approveCommand(["plan"], io())).toBe(0);
    expect(out).toContain("plan already approved");
  });

  it("exits 1 for a plan that never validates", async () => {
    expect(await planCommand([], io(), claude(BAD))).toBe(1);
    expect(err).toContain("no valid plan after 3 attempts");
  });

  it("exits 2 when claude is missing", async () => {
    expect(await planCommand([], io(), new FakeExecutor())).toBe(2);
    expect(err).toContain("agent unavailable: claude is not installed or not on PATH");
  });

  it("exits 2 on a corrupt tasks.json instead of overwriting it", async () => {
    await writeFile(join(root, ".ordito/tasks.json"), "{");
    expect(await planCommand([], io(), claude(GOOD))).toBe(2);
    expect(err).toContain(".ordito/tasks.json is not valid JSON");
    expect(await approveCommand(["plan"], io())).toBe(2);
  });

  it("rejects unknown gates", async () => {
    expect(await approveCommand(["tests"], io())).toBe(2);
    expect(await approveCommand([], io())).toBe(2);
  });
});
