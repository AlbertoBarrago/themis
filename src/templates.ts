import { readFile } from "node:fs/promises";

/**
 * Root of the shipped `templates/` directory. Both `src/templates.ts` and the compiled
 * `dist/templates.js` sit one level below the package root.
 */
const TEMPLATES_ROOT = new URL("../templates/", import.meta.url);

/** Reads a template by its path relative to `templates/`. */
export function readTemplate(path: string): Promise<string> {
  return readFile(new URL(path, TEMPLATES_ROOT), "utf8");
}

/** Replaces `__ORDITO_<KEY>__` placeholders; a placeholder left unreplaced is a bug. */
export function render(template: string, values: Readonly<Record<string, string>>): string {
  const out = template.replace(/__ORDITO_([A-Z_]+)__/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`template placeholder ${match} has no value`);
    return value;
  });
  return out;
}
