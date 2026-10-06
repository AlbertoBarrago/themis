import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTemplate, render } from "../../src/templates.js";
import { Project } from "./project.js";

const ALL_STEPS = "typecheck lint unit infra migrate acceptance";

/** Stub that logs its invocation, prints coloured output and exits with `$<var>` (default 0). */
function stub(name: string, exitExpression: string): string {
  return [
    "#!/bin/sh",
    `echo "${name} $*" >> "$STUB_LOG"`,
    `printf '\\033[31m${name} output\\033[0m\\n'`,
    `for i in 1 2 3 4 5; do echo "${name} line $i"; done`,
    exitExpression,
    "",
  ].join("\n");
}

async function project(options: { steps?: string; locked?: boolean } = {}) {
  const p = await Project.create("verify");
  const verify = render(await readTemplate("node-ts/verify.sh"), {
    STEPS: options.steps ?? ALL_STEPS,
  });
  await p.write(".themis/verify.sh", verify, 0o755);
  await p.write("package.json", JSON.stringify({ type: "module", scripts: { migrate: "x" } }));
  await p.write("compose.yaml", "services: {}\n");
  await p.write("node_modules/.bin/tsc", stub("tsc", 'exit "${STUB_TSC:-0}"'), 0o755);
  await p.write("node_modules/.bin/biome", stub("biome", 'exit "${STUB_BIOME:-0}"'), 0o755);
  await p.write(
    "node_modules/.bin/vitest",
    stub(
      "vitest",
      [
        'case "$*" in',
        '  *" -t "*) exit "${STUB_VITEST_TASK:-0}" ;;',
        '  *"run tests/acceptance"*) exit "${STUB_VITEST_ACCEPTANCE:-0}" ;;',
        '  *) exit "${STUB_VITEST_UNIT:-0}" ;;',
        "esac",
      ].join("\n"),
    ),
    0o755,
  );
  await p.write(
    "stubs/docker",
    stub(
      "docker",
      [
        'case "$*" in',
        '  info) exit "${STUB_DOCKER_INFO:-0}" ;;',
        '  *config*) exit "${STUB_DOCKER_CONFIG:-0}" ;;',
        '  *up*) exit "${STUB_DOCKER_UP:-0}" ;;',
        "esac",
      ].join("\n"),
    ),
    0o755,
  );
  await p.write("stubs/npm", stub("npm", 'exit "${STUB_NPM:-0}"'), 0o755);
  if (options.locked ?? true) await p.lock([]);
  return p;
}

