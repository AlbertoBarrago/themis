import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";
import { parseSpec } from "../../src/spec/parse.js";
import { DEFAULT_LIMITS, DEFAULT_VERIFY, renderSpec } from "../../src/spec/template.js";

let cwd: string;
let out: string;
let err: string;
let asked: string[];

/** Runs the CLI; with `answers`, a terminal is attached and answers them in order. */
async function run(argv: string[], answers?: Array<string | undefined>) {
  out = "";
  err = "";
  asked = [];
  const queue = [...(answers ?? [])];
  return runCli(argv, {
    cwd,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    ...(answers === undefined
      ? {}
      : {
          prompt: async (question: string) => {
            asked.push(question);
            if (queue.length === 0) throw new Error(`unexpected question: ${question}`);
            return queue.shift();
          },
        }),
  });
}

const spec = () => readFile(join(cwd, "spec.md"), "utf8");

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "themis-new-"));
});

describe("renderSpec", () => {
  it("renders a spec that passes the parser without errors or warnings", () => {
    const source = renderSpec({
      title: "Tic-Tac-Toe engine",
      summary: "A pure game engine.",
      verify: ["typecheck", "acceptance"],
      limits: { max_iterations: 4, parallel: 1 },
      criteria: [
        { title: "Starts an empty game", dependsOn: [] },
        { title: "Plays moves", dependsOn: ["AC-1"] },
        { title: "Detects a win", dependsOn: ["AC-1", "AC-2"] },
      ],
    });
    const { spec, diagnostics } = parseSpec(source);
    expect(diagnostics).toEqual([]);
    expect(spec?.frontmatter).toMatchObject({
      verify: ["typecheck", "acceptance"],
      limits: { max_iterations: 4, parallel: 1 },
    });
    expect(spec?.criteria.map((c) => [c.id, c.title, c.depends])).toEqual([
      ["AC-1", "Starts an empty game", []],
      ["AC-2", "Plays moves", ["AC-1"]],
      ["AC-3", "Detects a win", ["AC-1", "AC-2"]],
    ]);
  });

  it("falls back to placeholders for the summary and the criteria", () => {
    const source = renderSpec({
      title: "x",
      summary: "",
      verify: DEFAULT_VERIFY,
      limits: DEFAULT_LIMITS,
      criteria: [],
    });
    expect(parseSpec(source).diagnostics).toEqual([]);
    expect(source).toContain("<One paragraph");
    expect(source).toContain("## AC-1 <What the first criterion delivers>\nDepends: none\n");
  });
});

