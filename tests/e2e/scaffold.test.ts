import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initCommand } from "../../src/cli/commands/init.js";
import { FakeExecutor } from "../fakes/executor.js";
import { lines, VALID_BODY } from "../helpers.js";

/**
 * Runs the real toolchain (tsc, Biome, vitest) on a freshly scaffolded project, reusing
 * Ordito's own node_modules (same packages as the scaffold) so no network is needed.
 * Proves the generated configuration passes its own verifier.
 */
describe("scaffolded project with the real toolchain", () => {
  it("passes verify.sh for a task and for the full regression", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "ordito-e2e-"));
    await writeFile(
      join(root, "spec.md"),
      lines(
        "---",
        "ordito: 0.1",
        "stack: node-ts",
        "verify: [typecheck, lint, unit, acceptance]",
        "---",
        ...VALID_BODY,
      ),
    );
    const code = await initCommand(
      ["--skip-install"],
      { cwd: root, stdout: () => {}, stderr: () => {} },
      new FakeExecutor({ git: () => ({ stdout: "true\n" }) }),
    );
    expect(code).toBe(0);

    await symlink(
      fileURLToPath(new URL("../../node_modules", import.meta.url)),
      join(root, "node_modules"),
    );
    await mkdir(join(root, "src"));
    await mkdir(join(root, "tests/acceptance"), { recursive: true });
    await writeFile(
      join(root, "src/greet.ts"),
      "export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n",
    );
    await writeFile(
      join(root, "src/greet.test.ts"),
      'import { expect, it } from "vitest";\nimport { greet } from "./greet.js";\n\nit("greets", () => {\n  expect(greet("Ada")).toBe("Hello, Ada");\n});\n',
    );
    await writeFile(
      join(root, "tests/acceptance/ac-1.test.ts"),
      'import { describe, expect, it } from "vitest";\nimport { greet } from "../../src/greet.js";\n\ndescribe("AC-1: greets", () => {\n  it("says hello", () => {\n    expect(greet("Ada")).toBe("Hello, Ada");\n  });\n});\n',
    );
    await writeFile(
      join(root, ".ordito/lock.json"),
      JSON.stringify({ ordito: "0.1", lockedAt: "x", base: null, dirs: [], files: {} }),
    );

    const result = spawnSync(join(root, ".ordito/verify.sh"), ["AC-1"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.stderr).toContain("verify: acceptance AC-1");
    expect(result.stderr).toContain("verify: PASS");
    expect(result.status).toBe(0);
  });
});
