import { basename } from "node:path";
import type { Frontmatter } from "../../spec/types.js";
import { readTemplate, render } from "../../templates.js";
import { AGENT_ROLES_TEMPLATES, AGENTS_DIR, GUARD_SCRIPT, VERIFY_SCRIPT } from "./contract.js";

export interface GeneratedFile {
  path: string;
  content: string;
  mode?: number;
}

/** Themis's own files under `.themis/`, generated in every project. */
export async function themisFiles(frontmatter: Frontmatter): Promise<GeneratedFile[]> {
  const verify = render(await readTemplate("node-ts/verify.sh"), {
    STEPS: frontmatter.verify.join(" "),
  });
  const files: GeneratedFile[] = [
    { path: VERIFY_SCRIPT, content: verify, mode: 0o755 },
    { path: GUARD_SCRIPT, content: await readTemplate("node-ts/guard.mjs"), mode: 0o755 },
  ];
  for (const role of AGENT_ROLES_TEMPLATES) {
    files.push({
      path: `${AGENTS_DIR}/${role}.md`,
      content: await readTemplate(`agents/${role}.md`),
    });
  }
  return files;
}

/** Project skeleton for an empty directory (ADR 0008). */
export async function scaffoldFiles(root: string): Promise<GeneratedFile[]> {
  return [
    {
      path: "package.json",
      content: render(await readTemplate("node-ts/package.json.tmpl"), {
        NAME: packageName(basename(root)),
      }),
    },
    { path: "tsconfig.json", content: await readTemplate("node-ts/tsconfig.json.tmpl") },
    { path: "biome.json", content: await readTemplate("node-ts/biome.json.tmpl") },
    { path: "vitest.config.ts", content: await readTemplate("node-ts/vitest.config.ts") },
  ];
}

/** Lines `init` makes sure are present in `.gitignore`. */
export async function gitignoreEntries(): Promise<string[]> {
  return (await readTemplate("node-ts/gitignore.tmpl")).split("\n").filter((l) => l.trim() !== "");
}

/** Turns a directory name into a valid npm package name. */
export function packageName(directory: string): string {
  const name = directory
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[-]+$/g, "");
  return name === "" ? "service" : name.slice(0, 214);
}
