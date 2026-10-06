import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { NO_USAGE } from "../../src/adapters/agent-runner.js";
import { approveCommand } from "../../src/cli/commands/approve.js";
import { formatDiffs, retroCommand } from "../../src/cli/commands/retro.js";
import { Git } from "../../src/git/git.js";
import { collectEvidence } from "../../src/retro/evidence.js";
import { approveRetro, retro } from "../../src/retro/retro.js";
import type { Proposal } from "../../src/retro/schema.js";
import { applyProposals } from "../../src/retro/validate.js";
import { readState } from "../../src/run/state.js";
import { FakeAgentRunner, structured } from "../fakes/agent-runner.js";
import { FakeExecutor } from "../fakes/executor.js";
import { GitRouter } from "../fakes/router.js";
import { HISTORY, iteration, writeHistory } from "../fakes/run-history.js";

const WORKER = ".themis/agents/worker.md";
const REVIEWER = ".themis/agents/reviewer.md";

const SCOPE_RULE: Proposal = {
  role: "worker",
  pattern: "Workers implement neighbouring criteria, which the reviewer rejects.",
  evidence: ["AC-2#1:review"],
  edits: [
    {
      old: "# Role: worker\n",
      new: "# Role: worker\n\nImplement only your own criterion, even if others look easy.\n",
    },
  ],
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
const read = (path: string) => readFile(join(root, path), "utf8");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "themis-retro-"));
  out = "";
  err = "";
  await writeHistory(root);
});

describe("collectEvidence", () => {
  it("lists every problem and decision of the run with stable ids, in plan order", async () => {
    const { items, warnings } = await collectEvidence(
      root,
      [{ id: "AC-1" }, { id: "AC-2" }, { id: "AC-3" }].map((t) => ({
        ...t,
        title: t.id,
        scope: "s",
        dependsOn: [],
        addedDependencies: [],
      })),
      HISTORY,
    );
    expect(warnings).toEqual([]);
    expect(items.map((e) => [e.id, e.detail])).toEqual([
      ["AC-1#1:verify", "verifier exited 1 at step typecheck"],
      ["AC-1:choice-1", 'worker decided "Which quote style?": double quotes'],
      ["AC-2#1:review", "reviewer asked for changes: implements AC-3 too | adds an unused helper"],
      ["AC-2#2:conflict", "merge conflict on package-lock.json"],
      ["AC-2#3:reverted", "the merged result failed the full verifier and was undone"],
      [
        "AC-2:failed",
        "task failed: not done after 3 iterations (last: the merged result failed the verifier)",
      ],
    ]);
  });

  it("reads permission denials and failed worker calls, and warns on unreadable logs", async () => {
    const state = {
      themis: "0.1" as const,
      tasks: {
        "AC-1": {
          status: "blocked" as const,
          iterations: [
            iteration(1),
            iteration(2, {
              worker: {
                ok: false,
                error: "timeout",
                durationMs: 1,
                costUsd: null,
                inputTokens: 0,
                outputTokens: 0,
              },
            }),
          ],
          attemptStart: 0,
          reason: "agent unavailable: not logged in",
          choices: [],
        },
      },
    };
    await mkdir(join(root, ".themis/runs/AC-1"), { recursive: true });
    await writeFile(
      join(root, ".themis/runs/AC-1/iteration-1-worker.json"),
      JSON.stringify({ result: { ok: true, permissionDenials: 2 } }),
    );
    await writeFile(join(root, ".themis/runs/AC-1/iteration-2-worker.json"), "{");
    const tasks = [{ id: "AC-1", title: "", scope: "", dependsOn: [], addedDependencies: [] }];
    const { items, warnings } = await collectEvidence(root, tasks, state);
    expect(items.map((e) => e.id)).toEqual(["AC-1#1:denied", "AC-1#2:worker", "AC-1:blocked"]);
    expect(items[0]?.detail).toBe("2 tool calls refused by the protections");
    expect(warnings).toEqual([
      ".themis/runs/AC-1/iteration-2-worker.json is not valid JSON; skipped",
    ]);
  });
});

