import { access } from "node:fs/promises";
import { join } from "node:path";
import { isNotFound, readIfExists } from "../../fs/generated.js";
import type { VerifyStep } from "../../spec/types.js";

export type Detection =
  | { kind: "empty" }
  | { kind: "node-ts"; hasNodeModules: boolean }
  | { kind: "incompatible"; problems: string[] };

/**
 * Classifies the target directory. A directory without `package.json` is scaffolded; an
 * existing project is accepted only if it already has what the generated verifier calls,
 * because `init` never rewrites an existing project (ADR 0008).
 */
export async function detectNodeTs(
  root: string,
  verify: readonly VerifyStep[],
): Promise<Detection> {
  const source = await readIfExists(join(root, "package.json"));
  if (source === undefined) return { kind: "empty" };

  let pkg: unknown;
  try {
    pkg = JSON.parse(source);
  } catch (err) {
    return {
      kind: "incompatible",
      problems: [
        `package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  const deps = dependencyNames(pkg);
  const problems: string[] = [];
  if (!isObject(pkg) || pkg.type !== "module")
    problems.push('package.json must set "type": "module"');
  for (const name of ["typescript", "vitest"]) {
    if (!deps.has(name)) problems.push(`missing dependency "${name}"`);
  }
  if (verify.includes("lint") && !deps.has("@biomejs/biome")) {
    problems.push('missing dependency "@biomejs/biome" (required by the lint step)');
  }
  for (const file of ["tsconfig.json", "vitest.config.ts"]) {
    if (!(await exists(join(root, file)))) problems.push(`missing ${file}`);
  }
  if (verify.includes("lint") && !(await exists(join(root, "biome.json")))) {
    problems.push("missing biome.json (required by the lint step)");
  }
  if (problems.length > 0) return { kind: "incompatible", problems };
  return { kind: "node-ts", hasNodeModules: await exists(join(root, "node_modules")) };
}

function dependencyNames(pkg: unknown): Set<string> {
  const names = new Set<string>();
  if (!isObject(pkg)) return names;
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg[field];
    if (isObject(deps)) for (const name of Object.keys(deps)) names.add(name);
  }
  return names;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}
