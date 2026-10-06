import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/spec/parse.js";
import { diag, lines, VALID_FRONTMATTER } from "../helpers.js";

/** Frontmatter is 5 lines, so body row i (0-based) is file line 6 + i. */
function spec(...body: string[]): string {
  return lines(...VALID_FRONTMATTER, ...body);
}

describe("body structure", () => {
  it("parses title, decisions, criteria and context sections", () => {
    const { spec: parsed, diagnostics } = parseSpec(
      spec(
        "# Billing",
        "",
        "Intro text.",
        "",
        "## Decisions",
        "- Use Postgres.",
        "  Version 16.",
        "* Prices are integers in cents.",
        "",
        "## Glossary",
        "Cent: 1/100 of a unit.",
        "",
        "## AC-2 Charge",
        "Depends: AC-10",
        "Some context for the agent.",
        "- Given a customer",
        "  with a card",
        "- When charged",
        "- Then a receipt exists",
        "",
        "## AC-10 Customers",
        "- Given nothing",
        "- Then a customer can be created",
      ),
    );
    expect(diagnostics).toEqual([]);
    expect(parsed?.title).toBe("Billing");
    expect(parsed?.decisions).toEqual([
      { text: "Use Postgres. Version 16.", line: 11 },
      { text: "Prices are integers in cents.", line: 13 },
    ]);
    expect(parsed?.context).toEqual([
      { heading: "Glossary", line: 15, body: "Cent: 1/100 of a unit." },
    ]);
    expect(parsed?.criteria).toEqual([
      {
        id: "AC-2",
        title: "Charge",
        line: 18,
        depends: ["AC-10"],
        clauses: [
          { text: "Given a customer with a card", line: 21 },
          { text: "When charged", line: 23 },
          { text: "Then a receipt exists", line: 24 },
        ],
        description: "Some context for the agent.",
      },
      {
        id: "AC-10",
        title: "Customers",
        line: 26,
        depends: null,
        clauses: [
          { text: "Given nothing", line: 27 },
          { text: "Then a customer can be created", line: 28 },
        ],
        description: "",
      },
    ]);
  });

  it("distinguishes Depends: none from an absent Depends line", () => {
    const { spec: parsed } = parseSpec(
      spec(
        "# S",
        "## Decisions",
        "- d",
        "## AC-1 A",
        "Depends: none",
        "- Then a",
        "## AC-2 B",
        "- Then b",
      ),
    );
    expect(parsed?.criteria.map((c) => c.depends)).toEqual([[], null]);
  });

  it("ignores headings and Depends lines inside fenced code blocks", () => {
    const { spec: parsed, diagnostics } = parseSpec(
      spec(
        "# S",
        "## Decisions",
        "- d",
        "## AC-1 A",
        "- Then a",
        "```markdown",
        "## AC-2 Not a criterion",
        "Depends: AC-9",
        "- not a clause",
        "````",
        "```",
        "~~~",
        "# not a title",
        "~~~",
      ),
    );
    expect(diagnostics).toEqual([]);
    expect(parsed?.criteria).toHaveLength(1);
    expect(parsed?.criteria[0]?.clauses).toEqual([{ text: "Then a", line: 10 }]);
    expect(parsed?.criteria[0]?.description).toContain("## AC-2 Not a criterion");
  });

  it("accepts CRLF line endings and a BOM", () => {
    const source = `﻿${spec("# S", "## Decisions", "- d", "## AC-1 A", "- Then a").replaceAll("\n", "\r\n")}`;
    expect(parseSpec(source).diagnostics).toEqual([]);
  });
});

