import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TEMPLATES = new URL("../../templates/node-ts/", import.meta.url);

/** A throwaway project directory with helpers for the generated scripts. */
export class Project {
  private constructor(readonly root: string) {}

  static async create(prefix: string): Promise<Project> {
    const project = new Project(await mkdtemp(join(tmpdir(), `ordito-${prefix}-`)));
    await mkdir(join(project.root, ".ordito"));
    await copyFile(new URL("guard.mjs", TEMPLATES), join(project.root, ".ordito/guard.mjs"));
    return project;
  }

  async write(path: string, content: string, mode?: number): Promise<void> {
    await mkdir(dirname(join(this.root, path)), { recursive: true });
    await writeFile(join(this.root, path), content, mode === undefined ? {} : { mode });
  }

  /** Writes `.ordito/lock.json` with the current digests of `files`. */
  async lock(files: string[], options: { dirs?: string[]; base?: string | null } = {}) {
    const digests: Record<string, string> = {};
    const { readFile } = await import("node:fs/promises");
    for (const file of files) {
      digests[file] = createHash("sha256")
        .update(await readFile(join(this.root, file)))
        .digest("hex");
    }
    await this.write(
      ".ordito/lock.json",
      JSON.stringify({
        ordito: "0.1",
        lockedAt: new Date(0).toISOString(),
        base: options.base ?? null,
        dirs: options.dirs ?? [],
        files: digests,
      }),
    );
  }

  git(...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  }

  run(command: string, args: string[], env: Record<string, string> = {}) {
    const result = spawnSync(command, args, {
      cwd: this.root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  guard() {
    return this.run(process.execPath, [".ordito/guard.mjs"]);
  }
}
