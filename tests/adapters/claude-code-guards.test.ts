import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ClaudeCodeGuardInstaller, denyRule } from "../../src/adapters/claude-code/guards.js";
import { GuardInstallError } from "../../src/adapters/guard-installer.js";

let root: string;
const installer = new ClaudeCodeGuardInstaller();
const spec = { protectedPaths: ["tests/acceptance/**", "spec.md"] };

async function settings(): Promise<unknown> {
  return JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8"));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ordito-guards-"));
});

describe("ClaudeCodeGuardInstaller", () => {
  it("anchors rules to the project root with Edit()", () => {
    expect(denyRule("tests/acceptance/**")).toBe("Edit(/tests/acceptance/**)");
    expect(denyRule("/spec.md")).toBe("Edit(/spec.md)");
  });

  it("creates settings with deny rules, protecting its own file too", async () => {
    expect(await installer.installGuards(root, spec)).toEqual([
      { path: ".claude/settings.json", status: "created" },
    ]);
    expect(await settings()).toEqual({
      permissions: {
        deny: ["Edit(/tests/acceptance/**)", "Edit(/spec.md)", "Edit(/.claude/settings.json)"],
      },
    });
  });

  it("merges into existing settings and is idempotent", async () => {
    await mkdir(join(root, ".claude"));
    await writeFile(
      join(root, ".claude/settings.json"),
      JSON.stringify({
        model: "x",
        permissions: { allow: ["Bash(ls)"], deny: ["Edit(/spec.md)"] },
      }),
    );
    expect((await installer.installGuards(root, spec))[0]?.status).toBe("updated");
    expect(await settings()).toEqual({
      model: "x",
      permissions: {
        allow: ["Bash(ls)"],
        deny: ["Edit(/spec.md)", "Edit(/tests/acceptance/**)", "Edit(/.claude/settings.json)"],
      },
    });
    expect((await installer.installGuards(root, spec))[0]?.status).toBe("unchanged");
  });

  it.each([
    ["{ not json", /not valid JSON/],
    ["[]", /JSON object/],
    ['{"permissions": []}', /"permissions" must be an object/],
    ['{"permissions": {"deny": [1]}}', /array of strings/],
  ])("refuses to overwrite malformed settings %s", async (content, message) => {
    await mkdir(join(root, ".claude"));
    await writeFile(join(root, ".claude/settings.json"), content);
    const attempt = installer.installGuards(root, spec);
    await expect(attempt).rejects.toBeInstanceOf(GuardInstallError);
    await expect(installer.installGuards(root, spec)).rejects.toThrow(message);
    expect(await readFile(join(root, ".claude/settings.json"), "utf8")).toBe(content);
  });
});
