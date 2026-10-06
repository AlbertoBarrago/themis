import { describe, expect, it } from "vitest";
import { Project } from "./project.js";

describe("guard.mjs without a lock", () => {
  it("passes a clean project and says digests were not checked", async () => {
    const p = await Project.create("guard");
    await p.write("src/a.ts", "export const a = 1;\n");
    const result = p.guard();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no lock yet");
  });

  it("reports every forbidden marker with its location", async () => {
    const p = await Project.create("guard");
    await p.write(
      "src/a.ts",
      [
        "// @ts-ignore",
        "const x = y as any;",
        "// biome-ignore lint: no",
        "/* eslint-disable */",
        "// oxlint-disable",
        "// @ts-nocheck",
        "// @ts-expect-error",
      ].join("\n"),
    );
    await p.write("tests/a.test.ts", 'it.only("x", () => {});\nit.skip("y");\nit.todo("z");\n');
    const result = p.guard();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('src/a.ts:1: forbidden marker "@ts-ignore"');
    expect(result.stdout).toContain('src/a.ts:2: forbidden marker "as any"');
    expect(result.stdout).toContain('src/a.ts:3: forbidden marker "biome-ignore"');
    expect(result.stdout).toContain('src/a.ts:4: forbidden marker "eslint-disable"');
    expect(result.stdout).toContain('src/a.ts:5: forbidden marker "oxlint-disable"');
    expect(result.stdout).toContain('src/a.ts:6: forbidden marker "@ts-nocheck"');
    expect(result.stdout).toContain('src/a.ts:7: forbidden marker "@ts-expect-error"');
    expect(result.stdout).toContain('tests/a.test.ts:1: forbidden marker ".only("');
    expect(result.stdout).toContain('tests/a.test.ts:2: forbidden marker ".skip("');
    expect(result.stdout).toContain('tests/a.test.ts:3: forbidden marker ".todo("');
    expect(result.stdout).toContain("guard: 10 violation(s)");
  });

  it("ignores dependencies, build output, non-source files and words like 'company'", async () => {
    const p = await Project.create("guard");
    await p.write("node_modules/x/index.js", "x as any");
    await p.write("dist/a.js", "x as any");
    await p.write("README.md", "use .only( never");
    await p.write("src/a.ts", "const has_anything = 1; // as anything\n");
    expect(p.guard().code).toBe(0);
  });
});

describe("guard.mjs with a lock", () => {
  async function locked() {
    const p = await Project.create("guard");
    await p.write("spec.md", "spec\n");
    await p.write("tests/acceptance/ac-1.test.ts", "test\n");
    await p.lock(["spec.md", "tests/acceptance/ac-1.test.ts"], { dirs: ["tests/acceptance"] });
    return p;
  }

  it("passes when every locked file matches", async () => {
    const p = await locked();
    const result = p.guard();
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("no lock yet");
  });

  it("fails on a modified, missing or added file", async () => {
    const p = await locked();
    await p.write("spec.md", "changed\n");
    await p.write("tests/acceptance/helper.ts", "export {};\n");
    const { rm } = await import("node:fs/promises");
    await rm(`${p.root}/tests/acceptance/ac-1.test.ts`);
    const result = p.guard();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("spec.md: locked file was modified");
    expect(result.stdout).toContain("tests/acceptance/ac-1.test.ts: locked file is missing");
    expect(result.stdout).toContain(
      "tests/acceptance/helper.ts: file added to locked directory tests/acceptance",
    );
  });

  it.each([
    ["{ broken", "not valid JSON"],
    ['{"ordito":"0.1","base":null,"dirs":[],"files":{"a":"short"}}', "does not match"],
  ])("exits 2 on a corrupt lock", async (content, message) => {
    const p = await Project.create("guard");
    await p.write(".ordito/lock.json", content);
    const result = p.guard();
    expect(result.code).toBe(2);
    expect(result.stdout).toContain(message);
  });
});

describe("guard.mjs with a base commit", () => {
  it("flags only markers added since base, in tracked and untracked files", async () => {
    const p = await Project.create("guard");
    p.git("init", "-q");
    await p.write("src/legacy.ts", "// @ts-ignore\nexport const a = 1;\n");
    p.git("add", "-A");
    p.git("commit", "-qm", "base");
    const base = p.git("rev-parse", "HEAD");
    await p.lock([], { base });

    await p.write(
      "src/legacy.ts",
      "// @ts-ignore\nexport const a = 1;\nexport const b = c as any;\n",
    );
    await p.write("src/new.ts", "\n// biome-ignore lint: x\n");
    const result = p.guard();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('src/legacy.ts:3: forbidden marker "as any"');
    expect(result.stdout).toContain('src/new.ts:2: forbidden marker "biome-ignore"');
    expect(result.stdout).not.toContain("src/legacy.ts:1");
    expect(result.stdout).toContain("guard: 2 violation(s)");
  });

  it("exits 2 when the base commit is unknown to git", async () => {
    const p = await Project.create("guard");
    p.git("init", "-q");
    await p.lock([], { base: "0000000000000000000000000000000000000000" });
    const result = p.guard();
    expect(result.code).toBe(2);
    expect(result.stdout).toContain("git diff");
  });
});