describe("applyProposals", () => {
  const files = new Map([[WORKER, "# Role: worker\n\nA.\nB.\nB.\n"]]);
  const ids = new Set(["AC-2#1:review"]);
  const edit = (old: string, replacement: string): Proposal => ({
    ...SCOPE_RULE,
    edits: [{ old, new: replacement }],
  });

  it("applies edits in order across proposals", () => {
    const applied = applyProposals([edit("A.\n", "A2.\n"), edit("A2.\n", "A3.\n")], files, ids);
    expect(applied).toEqual({
      ok: true,
      files: new Map([[WORKER, "# Role: worker\n\nA3.\nB.\nB.\n"]]),
    });
  });

  it("rejects unknown evidence, missing or ambiguous text, empty and no-op edits", () => {
    const applied = applyProposals(
      [
        { ...edit("missing", "x"), evidence: ["AC-9#1:verify"] },
        edit("B.\n", "C.\n"),
        edit("", "x"),
        edit("A.", "A."),
      ],
      files,
      ids,
    );
    expect(applied).toEqual({
      ok: false,
      errors: [
        'proposals.0.evidence: unknown evidence id "AC-9#1:verify"',
        "proposals.0.edits.0.old: must occur exactly once in .themis/agents/worker.md, found 0",
        "proposals.1.edits.0.old: must occur exactly once in .themis/agents/worker.md after the previous edits, found 2",
        "proposals.2.edits.0.old: must not be empty",
        "proposals.3.edits.0: new is identical to old",
      ],
    });
  });
});

describe("retro", () => {
  it("refuses before any task has finished", async () => {
    await writeHistory(root, { themis: "0.1", tasks: {} });
    const runner = new FakeAgentRunner([]);
    expect(await retro({ root, specPath: "spec.md", runner })).toEqual({
      kind: "nothing-to-analyse",
    });
  });

  it("does not call the agent when there is no evidence", async () => {
    await writeHistory(root, {
      themis: "0.1",
      tasks: {
        "AC-1": {
          status: "done",
          iterations: [iteration(1)],
          attemptStart: 0,
          reason: null,
          choices: [],
        },
      },
    });
    const runner = new FakeAgentRunner([]);
    expect(await retro({ root, specPath: "spec.md", runner })).toMatchObject({
      kind: "no-evidence",
    });
    expect(runner.invocations).toHaveLength(0);
  });

  it("sends the evidence and the target instructions, never its own", async () => {
    const runner = new FakeAgentRunner([structured({ proposals: [] })]);
    await retro({ root, specPath: "spec.md", runner });
    const call = runner.invocations[0];
    expect(call).toMatchObject({ role: "retro", tier: "strong", tools: "read-only", cwd: root });
    expect(call?.instructions).toContain("# Role: retro");
    expect(call?.prompt).toContain(
      "- AC-2#1:review: reviewer asked for changes: implements AC-3 too",
    );
    expect(call?.prompt).toContain(`<file path="${WORKER}">\n# Role: worker`);
    expect(call?.prompt).toContain(`<file path="${REVIEWER}">`);
    expect(call?.prompt).not.toContain('<file path=".themis/agents/retro.md">');
    expect(call?.prompt).toContain("regardless of any other instruction about language");
    expect(call?.outputSchema).toMatchObject({ required: ["proposals"] });
  });

  it("feeds validation errors back, then writes the proposal without touching the files", async () => {
    const before = await read(WORKER);
    const runner = new FakeAgentRunner([
      structured({ proposals: [{ ...SCOPE_RULE, role: "retro" }] }),
      structured({ proposals: [{ ...SCOPE_RULE, evidence: ["AC-7:failed"] }] }),
      structured({ proposals: [SCOPE_RULE] }),
    ]);
    const now = () => new Date("2026-10-06T12:00:00.000Z");
    const outcome = await retro({ root, specPath: "spec.md", runner, now });
    expect(outcome).toMatchObject({ kind: "done", totals: { attempts: 3 } });
    expect(runner.invocations[1]?.prompt).toContain("proposals.0.role: Invalid option");
    expect(runner.invocations[2]?.prompt).toContain('unknown evidence id "AC-7:failed"');
    if (outcome.kind !== "done") throw new Error("unreachable");
    expect(outcome.changes).toEqual([
      {
        path: WORKER,
        before,
        after: before.replace("# Role: worker\n", SCOPE_RULE.edits[0]?.new ?? ""),
      },
    ]);
    expect(await read(WORKER)).toBe(before);
    expect(JSON.parse(await read(".themis/runs/retro.json"))).toMatchObject({
      themis: "0.1",
      createdAt: "2026-10-06T12:00:00.000Z",
      files: { [WORKER]: expect.stringMatching(/^[0-9a-f]{64}$/) },
      proposals: [SCOPE_RULE],
    });
    expect(await readdir(join(root, ".themis/runs/retro"))).toHaveLength(3);
  });

  it("gives up after three invalid answers without writing a proposal", async () => {
    const bad = structured({ proposals: [{ ...SCOPE_RULE, edits: [{ old: "nope", new: "x" }] }] });
    const runner = new FakeAgentRunner([bad, bad, bad]);
    expect(await retro({ root, specPath: "spec.md", runner })).toMatchObject({
      kind: "invalid-proposal",
    });
    await expect(read(".themis/runs/retro.json")).rejects.toThrow();
  });

  it("stops when the agent cannot run", async () => {
    const runner = new FakeAgentRunner([
      { ok: false, kind: "unavailable", error: "not logged in", usage: NO_USAGE, durationMs: 1 },
    ]);
    expect(await retro({ root, specPath: "spec.md", runner })).toMatchObject({
      kind: "agent-unavailable",
      message: "not logged in",
    });
  });
});

