import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isSafeAcceptancePath, validateTestFiles } from "../../src/acceptance/validate.js";
import { parseSpec } from "../../src/spec/parse.js";
import { FORBIDDEN_MARKERS } from "../../src/stack/node-ts/contract.js";
import { lines, VALID_FRONTMATTER } from "../helpers.js";

const spec = (() => {
  const { spec } = parseSpec(
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
  if (spec === undefined) throw new Error("fixture");
  return spec;
})();

const file = (path: string, content: string) => ({ path, content });
const ac1 = file(
  "tests/acceptance/ac-1.test.ts",
  'describe("AC-1: A", () => { it("a", () => {}); });\n',
);
const ac2 = file("tests/acceptance/ac-2.test.ts", "describe('AC-2: B', () => {});\n");

describe("validateTestFiles", () => {
  it("accepts files covering every criterion", () => {
    expect(
      validateTestFiles(spec, [ac1, ac2, file("tests/acceptance/harness.ts", "export {};\n")]),
    ).toEqual([]);
  });

  it("requires every criterion and rejects unknown ones", () => {
    expect(
      validateTestFiles(spec, [
        ac1,
        file("tests/acceptance/x.test.ts", 'describe("AC-7: X", () => {});'),
      ]),
    ).toEqual([
      "AC-7: tests describe a criterion that is not in the spec",
      'AC-2: no describe("AC-2: ...") block; every criterion needs tests',
    ]);
  });

  it("rejects describe names that miss the AC-<n>: convention", () => {
    expect(
      validateTestFiles(spec, [
        ac1,
        ac2,
        file(
          "tests/acceptance/y.test.ts",
          '\ndescribe("AC-2 B", () => {});\ndescribe(`AC-01: x`, () => {});',
        ),
      ]),
    ).toEqual([
      'tests/acceptance/y.test.ts:2: criterion describe blocks must be named "AC-<n>: <title>"',
      'tests/acceptance/y.test.ts:3: criterion describe blocks must be named "AC-<n>: <title>"',
    ]);
  });

  it("reports forbidden markers with their line", () => {
    expect(
      validateTestFiles(spec, [
        ac1,
        file(
          "tests/acceptance/ac-2.test.ts",
          'describe("AC-2: B", () => {\n  it.skip("x", () => {});\n  const y = z as any;\n});',
        ),
      ]),
    ).toEqual([
      'tests/acceptance/ac-2.test.ts:2: forbidden marker ".skip("',
      'tests/acceptance/ac-2.test.ts:3: forbidden marker "as any"',
    ]);
  });

  it("rejects unsafe or duplicate paths and non-TypeScript files", () => {
    expect(
      validateTestFiles(spec, [
        ac1,
        ac2,
        ac2,
        file("src/app.ts", "x"),
        file("tests/acceptance/../../src/app.ts", "x"),
        file("tests/acceptance/run.sh", "x"),
      ]),
    ).toEqual([
      "tests/acceptance/ac-2.test.ts: listed more than once",
      'src/app.ts: must be a relative path under tests/acceptance/ using only letters, digits, ".", "_", "-" and "/"',
      'tests/acceptance/../../src/app.ts: must be a relative path under tests/acceptance/ using only letters, digits, ".", "_", "-" and "/"',
      "tests/acceptance/run.sh: only TypeScript (and JSON fixtures) are allowed",
    ]);
  });

  it("requires at least one test file", () => {
    expect(
      validateTestFiles(spec, [
        file("tests/acceptance/support.ts", 'describe("AC-1: A"); describe("AC-2: B");'),
      ]),
    ).toEqual(["no *.test.ts file under tests/acceptance/"]);
  });

  it.each([
    ["tests/acceptance/a.test.ts", true],
    ["tests/acceptance/nested/b.ts", true],
    ["tests/acceptance//b.ts", false],
    ["tests/acceptance/./b.ts", false],
    ["/tests/acceptance/b.ts", false],
    ["tests/acceptance/b c.ts", false],
  ])("isSafeAcceptancePath(%s) is %s", (path, safe) => {
    expect(isSafeAcceptancePath(path)).toBe(safe);
  });
});

describe("FORBIDDEN_MARKERS", () => {
  it("matches the list in the generated guard", async () => {
    const guard = await readFile(
      new URL("../../templates/node-ts/guard.mjs", import.meta.url),
      "utf8",
    );
    const names = [...guard.matchAll(/^\s*\["([^"]+)", \//gm)].map((m) => m[1]);
    expect(names).toEqual(FORBIDDEN_MARKERS.map(([name]) => name));
  });
});
