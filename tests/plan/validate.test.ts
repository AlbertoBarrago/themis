import { describe, expect, it } from "vitest";
import type { PlannedTask } from "../../src/plan/schema.js";
import { validatePlan } from "../../src/plan/validate.js";
import { parseSpec } from "../../src/spec/parse.js";
import { lines, VALID_FRONTMATTER } from "../helpers.js";

/** AC-1 declares none, AC-2 declares AC-1, AC-3 has no Depends line. */
const spec = (() => {
  const { spec } = parseSpec(
    lines(
      ...VALID_FRONTMATTER,
      "# S",
      "## Decisions",
      "- d",
      "## AC-1 A",
      "Depends: none",
      "- Then a",
      "## AC-2 B",
      "Depends: AC-1",
      "- Then b",
      "## AC-3 C",
      "- Then c",
    ),
  );
  if (spec === undefined) throw new Error("fixture spec is invalid");
  return spec;
})();

function task(
  id: string,
  dependsOn: string[] = [],
  added: Array<[string, string]> = [],
): PlannedTask {
  return {
    id,
    title: `Task ${id}`,
    scope: "scope",
    dependsOn,
    addedDependencies: added.map(([depId, reason]) => ({ id: depId, reason })),
  };
}

const valid = [
  task(
    "AC-3",
    ["AC-2", "setup"],
    [
      ["AC-2", "needs B"],
      ["setup", "needs wiring"],
    ],
  ),
  task("AC-2", ["AC-1"]),
  task("setup"),
  task("AC-1", ["setup"], [["setup", "needs wiring"]]),
];

describe("validatePlan", () => {
  it("accepts a valid plan and orders it topologically, setup first", () => {
    const result = validatePlan(spec, { tasks: valid, questions: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks.map((t) => [t.id, t.dependsOn])).toEqual([
      ["setup", []],
      ["AC-1", ["setup"]],
      ["AC-2", ["AC-1"]],
      ["AC-3", ["setup", "AC-2"]],
    ]);
  });

  it("works without a setup task", () => {
    const result = validatePlan(spec, {
      tasks: [task("AC-1"), task("AC-2", ["AC-1"]), task("AC-3")],
      questions: [],
    });
    expect(result.ok).toBe(true);
  });

  function errors(tasks: PlannedTask[]) {
    const result = validatePlan(spec, { tasks, questions: [] });
    return result.ok ? [] : result.errors;
  }

  it("requires exactly one task per criterion and nothing else", () => {
    expect(errors([task("AC-1"), task("AC-1"), task("AC-2", ["AC-1"]), task("AC-9")])).toEqual([
      "AC-1: listed more than once",
      "AC-9: not a criterion of the spec",
      "AC-3: missing, every criterion needs exactly one task",
    ]);
  });

  it("keeps declared dependencies", () => {
    expect(errors([task("AC-1"), task("AC-2"), task("AC-3")])).toEqual([
      "AC-2: drops AC-1, declared in the spec with Depends:",
    ]);
  });

  it("only lets setup be added to criteria that declare dependencies", () => {
    expect(
      errors([task("AC-1", ["AC-3"], [["AC-3", "why not"]]), task("AC-2", ["AC-1"]), task("AC-3")]),
    ).toEqual([
      'AC-1: adds AC-3, but the spec declares its dependencies with Depends:; only "setup" may be added',
    ]);
  });

  it("requires a reason for every added dependency, and only for added ones", () => {
    expect(
      errors([
        task("setup"),
        task("AC-1", ["setup"]),
        task("AC-2", ["AC-1"], [["AC-1", "declared anyway"]]),
        task("AC-3"),
      ]),
    ).toEqual([
      "AC-1: adds setup without a reason in addedDependencies",
      "AC-2: addedDependencies lists AC-1, which is not an added dependency",
    ]);
  });

  it("rejects unknown, self and repeated dependencies and a dependent setup", () => {
    expect(
      errors([
        task("setup", ["AC-1"]),
        task("AC-1"),
        task("AC-2", ["AC-1", "AC-1"]),
        task(
          "AC-3",
          ["AC-3", "AC-7"],
          [
            ["AC-3", "x"],
            ["AC-7", "y"],
          ],
        ),
      ]),
    ).toEqual([
      "setup: must not depend on other tasks",
      "AC-2: repeated dependency",
      "AC-3: depends on itself",
      "AC-3: depends on unknown task AC-7",
    ]);
  });

  it("rejects cycles", () => {
    expect(
      errors([task("AC-1"), task("AC-2", ["AC-1"]), task("AC-3", ["AC-2"], [["AC-2", "x"]])]),
    ).toEqual([]);
    const { spec: cyclic } = parseSpec(
      lines(
        ...VALID_FRONTMATTER,
        "# S",
        "## Decisions",
        "- d",
        "## AC-1 A",
        "- Then a",
        "## AC-2 B",
        "- Then b",
      ),
    );
    if (cyclic === undefined) throw new Error("fixture");
    const result = validatePlan(cyclic, {
      tasks: [task("AC-1", ["AC-2"], [["AC-2", "x"]]), task("AC-2", ["AC-1"], [["AC-1", "y"]])],
      questions: [],
    });
    expect(result).toEqual({ ok: false, errors: ["dependency cycle between AC-1, AC-2"] });
  });
});

describe("plannerOutputJsonSchema", () => {
  it("has no $schema dialect key, which claude --json-schema rejects", async () => {
    const { plannerOutputJsonSchema } = await import("../../src/plan/schema.js");
    expect(plannerOutputJsonSchema).not.toHaveProperty("$schema");
    expect(plannerOutputJsonSchema).toMatchObject({ type: "object", additionalProperties: false });
  });
});
