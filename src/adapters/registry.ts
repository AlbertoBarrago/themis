import { ClaudeCodeGuardInstaller } from "./claude-code/guards.js";
import type { GuardInstaller } from "./guard-installer.js";

/**
 * The only module allowed to import concrete agent adapters. Everything else depends on the
 * capability interfaces, so supporting another agent means adding an entry here.
 */
const GUARD_INSTALLERS: Record<string, () => GuardInstaller> = {
  "claude-code": () => new ClaudeCodeGuardInstaller(),
};

export const DEFAULT_AGENT = "claude-code";

export function availableAgents(): string[] {
  return Object.keys(GUARD_INSTALLERS);
}

/** Returns `undefined` for an unknown agent name; callers report it as a usage error. */
export function guardInstallerFor(agent: string): GuardInstaller | undefined {
  return GUARD_INSTALLERS[agent]?.();
}
