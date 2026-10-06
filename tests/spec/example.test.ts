import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../../src/spec/parse.js";

describe("examples/webhook-service/spec.md", () => {
  it("is valid with no warnings and a well-formed dependency graph", async () => {
    const source = await readFile(
      new URL("../../examples/webhook-service/spec.md", import.meta.url),
      "utf8",
    );
    const { spec, diagnostics } = parseSpec(source);
    expect(diagnostics).toEqual([]);
    expect(spec?.criteria.map((c) => [c.id, c.depends])).toEqual([
      ["AC-1", []],
      ["AC-2", ["AC-1"]],
      ["AC-3", ["AC-2"]],
      ["AC-4", ["AC-2"]],
      ["AC-5", ["AC-4"]],
      ["AC-6", ["AC-5"]],
    ]);
    expect(spec?.frontmatter.verify).toContain("infra");
    expect(spec?.context.map((s) => s.heading)).toEqual(["Test harness"]);
  });
});
