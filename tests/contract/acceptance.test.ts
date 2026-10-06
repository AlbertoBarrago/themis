import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { approveTests, generateTests } from "../../src/acceptance/acceptance.js";
import { approveCommand } from "../../src/cli/commands/approve.js";
import { initCommand } from "../../src/cli/commands/init.js";
import { testsCommand } from "../../src/cli/commands/tests.js";
import { approvePlan, plan } from "../../src/plan/plan.js";
import { LocalExecutor } from "../../src/runtime/local-executor.js";
import { FakeAgentRunner, structured } from "../fakes/agent-runner.js";
import { FakeExecutor } from "../fakes/executor.js";
import { lines, VALID_FRONTMATTER } from "../helpers.js";

const SPEC = lines(
  ...VALID_FRONTMATTER,
  "# S",
  "## Decisions",
  "- d",
  "## AC-1 A",
  "- Then a",
  "## AC-2 B",
  "- Then b",
);
const PLAN = {
  tasks: [
    { id: "AC-1", title: "A", scope: "A.", dependsOn: [], addedDependencies: [] },
    { id: "AC-2", title: "B", scope: "B.", dependsOn: [], addedDependencies: [] },
  ],
  questions: [],
};
const TESTS = {
  files: [
    {
      path: "tests/acceptance/ac-1.test.ts",
      content:
        'import { describe, it } from "vitest";\n\ndescribe("AC-1: A", () => {\n  it("a", () => {});\n});\n',
    },
    {
      path: "tests/acceptance/ac-2.test.ts",
      content:
        'import { describe, it } from "vitest";\n\ndescribe("AC-2: B", () => {\n  it("b", () => {});\n});\n',
    },
    { path: "tests/acceptance/support/harness.ts", content: "export const port = 0;\n" },
  ],
  questions: [{ text: "Which port?", severity: "minor" }],
};
const BAD_TESTS = { files: [TESTS.files[0]], questions: [] };

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
const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  ).trim();
const read = async (path: string) => readFile(join(root, path), "utf8");

async function approvedPlan() {
  await plan({
    root,
    specPath: "spec.md",
    force: false,
    runner: new FakeAgentRunner([structured(PLAN)]),
  });
  await approvePlan(root);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ordito-tests-"));
  out = "";
  err = "";
  await writeFile(join(root, "spec.md"), SPEC);
  git("init", "-q");
  await initCommand(
    ["--skip-install"],
    io(),
    new FakeExecutor({ git: () => ({ stdout: "true\n" }) }),
  );
  out = "";
  err = "";
});

