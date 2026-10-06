import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { initCommand } from "../../src/cli/commands/init.js";
import { FakeExecutor } from "../fakes/executor.js";
import { lines, VALID_BODY } from "../helpers.js";

let root: string;
let out: string;
let err: string;

const SPEC = lines(
  "---",
  "ordito: 0.1",
  "stack: node-ts",
  "verify: [typecheck, lint, unit, acceptance]",
  "---",
  ...VALID_BODY,
);

/** Git reports a work tree, npm install succeeds: the happy path. */
function okExecutor() {
  return new FakeExecutor({
    git: () => ({ stdout: "true\n" }),
    npm: () => ({}),
  });
}

async function run(executor: FakeExecutor, ...args: string[]) {
  out = "";
  err = "";
  return initCommand(
    args,
    {
      cwd: root,
      stdout: (t) => {
        out += t;
      },
      stderr: (t) => {
        err += t;
      },
    },
    executor,
  );
}

async function read(path: string) {
  return readFile(join(root, path), "utf8");
}

async function exists(path: string) {
  return access(join(root, path)).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ordito-init-"));
});

describe("ordito init in an empty directory", () => {
  beforeEach(async () => {
    await writeFile(join(root, "spec.md"), SPEC);
  });

  it("scaffolds the project, writes .ordito and installs dependencies", async () => {
    const executor = okExecutor();
    expect(await run(executor)).toBe(0);
    expect(err).toBe("");

    for (const path of [
      "package.json",
      "tsconfig.json",
      "biome.json",
      "vitest.config.ts",
      ".gitignore",
      ".claude/settings.json",
      ".ordito/verify.sh",
      ".ordito/guard.mjs",
      ".ordito/agents/planner.md",
      ".ordito/agents/worker.md",
      ".ordito/agents/reviewer.md",
      ".ordito/agents/retro.md",
    ]) {
      expect(await exists(path), path).toBe(true);
    }
    expect(out).toContain("scaffolded a new node-ts project");
    expect(out).toContain("created   .ordito/verify.sh");

    const pkg = JSON.parse(await read("package.json"));
    expect(pkg.name).toMatch(/^ordito-init-/);
    expect(pkg.type).toBe("module");

    expect(executor.requests.map((r) => [r.command, ...r.args])).toEqual([
      ["git", "rev-parse", "--is-inside-work-tree"],
      ["npm", "install", "--no-audit", "--no-fund"],
    ]);
  });

  it("bakes the enabled steps into an executable verify.sh", async () => {
    await run(okExecutor());
    const verify = await read(".ordito/verify.sh");
    expect(verify).toContain('STEPS="typecheck lint unit acceptance"');
    expect(verify).not.toContain("__ORDITO_");
    expect((await stat(join(root, ".ordito/verify.sh"))).mode & 0o111).not.toBe(0);
  });

  it("protects the contract in the agent settings", async () => {
    await run(okExecutor());
    const settings = JSON.parse(await read(".claude/settings.json"));
    expect(settings.permissions.deny).toEqual([
      "Edit(/tests/acceptance/**)",
      "Edit(/.ordito/**)",
      "Edit(/spec.md)",
      "Edit(/tsconfig.json)",
      "Edit(/biome.json)",
      "Edit(/vitest.config.ts)",
      "Edit(/.claude/settings.json)",
    ]);
  });

  it("is idempotent", async () => {
    await run(okExecutor());
    expect(await run(okExecutor(), "--skip-install")).toBe(0);
    expect(out).not.toMatch(/^(created|updated|skipped)/m);
    expect(out).toContain("unchanged .ordito/verify.sh");
  });

  it("skips locally modified files unless --force", async () => {
    await run(okExecutor());
    await writeFile(join(root, ".ordito/verify.sh"), "#!/bin/sh\nexit 0\n");
    expect(await run(okExecutor())).toBe(0);
    expect(out).toContain("skipped   .ordito/verify.sh");
    expect(err).toContain("warning: .ordito/verify.sh was not updated");
    expect(await read(".ordito/verify.sh")).toBe("#!/bin/sh\nexit 0\n");

    expect(await run(okExecutor(), "--force")).toBe(0);
    expect(out).toContain("updated   .ordito/verify.sh");
    expect(await read(".ordito/verify.sh")).toContain("Ordito verifier");
  });

  it("does not run npm with --skip-install", async () => {
    const executor = okExecutor();
    expect(await run(executor, "--skip-install")).toBe(0);
    expect(executor.requests.map((r) => r.command)).toEqual(["git"]);
    expect(out).toContain("run npm install");
  });

  it("exits 2 when npm install fails", async () => {
    const executor = new FakeExecutor({
      git: () => ({ stdout: "true\n" }),
      npm: () => ({ exitCode: 1, stderr: "npm ERR! network" }),
    });
    expect(await run(executor)).toBe(2);
    expect(err).toContain("npm install exited with 1");
    expect(err).toContain("npm ERR! network");
  });

  it("warns outside a git repository", async () => {
    expect(await run(new FakeExecutor({ npm: () => ({}) }))).toBe(0);
    expect(err).toContain("warning: not a git repository");
  });
});