describe("body diagnostics", () => {
  it("reports a missing title", () => {
    expect(diag(spec("", "## AC-1 A", "- Then a"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "title-missing", line: 6 }),
        expect.objectContaining({ code: "content-before-title", line: 7 }),
      ]),
    );
  });

  it("reports a duplicate title", () => {
    expect(diag(spec("# A", "## Decisions", "- d", "# B", "## AC-1 X", "- Then x"))).toEqual([
      { code: "title-duplicate", severity: "error", line: 9, column: 1 },
    ]);
  });

  it("reports duplicate Decisions sections", () => {
    expect(
      diag(spec("# A", "## Decisions", "- d", "## Decisions", "- e", "## AC-1 X", "- Then x")),
    ).toEqual([{ code: "decisions-duplicate", severity: "error", line: 9, column: 1 }]);
  });

  it("warns when Decisions is missing or empty", () => {
    expect(diag(spec("# A", "## AC-1 X", "- Then x"))).toEqual([
      { code: "decisions-missing", severity: "warning", line: 6, column: 1 },
    ]);
    expect(diag(spec("# A", "## Decisions", "TBD", "## AC-1 X", "- Then x"))).toEqual([
      { code: "decisions-missing", severity: "warning", line: 7, column: 1 },
    ]);
  });

  it.each([
    "AC-01 Leading zero",
    "AC-1",
    "AC 1 Space",
    "ac-1 lower",
    "AC1 Missing dash",
    "AC-0 Zero",
  ])("reports malformed criterion heading %s", (heading) => {
    expect(diag(spec("# A", "## Decisions", "- d", `## ${heading}`, "- Then x"))).toContainEqual({
      code: "ac-heading-malformed",
      severity: "error",
      line: 9,
      column: 4,
    });
  });

  it("does not treat words starting with AC as criteria", () => {
    expect(
      diag(spec("# A", "## Decisions", "- d", "## ACME integration", "## AC-1 X", "- Then x")),
    ).toEqual([]);
  });

  it("requires at least one criterion", () => {
    expect(diag(spec("# A", "## Decisions", "- d"))).toEqual([
      { code: "no-acceptance-criteria", severity: "error", line: 6, column: 1 },
    ]);
  });

  it("requires clauses and warns about a missing Then", () => {
    expect(
      diag(
        spec("# A", "## Decisions", "- d", "## AC-1 X", "Only prose.", "## AC-2 Y", "- Given y"),
      ),
    ).toEqual([
      { code: "ac-no-clauses", severity: "error", line: 9, column: 1 },
      { code: "ac-missing-then", severity: "warning", line: 11, column: 1 },
    ]);
  });

  it("accepts a bold Then clause", () => {
    expect(diag(spec("# A", "## Decisions", "- d", "## AC-1 X", "- **Then** ok"))).toEqual([]);
  });
});

describe("Depends", () => {
  const base = ["# A", "## Decisions", "- d", "## AC-1 X", "- Then x"];

  it.each([
    ["Depends:", 9],
    ["Depends: AC-1;AC-2", 10],
    ["Depends: AC-1, ", 10],
    ["Depends: ac-1", 10],
    ["Depends: AC-01", 10],
  ])("reports malformed value %j", (line, column) => {
    expect(diag(spec(...base, "## AC-2 Y", line, "- Then y"))).toEqual([
      { code: "depends-malformed", severity: "error", line: 12, column },
    ]);
  });

  it("reports a repeated identifier at its column", () => {
    expect(diag(spec(...base, "## AC-2 Y", "Depends: AC-1, AC-1", "- Then y"))).toEqual([
      { code: "depends-duplicate", severity: "error", line: 12, column: 16 },
    ]);
  });

  it("reports a second Depends line", () => {
    expect(diag(spec(...base, "## AC-2 Y", "Depends: AC-1", "Depends: none", "- Then y"))).toEqual([
      { code: "depends-duplicate", severity: "error", line: 13, column: 1 },
    ]);
  });

  it("reports Depends after the first clause", () => {
    expect(diag(spec(...base, "## AC-2 Y", "- Then y", "Depends: AC-1"))).toEqual([
      { code: "depends-misplaced", severity: "error", line: 13, column: 1 },
    ]);
  });

  it("reports unknown and self dependencies at the identifier", () => {
    expect(diag(spec(...base, "## AC-2 Y", "Depends: AC-2, AC-7", "- Then y"))).toEqual([
      { code: "depends-self", severity: "error", line: 12, column: 10 },
      { code: "depends-unknown", severity: "error", line: 12, column: 16 },
    ]);
  });

  it("reports duplicate criteria and keeps the first", () => {
    expect(diag(spec(...base, "## AC-1 Again", "- Then z"))).toEqual([
      { code: "ac-duplicate", severity: "error", line: 11, column: 4 },
    ]);
  });

  it("reports each dependency cycle once", () => {
    const result = parseSpec(
      spec(
        "# A",
        "## Decisions",
        "- d",
        "## AC-1 A",
        "Depends: AC-3",
        "- Then a",
        "## AC-2 B",
        "Depends: AC-1",
        "- Then b",
        "## AC-3 C",
        "Depends: AC-2",
        "- Then c",
        "## AC-4 D",
        "Depends: AC-5",
        "- Then d",
        "## AC-5 E",
        "Depends: AC-4",
        "- Then e",
      ),
    );
    expect(result.spec).toBeUndefined();
    expect(result.diagnostics.map((d) => [d.code, d.line, d.message])).toEqual([
      ["depends-cycle", 9, "dependency cycle between AC-1, AC-2, AC-3"],
      ["depends-cycle", 18, "dependency cycle between AC-4, AC-5"],
    ]);
  });
});