describe("generateTests", () => {
  it("requires an approved plan for the current spec", async () => {
    const runner = new FakeAgentRunner([]);
    expect(await generateTests({ root, specPath: "spec.md", force: false, runner })).toEqual({
      kind: "plan-not-approved",
    });
    await approvedPlan();
    await writeFile(join(root, "spec.md"), `${SPEC}\n- Then more`);
    expect(await generateTests({ root, specPath: "spec.md", force: false, runner })).toEqual({
      kind: "spec-changed",
    });
  });

  it("asks the test author with read-only tools and writes the files itself", async () => {
    await approvedPlan();
    const runner = new FakeAgentRunner([structured(TESTS)]);
    const outcome = await generateTests({ root, specPath: "spec.md", force: false, runner });
    expect(outcome.kind).toBe("done");

    const call = runner.invocations[0];
    expect(call).toMatchObject({
      role: "test-author",
      tier: "strong",
      tools: "read-only",
      timeoutMs: 45 * 60 * 1000,
    });
    expect(call?.instructions).toContain("# Role: test-author");
    expect(call?.prompt).toContain(
      "<approved-plan>\n- AC-1 (A): A.\n- AC-2 (B): B.\n</approved-plan>",
    );
    expect(call?.prompt).toContain('named exactly "AC-<n>: <title>"');

    expect(await read("tests/acceptance/support/harness.ts")).toBe("export const port = 0;\n");
    expect(JSON.parse(await read(".ordito/tests.json"))).toMatchObject({
      status: "draft",
      files: [
        "tests/acceptance/ac-1.test.ts",
        "tests/acceptance/ac-2.test.ts",
        "tests/acceptance/support/harness.ts",
      ],
      questions: [{ text: "Which port?", severity: "minor" }],
    });
  });

  it("retries invalid answers with the reasons and writes nothing if they stay invalid", async () => {
    await approvedPlan();
    const runner = new FakeAgentRunner([
      structured(BAD_TESTS),
      structured(BAD_TESTS),
      structured(BAD_TESTS),
    ]);
    const outcome = await generateTests({ root, specPath: "spec.md", force: false, runner });
    expect(outcome).toMatchObject({
      kind: "invalid-tests",
      errors: ['AC-2: no describe("AC-2: ...") block; every criterion needs tests'],
    });
    expect(runner.invocations[1]?.prompt).toContain("rejected for these reasons");
    await expect(read("tests/acceptance/ac-1.test.ts")).rejects.toThrow();
  });

  it("does not overwrite existing tests or a locked contract without --force", async () => {
    await approvedPlan();
    await mkdir(join(root, "tests/acceptance"), { recursive: true });
    await writeFile(join(root, "tests/acceptance/mine.test.ts"), "x");
    expect(
      await generateTests({
        root,
        specPath: "spec.md",
        force: false,
        runner: new FakeAgentRunner([]),
      }),
    ).toMatchObject({
      kind: "acceptance-not-empty",
      files: ["tests/acceptance/mine.test.ts"],
    });

    await generateTests({
      root,
      specPath: "spec.md",
      force: true,
      runner: new FakeAgentRunner([structured(TESTS)]),
    });
    await expect(read("tests/acceptance/mine.test.ts")).rejects.toThrow();
    await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] });
    expect(
      await generateTests({
        root,
        specPath: "spec.md",
        force: false,
        runner: new FakeAgentRunner([]),
      }),
    ).toEqual({
      kind: "contract-locked",
    });
  });

  it("keeps the old tests and lock when a forced regeneration fails", async () => {
    await approvedPlan();
    await generateTests({
      root,
      specPath: "spec.md",
      force: false,
      runner: new FakeAgentRunner([structured(TESTS)]),
    });
    await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] });
    const failing = new FakeAgentRunner([
      { ok: false, kind: "failed", error: "overloaded", usage: null, durationMs: 1 },
    ]);
    expect(
      (await generateTests({ root, specPath: "spec.md", force: true, runner: failing })).kind,
    ).toBe("agent-failed");
    expect(await read(".ordito/lock.json")).toContain("tests/acceptance/ac-1.test.ts");
    expect(await read("tests/acceptance/ac-1.test.ts")).toContain("AC-1: A");
  });
});

