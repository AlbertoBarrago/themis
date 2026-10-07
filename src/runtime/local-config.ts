import { join } from "node:path";
import { z } from "zod";
import { readIfExists } from "../fs/generated.js";
import { EXECUTORS, type ExecutorName, isExecutorName } from "./select.js";

/**
 * Per-checkout settings, gitignored: they describe how this copy of the project was set up,
 * not the project itself. Today only the executor `themis init` installed `node_modules` with,
 * because native binaries (TypeScript, Biome) differ between the host and the VM.
 */
export const LOCAL_CONFIG_PATH = ".themis/local.json";

const schema = z.strictObject({ executor: z.enum(EXECUTORS) });
export type LocalConfig = z.infer<typeof schema>;

export class LocalConfigError extends Error {
  override readonly name = "LocalConfigError";
}

/** Returns `undefined` for a project initialised before this file existed. */
export async function readLocalConfig(root: string): Promise<LocalConfig | undefined> {
  const source = await readIfExists(join(root, LOCAL_CONFIG_PATH));
  if (source === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new LocalConfigError(`${LOCAL_CONFIG_PATH} is not valid JSON`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new LocalConfigError(
      `${LOCAL_CONFIG_PATH} is invalid: expected { "executor": "${EXECUTORS.join('" | "')}" }`,
    );
  return parsed.data;
}

export function renderLocalConfig(config: LocalConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * The executor a command uses: the one given with `--executor`, else the one recorded by
 * `themis init`, else `local`. A flag that contradicts the record is returned as a conflict,
 * because running against `node_modules` installed elsewhere fails in confusing ways (a
 * TypeScript crash reported as a type error, iterations spent on nothing).
 */
export function chooseExecutor(
  flag: string | undefined,
  recorded: LocalConfig | undefined,
): { kind: "ok"; name: string } | { kind: "conflict"; requested: string; recorded: ExecutorName } {
  if (flag === undefined) return { kind: "ok", name: recorded?.executor ?? "local" };
  // An unknown name is not a conflict: the caller reports it as unknown.
  if (recorded !== undefined && isExecutorName(flag) && flag !== recorded.executor)
    return { kind: "conflict", requested: flag, recorded: recorded.executor };
  return { kind: "ok", name: flag };
}
