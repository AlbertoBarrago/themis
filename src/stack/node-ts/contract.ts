/**
 * Paths that make up the node-ts contract. Agents must not modify them (enforced by the
 * guard step and, as defense in depth, by agent-side protections), and `ordito approve tests`
 * locks the files among them.
 */
export const ACCEPTANCE_DIR = "tests/acceptance";
export const VERIFY_SCRIPT = ".ordito/verify.sh";
export const GUARD_SCRIPT = ".ordito/guard.mjs";
export const AGENTS_DIR = ".ordito/agents";

/** Tool configuration that could weaken verification if an agent changed it. */
export const TOOL_CONFIG_FILES = ["tsconfig.json", "biome.json", "vitest.config.ts"] as const;

export const AGENT_ROLES_TEMPLATES = ["planner", "worker", "reviewer", "retro"] as const;

/**
 * Everything agents must not write. `.ordito/` is protected as a whole: only the CLI writes
 * there (tasks, state, run logs).
 *
 * @param specPath Project-relative path of the spec.
 */
export function protectedPaths(specPath: string): string[] {
  return [`${ACCEPTANCE_DIR}/**`, ".ordito/**", specPath, ...TOOL_CONFIG_FILES];
}