describe("themis new", () => {
  it("writes the default skeleton without a terminal, and says so", async () => {
    expect(await run(["new"])).toBe(0);
    expect(out).toContain("no interactive terminal: writing the skeleton with the defaults\n");
    expect(out).toContain(
      "wrote spec.md (1 acceptance criterion)\nnext: replace every <...> placeholder, then run\n  themis check\n  themis init\n",
    );
    const source = await spec();
    expect(source).toContain(`# ${basename(cwd)}\n`);
    expect(source).toContain(
      "verify: [typecheck, lint, unit, acceptance]\nlimits: { max_iterations: 3, parallel: 2 }\n",
    );
    expect(parseSpec(source).diagnostics).toEqual([]);
  });

  it("skips the wizard with --yes even in a terminal", async () => {
    expect(await run(["new", "--yes"], [])).toBe(0);
    expect(asked).toEqual([]);
    expect(out).not.toContain("no interactive terminal");
  });

  it("builds the spec from the wizard answers", async () => {
    const code = await run(
      ["new"],
      [
        "Tic-Tac-Toe engine",
        "A pure game engine.",
        "typecheck, unit acceptance",
        "4",
        "1",
        "Starts an empty game",
        "Plays alternating moves",
        "ac-1",
        "Detects a win",
        "AC-1, AC-2",
        "",
      ],
    );
    expect(code).toBe(0);
    expect(asked).toEqual([
      `Title [${basename(cwd)}]: `,
      "One-line summary (optional): ",
      "Verify steps [typecheck, lint, unit, acceptance]: ",
      "Max iterations per criterion [3]: ",
      "Criteria run in parallel [2]: ",
      "AC-1 title: ",
      "AC-2 title: ",
      "AC-2 depends on (e.g. AC-1, AC-2; empty for none): ",
      "AC-3 title: ",
      "AC-3 depends on (e.g. AC-1, AC-2; empty for none): ",
      "AC-4 title: ",
    ]);
    expect(out).toContain("wrote spec.md (3 acceptance criteria)\n");
    const source = await spec();
    expect(source).toContain(
      "verify: [typecheck, unit, acceptance]\nlimits: { max_iterations: 4, parallel: 1 }\n",
    );
    expect(source).toContain("# Tic-Tac-Toe engine\n\nA pure game engine.\n");
    expect(source).toContain("## AC-2 Plays alternating moves\nDepends: AC-1\n");
    expect(source).toContain("## AC-3 Detects a win\nDepends: AC-1, AC-2\n");
    expect(parseSpec(source).diagnostics).toEqual([]);
  });

  it("takes the defaults on empty answers", async () => {
    expect(await run(["new"], ["", "", "", "", "", ""])).toBe(0);
    expect(await spec()).toBe(
      renderSpec({
        title: basename(cwd),
        summary: "",
        verify: DEFAULT_VERIFY,
        limits: DEFAULT_LIMITS,
        criteria: [],
      }),
    );
  });

  it("asks again after an invalid answer, explaining why", async () => {
    const code = await run(
      ["new"],
      [
        "T",
        "",
        "typecheck, e2e",
        "typecheck typecheck acceptance",
        "lint",
        "",
        "0",
        "51",
        "two",
        "",
        "17",
        "",
        "First",
        "Second",
        "AC-2",
        "AC-7",
        "AC-1 AC-1",
        "",
        "",
      ],
    );
    expect(code).toBe(0);
    expect(err).toBe(
      [
        '  unknown step "e2e" (known: typecheck, lint, unit, infra, migrate, acceptance)',
        '  duplicate step "typecheck"',
        '  must include "acceptance"',
        "  expected a whole number from 1 to 50",
        "  expected a whole number from 1 to 50",
        "  expected a whole number from 1 to 50",
        "  expected a whole number from 1 to 16",
        '  "AC-2" is not an earlier criterion (choose from AC-1 to AC-1)',
        '  "AC-7" is not an earlier criterion (choose from AC-1 to AC-1)',
        '  duplicate dependency "AC-1"',
        "",
      ].join("\n"),
    );
    expect(await spec()).toContain("## AC-2 Second\nDepends: none\n");
  });

  it("writes nothing when input ends mid-wizard", async () => {
    expect(await run(["new"], ["T", undefined])).toBe(2);
    expect(err).toBe("themis new: aborted, nothing written\n");
    await expect(readFile(join(cwd, "spec.md"))).rejects.toThrow();
  });

  it("refuses to overwrite before asking anything, unless --force", async () => {
    await writeFile(join(cwd, "spec.md"), "mine");
    expect(await run(["new"], [])).toBe(2);
    expect(err).toBe("themis new: spec.md already exists (use --force to overwrite)\n");
    expect(asked).toEqual([]);
    expect(await spec()).toBe("mine");

    expect(await run(["new", "--force", "--yes"])).toBe(0);
    expect(await spec()).toContain("themis: 0.1");
  });

  it("writes to a given path, creating its folder, and names it in the next steps", async () => {
    expect(await run(["new", "specs/game.md", "--yes"])).toBe(0);
    expect(out).toContain("  themis check specs/game.md\n  themis init --spec specs/game.md\n");
    const source = await readFile(join(cwd, "specs/game.md"), "utf8");
    expect(source).toContain("# specs\n");
  });

  it("exits 2 on more than one path", async () => {
    expect(await run(["new", "a.md", "b.md"])).toBe(2);
    expect(err).toContain("themis new: expected at most one spec path");
  });
});