describe("ordito init refusals", () => {
  it("exits 2 without a spec and writes nothing", async () => {
    expect(await run(okExecutor())).toBe(2);
    expect(err).toContain("spec.md not found");
    expect(await exists(".ordito")).toBe(false);
  });

  it("exits 1 for an invalid spec and writes nothing", async () => {
    await writeFile(join(root, "spec.md"), "# no frontmatter\n");
    expect(await run(okExecutor())).toBe(1);
    expect(out).toContain("spec.md:1:1: error[frontmatter-missing]");
    expect(await exists(".ordito")).toBe(false);
  });

  it("honours --spec", async () => {
    await mkdir(join(root, "specs"));
    await writeFile(join(root, "specs/feature.md"), SPEC);
    expect(await run(okExecutor(), "--spec", "./specs/feature.md")).toBe(0);
    const settings = JSON.parse(await read(".claude/settings.json"));
    expect(settings.permissions.deny).toContain("Edit(/specs/feature.md)");
  });

  it("exits 2 for an existing project that is not node-ts shaped, writing nothing", async () => {
    await writeFile(join(root, "spec.md"), SPEC);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "x", dependencies: {} }));
    expect(await run(okExecutor())).toBe(2);
    expect(err).toContain('package.json must set "type": "module"');
    expect(err).toContain('missing dependency "typescript"');
    expect(err).toContain('missing dependency "@biomejs/biome"');
    expect(err).toContain("missing tsconfig.json");
    expect(await exists(".ordito")).toBe(false);
    expect(await exists(".claude")).toBe(false);
  });

  it("exits 2 on malformed agent settings, writing nothing else", async () => {
    await writeFile(join(root, "spec.md"), SPEC);
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.json"), "{ nope");
    expect(await run(okExecutor())).toBe(2);
    expect(err).toContain("not valid JSON");
    expect(await exists(".ordito")).toBe(false);
  });

  it("exits 2 for an unknown agent", async () => {
    await writeFile(join(root, "spec.md"), SPEC);
    expect(await run(okExecutor(), "--agent", "nope")).toBe(2);
    expect(err).toContain('unknown agent "nope" (available: claude-code)');
  });
});

describe("ordito init in an existing node-ts project", () => {
  beforeEach(async () => {
    await writeFile(join(root, "spec.md"), SPEC);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "existing",
        type: "module",
        devDependencies: { typescript: "*", vitest: "*", "@biomejs/biome": "*" },
      }),
    );
    for (const file of ["tsconfig.json", "vitest.config.ts", "biome.json"]) {
      await writeFile(join(root, file), "// mine\n");
    }
    await writeFile(join(root, ".gitignore"), "coverage/\nnode_modules/");
  });

  it("leaves project files alone and merges .gitignore", async () => {
    await mkdir(join(root, "node_modules"));
    const executor = okExecutor();
    expect(await run(executor)).toBe(0);
    expect(out).not.toContain("scaffolded");
    expect(await read("tsconfig.json")).toBe("// mine\n");
    expect(JSON.parse(await read("package.json")).name).toBe("existing");
    expect(await read(".gitignore")).toBe(
      "coverage/\nnode_modules/\n\n# Ordito\ndist/\n.verify.log\n.ordito/runs/\n.ordito/state.json\n.ordito/worktrees/\n",
    );
    expect(executor.requests.map((r) => r.command)).toEqual(["git"]);
  });

  it("installs dependencies when node_modules is missing", async () => {
    const executor = okExecutor();
    expect(await run(executor)).toBe(0);
    expect(executor.requests.map((r) => r.command)).toEqual(["git", "npm"]);
  });
});
