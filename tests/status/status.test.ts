import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { statusCommand } from "../../src/cli/commands/status.js";
import { sha256 } from "../../src/fs/digest.js";
import { status } from "../../src/status/status.js";
import { HISTORY_SPEC, writeHistory } from "../fakes/run-history.js";

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

async function lock(files: Record<string, string>): Promise<void> {
  await writeFile(
    join(root, ".themis/lock.json"),
    JSON.stringify({ themis: "0.1", lockedAt: "x", base: null, dirs: [], files }),
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "themis-status-"));
  out = "";
  err = "";
});

describe("status", () => {
  it("reports an empty project without failing", async () => {
    const report = await status(root, "spec.md");
    expect(report).toMatchObject({
      spec: { path: "spec.md", ok: false, problem: "spec.md not found" },
      plan: "absent",
      contract: { state: "absent" },
      tasks: [],
      totals: { iterations: 0, costUsd: null },
      retroPending: false,
    });
  });

  it("reports every planned task with its budget, cost and what went wrong", async () => {
    await writeHistory(root);
    await lock({ "spec.md": sha256(HISTORY_SPEC) });
    const report = await status(root, "spec.md");
    expect(report.spec).toEqual({ path: "spec.md", ok: true });
    expect(report.plan).toBe("approved");
    expect(report.contract).toEqual({ state: "locked" });
    expect(report.tasks).toEqual([
      {
        id: "AC-1",
        title: "Task AC-1",
        status: "done",
        iterations: 2,
        maxIterations: 3,
        totalIterations: 2,
        costUsd: expect.closeTo(0.25),
        note: null,
      },
      {
        id: "AC-2",
        title: "Task AC-2",
        status: "failed",
        iterations: 3,
        maxIterations: 3,
        totalIterations: 3,
        costUsd: expect.closeTo(0.45),
        note: "not done after 3 iterations (last: the merged result failed the verifier)",
      },
      {
        id: "AC-3",
        title: "Task AC-3",
        status: "pending",
        iterations: 0,
        maxIterations: 3,
        totalIterations: 0,
        costUsd: null,
        note: null,
      },
    ]);
    expect(report.totals).toEqual({ iterations: 5, costUsd: expect.closeTo(0.7) });
  });

  it("flags locked files that changed or disappeared, and a plan made for another spec", async () => {
    await writeHistory(root);
    await lock({ "spec.md": sha256(HISTORY_SPEC), "tests/acceptance/a.test.ts": sha256("x") });
    await writeFile(join(root, "spec.md"), `${HISTORY_SPEC}\n- Then more\n`);
    const report = await status(root, "spec.md");
    expect(report.plan).toBe("stale");
    expect(report.contract).toEqual({
      state: "modified",
      files: ["spec.md", "tests/acceptance/a.test.ts"],
    });
  });

  it("notes the last problem of an interrupted task and a pending retro", async () => {
    await writeHistory(root, {
      themis: "0.1",
      tasks: {
        "AC-1": {
          status: "running",
          iterations: [
            {
              iteration: 1,
              startedAt: "x",
              worker: null,
              verifyExit: 1,
              failedStep: "lint",
            },
          ],
          attemptStart: 0,
          reason: null,
          choices: [],
        },
      },
    });
    await mkdir(join(root, ".themis/runs"), { recursive: true });
    await writeFile(join(root, ".themis/runs/retro.json"), "{}");
    const report = await status(root, "spec.md");
    expect(report.tasks[0]).toMatchObject({
      status: "running",
      costUsd: null,
      note: "verifier failed at lint",
    });
    expect(report.retroPending).toBe(true);
  });
});

describe("themis status", () => {
  it("prints the gates and a task table", async () => {
    await writeHistory(root);
    expect(await statusCommand([], io())).toBe(0);
    expect(out).toContain("spec      spec.md: valid\nplan      approved\ncontract  absent\n");
    expect(out).toContain("AC-1  done     2/3 iterations, $0.2500\n");
    expect(out).toContain(
      "AC-2  failed   3/3 iterations, $0.4500\n      not done after 3 iterations",
    );
    expect(out).toContain("AC-3  pending  0/3 iterations\n");
    expect(out).toContain("total     5 iterations, $0.7000\n");
  });

  it("prints JSON with --json", async () => {
    await writeHistory(root);
    expect(await statusCommand(["--json"], io())).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ plan: "approved", tasks: [{ id: "AC-1" }, {}, {}] });
  });

  it("exits 2 when a Themis file is unreadable", async () => {
    await writeHistory(root);
    await writeFile(join(root, ".themis/state.json"), "{");
    expect(await statusCommand([], io())).toBe(2);
    expect(err).toContain("themis status: .themis/state.json is not valid JSON");
  });

  it("exits 2 on unexpected arguments", async () => {
    expect(await statusCommand(["AC-1"], io())).toBe(2);
  });
});