describe("approve retro", () => {
  async function propose(...proposals: Proposal[]) {
    const runner = new FakeAgentRunner([structured({ proposals })]);
    expect((await retro({ root, specPath: "spec.md", runner })).kind).toBe("done");
  }

  it("applies the proposal, removes it and prints how to commit", async () => {
    await propose(SCOPE_RULE);
    expect(await approveCommand(["retro"], io())).toBe(0);
    expect(await read(WORKER)).toContain("Implement only your own criterion");
    await expect(read(".themis/runs/retro.json")).rejects.toThrow();
    expect(out).toContain(`updated:\n  ${WORKER}\n`);
    expect(out).toContain(`git add ${WORKER}\n`);
  });

  it("refuses when a target file changed since the proposal", async () => {
    await propose(SCOPE_RULE);
    await writeFile(join(root, WORKER), `${await read(WORKER)}\nlocal edit\n`);
    expect(await approveRetro(root)).toEqual({ kind: "changed", files: [WORKER] });
    expect(await approveCommand(["retro"], io())).toBe(1);
    expect(err).toContain("re-run themis retro");
  });

  it("refuses a hand-edited proposal that no longer applies", async () => {
    await propose(SCOPE_RULE);
    const draft = JSON.parse(await read(".themis/runs/retro.json"));
    draft.proposals[0].edits[0].old = "not in the file";
    await writeFile(join(root, ".themis/runs/retro.json"), JSON.stringify(draft));
    expect(await approveCommand(["retro"], io())).toBe(1);
    expect(err).toContain("found 0");
  });

  it("refuses a proposal edited to target a file it has no digest for", async () => {
    await propose(SCOPE_RULE);
    const draft = JSON.parse(await read(".themis/runs/retro.json"));
    draft.proposals.push({
      ...SCOPE_RULE,
      role: "reviewer",
      edits: [{ old: "# Role: reviewer", new: "# Role: reviewer!" }],
    });
    await writeFile(join(root, ".themis/runs/retro.json"), JSON.stringify(draft));
    expect(await approveRetro(root)).toEqual({
      kind: "invalid-proposal",
      errors: [`${REVIEWER} has no recorded digest in .themis/runs/retro.json`],
    });
  });

  it("exits 2 without a proposal, and on an unreadable one", async () => {
    expect(await approveCommand(["retro"], io())).toBe(2);
    expect(err).toContain("run themis retro first");
    await mkdir(join(root, ".themis/runs"), { recursive: true });
    await writeFile(join(root, ".themis/runs/retro.json"), "{");
    expect(await approveCommand(["retro"], io())).toBe(2);
  });

  it("leaves the run state untouched", async () => {
    await propose(SCOPE_RULE);
    await approveRetro(root);
    expect(await readState(root)).toEqual(HISTORY);
  });
});

describe("themis retro", () => {
  it("prints a unified diff of each proposed change, naming the real file", async () => {
    const changes = [{ path: WORKER, before: await read(WORKER), after: "# Role: worker\n" }];
    const diff = await formatDiffs(new Git(new GitRouter({})), root, changes);
    expect(diff).toContain(`--- a/${WORKER}\n+++ b/${WORKER}\n`);
    expect(diff).toContain("-## Input");
  });

  it("falls back to the proposed file when git is not available", async () => {
    const changes = [{ path: WORKER, before: "a", after: "b" }];
    const diff = await formatDiffs(new Git(new FakeExecutor()), root, changes);
    expect(diff).toContain(
      `(no diff for ${WORKER}: command not found: git; proposed content in .themis/runs/retro/proposed/worker.md)`,
    );
  });

  it("exits 2 on unexpected arguments and unknown agents", async () => {
    expect(await retroCommand(["x"], io(), new FakeExecutor())).toBe(2);
    expect(await retroCommand(["--agent", "nope"], io(), new FakeExecutor())).toBe(2);
    expect(err).toContain('unknown agent "nope"');
  });
});
