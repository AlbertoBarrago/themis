import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/spec/parse.js";
import { diag, lines, VALID_BODY, VALID_FRONTMATTER } from "../helpers.js";

function withFrontmatter(...fm: string[]): string {
  return lines("---", ...fm, "---", ...VALID_BODY);
}

describe("frontmatter", () => {
  it("applies defaults for limits and models", () => {
    const { spec, diagnostics } = parseSpec(lines(...VALID_FRONTMATTER, ...VALID_BODY));
    expect(diagnostics).toEqual([]);
    expect(spec?.frontmatter).toEqual({
      themis: "0.1",
      stack: "node-ts",
      verify: ["typecheck", "acceptance"],
      limits: { max_iterations: 5, parallel: 3 },
      models: { planner: "strong", worker: "fast", reviewer: "strong", retro: "strong" },
      extensions: {},
    });
  });

  it("merges partial limits and models with defaults", () => {
    const { spec } = parseSpec(
      withFrontmatter(
        "themis: 0.1",
        "stack: node-ts",
        "verify: [acceptance]",
        "limits: { parallel: 1 }",
        "models: { worker: strong }",
      ),
    );
    expect(spec?.frontmatter.limits).toEqual({ max_iterations: 5, parallel: 1 });
    expect(spec?.frontmatter.models.worker).toBe("strong");
    expect(spec?.frontmatter.models.planner).toBe("strong");
  });

  it("accepts a quoted version and keeps x- extensions", () => {
    const { spec, diagnostics } = parseSpec(
      withFrontmatter(
        'themis: "0.1"',
        "stack: node-ts",
        "verify: [acceptance]",
        "x-team: payments",
      ),
    );
    expect(diagnostics).toEqual([]);
    expect(spec?.frontmatter.extensions).toEqual({ "x-team": "payments" });
  });

  it("reports a missing frontmatter", () => {
    expect(diag(lines(...VALID_BODY.slice(1)))).toContainEqual(
      expect.objectContaining({ code: "frontmatter-missing", line: 1 }),
    );
  });

  it("reports an unclosed frontmatter", () => {
    expect(diag(lines("---", "themis: 0.1", "# Service"))).toContainEqual(
      expect.objectContaining({ code: "frontmatter-unclosed", line: 1 }),
    );
  });

  it("reports YAML syntax errors at the file line", () => {
    const result = diag(
      withFrontmatter("themis: 0.1", "stack: node-ts", "verify: [acceptance", "limits: {}"),
    );
    expect(result[0]).toMatchObject({ code: "yaml-syntax", severity: "error" });
    expect(result[0]?.line).toBeGreaterThanOrEqual(4);
  });

  it("reports duplicate keys as YAML errors", () => {
    expect(
      diag(
        withFrontmatter("themis: 0.1", "stack: node-ts", "stack: node-ts", "verify: [acceptance]"),
      ),
    ).toContainEqual(expect.objectContaining({ code: "yaml-syntax", line: 4 }));
  });

  it("reports a non-mapping frontmatter", () => {
    expect(diag(withFrontmatter("- a", "- b"))).toContainEqual(
      expect.objectContaining({ code: "frontmatter-not-mapping", line: 2 }),
    );
  });

  it.each([
    ["0.2", '"0.2"'],
    ["0.10", '"0.10"'],
    ['"1"', '"1"'],
  ])("rejects version %s", (value, shown) => {
    const { diagnostics } = parseSpec(
      withFrontmatter(`themis: ${value}`, "stack: node-ts", "verify: [acceptance]"),
    );
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "unsupported-version",
        line: 2,
        column: 9,
        field: "themis",
        message: expect.stringContaining(shown),
      }),
    ]);
  });

  it("reports missing required fields", () => {
    expect(diag(withFrontmatter("limits: { parallel: 2 }"))).toEqual(
      expect.arrayContaining([
        { code: "invalid-field", severity: "error", line: 1, column: 1, field: "themis" },
        { code: "invalid-field", severity: "error", line: 1, column: 1, field: "stack" },
        { code: "invalid-field", severity: "error", line: 1, column: 1, field: "verify" },
      ]),
    );
  });

  it("reports unknown top-level fields at the key", () => {
    expect(
      diag(withFrontmatter("themis: 0.1", "stack: node-ts", "verify: [acceptance]", "verfy: []")),
    ).toEqual([{ code: "unknown-field", severity: "error", line: 5, column: 1, field: "verfy" }]);
  });

  it("reports unknown nested fields with their dotted path", () => {
    expect(
      diag(
        withFrontmatter(
          "themis: 0.1",
          "stack: node-ts",
          "verify: [acceptance]",
          "limits:",
          "  parallel: 2",
          "  timeout: 10",
        ),
      ),
    ).toEqual([
      { code: "unknown-field", severity: "error", line: 7, column: 3, field: "limits.timeout" },
    ]);
  });

  it("reports wrong values with line, column and field", () => {
    expect(
      diag(
        withFrontmatter(
          "themis: 0.1",
          "stack: python",
          "verify: [acceptance, e2e]",
          "limits: { max_iterations: 0, parallel: 2.5 }",
          "models: { planner: huge }",
        ),
      ),
    ).toEqual([
      { code: "invalid-field", severity: "error", line: 3, column: 8, field: "stack" },
      { code: "invalid-field", severity: "error", line: 4, column: 22, field: "verify[1]" },
      {
        code: "invalid-field",
        severity: "error",
        line: 5,
        column: 27,
        field: "limits.max_iterations",
      },
      { code: "invalid-field", severity: "error", line: 5, column: 40, field: "limits.parallel" },
      { code: "invalid-field", severity: "error", line: 6, column: 20, field: "models.planner" },
    ]);
  });

  it("explains enum errors with the allowed values", () => {
    const { diagnostics } = parseSpec(
      withFrontmatter("themis: 0.1", "stack: python", "verify: [acceptance]"),
    );
    expect(diagnostics[0]?.message).toBe("must be one of: node-ts");
  });

  it("requires acceptance in verify and rejects duplicates", () => {
    expect(diag(withFrontmatter("themis: 0.1", "stack: node-ts", "verify: [lint, lint]"))).toEqual([
      { code: "invalid-field", severity: "error", line: 4, column: 9, field: "verify" },
      { code: "invalid-field", severity: "error", line: 4, column: 16, field: "verify[1]" },
    ]);
  });

  it("rejects an empty verify list", () => {
    const { diagnostics } = parseSpec(
      withFrontmatter("themis: 0.1", "stack: node-ts", "verify: []"),
    );
    expect(diagnostics.map((d) => d.message)).toContain("must not be empty");
  });

  it("still analyses the body when the frontmatter is invalid", () => {
    const codes = diag(lines("---", "stack: node-ts", "---", "", "## AC-1 Orphan")).map(
      (d) => d.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining(["invalid-field", "content-before-title", "ac-no-clauses"]),
    );
  });
});
