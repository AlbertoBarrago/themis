import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chooseExecutor,
  LocalConfigError,
  readLocalConfig,
} from "../../src/runtime/local-config.js";

describe("chooseExecutor", () => {
  it("prefers the flag, then the record, then local", () => {
    expect(chooseExecutor(undefined, undefined)).toEqual({ kind: "ok", name: "local" });
    expect(chooseExecutor(undefined, { executor: "lima" })).toEqual({ kind: "ok", name: "lima" });
    expect(chooseExecutor("lima", undefined)).toEqual({ kind: "ok", name: "lima" });
    expect(chooseExecutor("lima", { executor: "lima" })).toEqual({ kind: "ok", name: "lima" });
  });

  it("reports a flag that contradicts the record, but leaves unknown names to the caller", () => {
    expect(chooseExecutor("local", { executor: "lima" })).toEqual({
      kind: "conflict",
      requested: "local",
      recorded: "lima",
    });
    expect(chooseExecutor("docker", { executor: "lima" })).toEqual({ kind: "ok", name: "docker" });
  });
});

describe("readLocalConfig", () => {
  async function project(content?: string) {
    const root = await mkdtemp(join(tmpdir(), "themis-local-"));
    if (content !== undefined) {
      await mkdir(join(root, ".themis"));
      await writeFile(join(root, ".themis/local.json"), content);
    }
    return root;
  }

  it("returns undefined for a project initialised before the record existed", async () => {
    expect(await readLocalConfig(await project())).toBeUndefined();
  });

  it("reads a valid record and rejects anything else", async () => {
    expect(await readLocalConfig(await project('{"executor":"lima"}'))).toEqual({
      executor: "lima",
    });
    await expect(readLocalConfig(await project("{"))).rejects.toThrow(LocalConfigError);
    await expect(readLocalConfig(await project('{"executor":"lima","x":1}'))).rejects.toThrow(
      '.themis/local.json is invalid: expected { "executor": "local" | "lima" }',
    );
  });
});
