import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/run.js";
import { lines, VALID_BODY, VALID_FRONTMATTER } from "../helpers.js";

let cwd: string;
let out: string;
let err: string;

async function run(...argv: string[]) {
  out = "";
  err = "";
  return runCli(argv, {
    cwd,
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
  });
}

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "ordito-check-"));
});

describe("ordito check", () => {
  it("exits 0 for a valid spec.md in the working directory", async () => {
    await writeFile(join(cwd, "spec.md"), lines(...VALID_FRONTMATTER, ...VALID_BODY));
    expect(await run("check")).toBe(0);
    expect(out).toBe("spec.md: valid (1 acceptance criterion, 1 decision)\n");
  });

  it("exits 1 and prints located diagnostics for an invalid spec", async () => {
    await writeFile(
      join(cwd, "feature.md"),
      lines("---", "ordito: 0.1", "stack: rust", "verify: [acceptance]", "---", ...VALID_BODY),
    );
    expect(await run("check", "feature.md")).toBe(1);
    expect(out).toBe(
      "feature.md:3:8: error[invalid-field] stack: must be one of: node-ts\nfeature.md: invalid (1 error)\n",
    );
  });

  it("keeps warnings non-fatal", async () => {
    await writeFile(
      join(cwd, "spec.md"),
      lines(...VALID_FRONTMATTER, "# S", "## AC-1 A", "- Given a"),
    );
    expect(await run("check")).toBe(0);
    expect(out).toContain("warning[decisions-missing]");
    expect(out).toContain("warning[ac-missing-then]");
  });

  it("prints JSON with --json", async () => {
    await writeFile(join(cwd, "spec.md"), lines(...VALID_FRONTMATTER, ...VALID_BODY));
    expect(await run("check", "--json")).toBe(0);
    expect(JSON.parse(out)).toEqual({ file: "spec.md", valid: true, diagnostics: [] });
  });

  it("exits 2 when the file cannot be read", async () => {
    expect(await run("check", "missing.md")).toBe(2);
    expect(err).toContain("cannot read missing.md");
  });

  it("exits 2 on unknown options and commands", async () => {
    expect(await run("check", "--nope")).toBe(2);
    expect(err).toContain("--nope");
    expect(await run("frobnicate")).toBe(2);
    expect(err).toContain('unknown command "frobnicate"');
  });

  it("prints the package version", async () => {
    expect(await run("--version")).toBe(0);
    expect(out).toMatch(/^\d+\.\d+\.\d+/);
  });
});
