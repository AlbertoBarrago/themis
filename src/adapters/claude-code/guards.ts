import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type FileChange, readIfExists } from "../../fs/generated.js";
import { GuardInstallError, type GuardInstaller, type GuardSpec } from "../guard-installer.js";

const SETTINGS_PATH = ".claude/settings.json";

/**
 * Converts a protected path into a Claude Code deny rule.
 *
 * `Edit(...)` covers every built-in file-editing tool (Write, MultiEdit, NotebookEdit too), and
 * the leading `/` anchors the pattern to the project root rather than matching at any depth.
 * See https://code.claude.com/docs/en/permissions.md and ADR 0006.
 */
export function denyRule(path: string): string {
  return `Edit(/${path.replace(/^\/+/, "")})`;
}

/**
 * Merges deny rules into `.claude/settings.json`, preserving every unrelated key and existing
 * rule. Refuses to touch a file it cannot parse rather than overwrite user configuration.
 */
export class ClaudeCodeGuardInstaller implements GuardInstaller {
  readonly agent = "claude-code";
  readonly configFiles = [SETTINGS_PATH] as const;

  async installGuards(root: string, spec: GuardSpec): Promise<FileChange[]> {
    const absolute = join(root, SETTINGS_PATH);
    const existing = await readIfExists(absolute);
    const settings = existing === undefined ? {} : parseSettings(existing);

    const permissions = objectField(settings, "permissions");
    const deny = stringArrayField(permissions, "deny");
    const wanted = [...spec.protectedPaths, ...this.configFiles].map(denyRule);
    const missing = wanted.filter((rule) => !deny.includes(rule));
    if (missing.length === 0 && existing !== undefined) {
      return [{ path: SETTINGS_PATH, status: "unchanged" }];
    }

    permissions.deny = [...deny, ...missing];
    settings.permissions = permissions;
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(settings, null, 2)}\n`);
    return [{ path: SETTINGS_PATH, status: existing === undefined ? "created" : "updated" }];
  }
}

type JsonObject = Record<string, unknown>;

function parseSettings(source: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    throw new GuardInstallError(
      `${SETTINGS_PATH} is not valid JSON (${err instanceof Error ? err.message : String(err)}); fix it and re-run`,
    );
  }
  if (!isObject(parsed)) {
    throw new GuardInstallError(`${SETTINGS_PATH} must contain a JSON object`);
  }
  return parsed;
}

function objectField(parent: JsonObject, key: string): JsonObject {
  const value = parent[key];
  if (value === undefined) return {};
  if (!isObject(value)) throw new GuardInstallError(`${SETTINGS_PATH}: "${key}" must be an object`);
  return value;
}

function stringArrayField(parent: JsonObject, key: string): string[] {
  const value = parent[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new GuardInstallError(
      `${SETTINGS_PATH}: "permissions.${key}" must be an array of strings`,
    );
  }
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