function verify(p: Project, args: string[] = [], env: Record<string, string> = {}) {
  const result = p.run(join(p.root, ".themis/verify.sh"), args, {
    PATH: [join(p.root, "stubs"), dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    STUB_LOG: join(p.root, "stub.log"),
    ...env,
  });
  return {
    ...result,
    calls: async () =>
      existsSync(join(p.root, "stub.log"))
        ? (await readFile(join(p.root, "stub.log"), "utf8")).trim().split("\n")
        : [],
    log: async () =>
      existsSync(join(p.root, ".verify.log"))
        ? readFile(join(p.root, ".verify.log"), "utf8")
        : undefined,
  };
}

describe("verify.sh happy path", () => {
  it("runs every enabled step in cost order and removes .verify.log", async () => {
    const p = await project();
    await p.write(".verify.log", "stale");
    const result = verify(p, ["AC-12"]);
    expect(result.stderr).toContain("verify: PASS");
    expect(result.code).toBe(0);
    expect(await result.log()).toBeUndefined();
    expect(await result.calls()).toEqual([
      "tsc --noEmit",
      "biome check .",
      "vitest run --exclude tests/acceptance/** --passWithNoTests --retry=0",
      "docker info",
      "docker compose -f compose.yaml config -q",
      "docker compose -f compose.yaml up -d --wait",
      "npm run --silent migrate",
      "vitest run tests/acceptance --retry=0 -t ^AC-12:",
      "vitest run tests/acceptance --retry=0",
    ]);
  });

  it("skips disabled steps and the task filter when no task is given", async () => {
    const p = await project({ steps: "acceptance" });
    const result = verify(p);
    expect(result.code).toBe(0);
    expect(await result.calls()).toEqual(["vitest run tests/acceptance --retry=0"]);
  });

  it("runs without colour", async () => {
    const p = await project({ steps: "typecheck" });
    await p.write(
      "node_modules/.bin/tsc",
      '#!/bin/sh\necho "$NO_COLOR $FORCE_COLOR $CI" > env.txt\n',
      0o755,
    );
    expect(verify(p).code).toBe(0);
    expect(await readFile(join(p.root, "env.txt"), "utf8")).toBe("1 0 1\n");
  });
});

describe("verify.sh failures", () => {
  it.each([
    ["typecheck", { STUB_TSC: "1" }, 1, 1],
    ["lint", { STUB_BIOME: "1" }, 1, 2],
    ["unit", { STUB_VITEST_UNIT: "1" }, 1, 3],
    ["infra", { STUB_DOCKER_INFO: "1" }, 2, 4],
    ["infra", { STUB_DOCKER_CONFIG: "1" }, 1, 5],
    ["infra", { STUB_DOCKER_UP: "1" }, 2, 6],
    ["migrate", { STUB_NPM: "1" }, 1, 7],
    ["acceptance AC-1", { STUB_VITEST_TASK: "1" }, 1, 8],
    ["acceptance", { STUB_VITEST_ACCEPTANCE: "1" }, 1, 9],
  ] as const)("stops at %s with exit %s (%j)", async (step, env, code, calls) => {
    const p = await project();
    const result = verify(p, ["AC-1"], env);
    expect(result.code).toBe(code);
    expect(result.stderr).toContain(`verify: FAIL at ${step} (exit ${code})`);
    expect(await result.calls()).toHaveLength(calls);
    const log = await result.log();
    expect(log).toMatch(new RegExp(`^step: ${step}\nexit: ${code}\ncommand: `));
    expect(log).toContain("output");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting ANSI was stripped
    expect(log).not.toMatch(/\u001b/);
  });

  it("keeps only the last THEMIS_LOG_LINES lines", async () => {
    const p = await project({ steps: "typecheck" });
    const log = await verify(p, [], { STUB_TSC: "1", THEMIS_LOG_LINES: "2" }).log();
    expect(log).toBe(
      "step: typecheck\nexit: 1\ncommand: " +
        `${p.root}/node_modules/.bin/tsc --noEmit\n--- last 2 lines of output ---\ntsc line 4\ntsc line 5\n`,
    );
  });

  it("treats a command that cannot run as an environment problem", async () => {
    const p = await project({ steps: "typecheck" });
    await p.write("node_modules/.bin/tsc", "#!/bin/sh\nexit 127\n", 0o755);
    expect(verify(p).code).toBe(2);
  });

  it("exits 2 for a missing binary", async () => {
    const p = await project({ steps: "lint" });
    const { rm } = await import("node:fs/promises");
    await rm(join(p.root, "node_modules/.bin/biome"));
    const result = verify(p);
    expect(result.code).toBe(2);
    expect(await result.log()).toContain("message: biome is not installed; run npm install");
  });

  it("exits 2 without node_modules", async () => {
    const p = await project();
    const { rm } = await import("node:fs/promises");
    await rm(join(p.root, "node_modules"), { recursive: true });
    const result = verify(p);
    expect(result.code).toBe(2);
    expect(await result.log()).toContain("step: preflight");
  });

  it.each(["AC-01", "ac-1", "AC-1;rm"])("exits 2 for invalid task id %s", async (id) => {
    const p = await project();
    expect(verify(p, [id]).code).toBe(2);
    expect(await verify(p, [id]).calls()).toEqual([]);
  });

  it("exits 1 when the guard finds a violation, before any other step", async () => {
    const p = await project();
    await p.write("src/a.ts", "export const a = 1 as any;\n");
    const result = verify(p);
    expect(result.code).toBe(1);
    expect(await result.calls()).toEqual([]);
    expect(await result.log()).toContain('src/a.ts:1: forbidden marker "as any"');
  });

  it("passes through the guard's environment errors", async () => {
    const p = await project();
    await p.write(".themis/lock.json", "{");
    const result = verify(p);
    expect(result.code).toBe(2);
    expect(await result.log()).toMatch(/^step: guard\nexit: 2/);
  });

  it("exits 1 when infra is enabled but there is no compose file", async () => {
    const p = await project();
    const { rm } = await import("node:fs/promises");
    await rm(join(p.root, "compose.yaml"));
    const result = verify(p);
    expect(result.code).toBe(1);
    const log = await result.log();
    expect(log).toContain("message: infra is enabled but there is no compose file");
    expect(log).not.toContain("output");
  });

  it("exits 1 when migrate is enabled but there is no script", async () => {
    const p = await project();
    await p.write("package.json", JSON.stringify({ type: "module" }));
    const result = verify(p);
    expect(result.code).toBe(1);
    expect(await result.log()).toContain('package.json has no "migrate" script');
  });

  it("exits 2 at acceptance when the contract is not locked", async () => {
    const p = await project({ locked: false });
    const result = verify(p);
    expect(result.code).toBe(2);
    expect(await result.log()).toContain("contract not locked: run themis approve tests");
  });
});
