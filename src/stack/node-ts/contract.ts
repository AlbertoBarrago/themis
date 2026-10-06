/**
 * Paths that make up the node-ts contract. Agents must not modify them (enforced by the
 * guard step and, as defense in depth, by agent-side protections), and `themis approve tests`
 * locks the files among them.
 */
export const ACCEPTANCE_DIR = "tests/acceptance";
export const VERIFY_SCRIPT = ".themis/verify.sh";
export const GUARD_SCRIPT = ".themis/guard.mjs";
export const AGENTS_DIR = ".themis/agents";

/** Tool configuration that could weaken verification if an agent changed it. */
export const TOOL_CONFIG_FILES = ["tsconfig.json", "biome.json", "vitest.config.ts"] as const;

export const AGENT_ROLES_TEMPLATES = [
  "planner",
  "test-author",
  "worker",
  "reviewer",
  "retro",
] as const;

export const LOCK_PATH = ".themis/lock.json";

/**
 * Markers that let code or tests dodge verification. Mirrors `MARKERS` in
 * `templates/node-ts/guard.mjs` (a test keeps them in sync) and SPEC_FORMAT.md section 6.2.
 */
export const FORBIDDEN_MARKERS: ReadonlyArray<readonly [string, RegExp]> = [
  [".only(", /\.only\(/],
  [".skip(", /\.skip\(/],
  [".todo(", /\.todo\(/],
  ["@ts-ignore", /@ts-ignore/],
  ["@ts-nocheck", /@ts-nocheck/],
  ["@ts-expect-error", /@ts-expect-error/],
  ["as any", /\bas\s+any\b/],
  ["eslint-disable", /eslint-disable/],
  ["biome-ignore", /biome-ignore/],
  ["oxlint-disable", /oxlint-disable/],
];

/**
 * Files whose digests `themis approve tests` records, besides everything under
 * {@link ACCEPTANCE_DIR}. Optional files are locked only when present.
 */
export function contractFiles(specPath: string): { required: string[]; optional: string[] } {
  return {
    required: [specPath, VERIFY_SCRIPT, GUARD_SCRIPT],
    optional: [...TOOL_CONFIG_FILES],
  };
}

/**
 * Everything agents must not write. `.themis/` is protected as a whole: only the CLI writes
 * there (tasks, state, run logs).
 *
 * @param specPath Project-relative path of the spec.
 */
export function protectedPaths(specPath: string): string[] {
  return [`${ACCEPTANCE_DIR}/**`, ".themis/**", specPath, ...TOOL_CONFIG_FILES];
}
