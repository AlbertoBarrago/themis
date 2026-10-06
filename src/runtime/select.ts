import type { Executor } from "./executor.js";
import { LimaExecutor } from "./lima-executor.js";

export const EXECUTORS = ["local", "lima"] as const;

/**
 * Builds the executor named on the command line around the host executor. `lima` runs every
 * command in the VM named by `THEMIS_LIMA_INSTANCE` (default `themis`), see ADR 0013.
 */
export function executorFor(
  name: string,
  host: Executor,
  env: NodeJS.ProcessEnv = process.env,
): Executor | undefined {
  if (name === "local") return host;
  if (name === "lima")
    return new LimaExecutor({ host, instance: env.THEMIS_LIMA_INSTANCE || "themis" });
  return undefined;
}