describe("approveTests", () => {
  beforeEach(async () => {
    await approvedPlan();
    await generateTests({
      root,
      specPath: "spec.md",
      force: false,
      runner: new FakeAgentRunner([structured(TESTS)]),
    });
  });

  it("locks tests, spec, verifier, guard, tool and agent config, with the HEAD commit as base", async () => {
    git("add", "-A");
    git("commit", "-qm", "base");
    const head = git("rev-parse", "HEAD");
    const outcome = await approveTests({
      root,
      executor: new LocalExecutor(),
      agentConfigFiles: [".claude/settings.json"],
      now: () => new Date("2026-10-06T12:00:00.000Z"),
    });
    expect(outcome.kind).toBe("approved");
    const lock = JSON.parse(await read(".ordito/lock.json"));
    expect(lock).toMatchObject({
      ordito: "0.1",
      lockedAt: "2026-10-06T12:00:00.000Z",
      base: head,
      dirs: ["tests/acceptance"],
    });
    expect(Object.keys(lock.files)).toEqual([
      ".claude/settings.json",
      ".ordito/guard.mjs",
      ".ordito/verify.sh",
      "biome.json",
      "spec.md",
      "tests/acceptance/ac-1.test.ts",
      "tests/acceptance/ac-2.test.ts",
      "tests/acceptance/support/harness.ts",
      "tsconfig.json",
      "vitest.config.ts",
    ]);
    expect(JSON.parse(await read(".ordito/tests.json")).status).toBe("approved");
    expect(
      (await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] })).kind,
    ).toBe("already-approved");
  });

  it("produces a lock the generated guard accepts, and rejects tampering", async () => {
    await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] });
    const guard = () =>
      spawnSync(process.execPath, [".ordito/guard.mjs"], { cwd: root, encoding: "utf8" });
    expect(guard().status).toBe(0);

    await writeFile(join(root, "tests/acceptance/ac-1.test.ts"), "changed");
    const result = guard();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("tests/acceptance/ac-1.test.ts: locked file was modified");
  });

  it("uses a null base without commits", async () => {
    await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] });
    expect(JSON.parse(await read(".ordito/lock.json")).base).toBeNull();
  });

  it("re-validates the files on disk, including human edits", async () => {
    await writeFile(
      join(root, "tests/acceptance/ac-2.test.ts"),
      'describe("AC-2: B", () => { it.only("b", () => {}); });',
    );
    expect(
      await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] }),
    ).toEqual({
      kind: "invalid-tests",
      errors: ['tests/acceptance/ac-2.test.ts:1: forbidden marker ".only("'],
    });
    await expect(read(".ordito/lock.json")).rejects.toThrow();
  });

  it("refuses blocking questions unless forced", async () => {
    const state = JSON.parse(await read(".ordito/tests.json"));
    state.questions = [{ text: "AC-2 is untestable", severity: "blocking" }];
    await writeFile(join(root, ".ordito/tests.json"), JSON.stringify(state));
    expect(
      (await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] })).kind,
    ).toBe("blocked");
    expect(
      (
        await approveTests({
          root,
          executor: new LocalExecutor(),
          agentConfigFiles: [],
          force: true,
        })
      ).kind,
    ).toBe("approved");
  });

  it("requires the verifier to exist", async () => {
    await rm(join(root, ".ordito/verify.sh"));
    expect(
      await approveTests({ root, executor: new LocalExecutor(), agentConfigFiles: [] }),
    ).toEqual({
      kind: "missing-contract-file",
      path: ".ordito/verify.sh",
    });
  });
});

describe("CLI", () => {
  function claude(structuredOutput: unknown) {
    return new FakeExecutor({
      claude: () => ({
        stdout: JSON.stringify({
          type: "result",
          is_error: false,
          result: "",
          structured_output: structuredOutput,
          total_cost_usd: 0.5,
          usage: {},
        }),
        durationMs: 60_000,
      }),
      git: () => ({ exitCode: 128, stderr: "fatal: needed a single revision" }),
    });
  }

  it("generates, prints coverage and locks", async () => {
    await approvedPlan();
    expect(await testsCommand([], io(), claude(TESTS))).toBe(0);
    expect(out).toContain("  tests/acceptance/ac-1.test.ts  (6 lines)");
    expect(out).toContain(
      "Coverage:\n  AC-1   tests/acceptance/ac-1.test.ts\n  AC-2   tests/acceptance/ac-2.test.ts",
    );
    expect(out).toContain("Minor questions");
    expect(out).toContain("test author: 1 attempt, 60.0s, $0.5000");
    expect(out).toContain("then run: ordito approve tests");

    out = "";
    expect(await approveCommand(["tests"], io(), claude(TESTS))).toBe(0);
    expect(out).toContain(
      "contract locked: 10 files in .ordito/lock.json (no git commit: markers are checked on every file)",
    );
    expect(out).toContain("next: ordito run");
  });

  it("explains missing prerequisites", async () => {
    expect(await testsCommand([], io(), claude(TESTS))).toBe(2);
    expect(err).toContain("the plan is not approved yet");
    expect(await approveCommand(["tests"], io(), claude(TESTS))).toBe(2);
    expect(err).toContain("no acceptance tests to approve; run ordito tests first");
  });
});
