import { parseSpec } from "../src/spec/parse.js";

/** Joins lines so test fixtures read with explicit, countable line numbers. */
export function lines(...rows: string[]): string {
  return rows.join("\n");
}

export const VALID_FRONTMATTER = [
  "---",
  "themis: 0.1",
  "stack: node-ts",
  "verify: [typecheck, acceptance]",
  "---",
];

/** A minimal valid body, to be combined with a frontmatter under test. */
export const VALID_BODY = [
  "",
  "# Service",
  "",
  "## Decisions",
  "- Use Node.",
  "",
  "## AC-1 First",
  "Depends: none",
  "- Given x",
  "- Then y",
];

/** Diagnostics reduced to the fields assertions care about. */
export function diag(source: string) {
  return parseSpec(source).diagnostics.map(({ code, severity, line, column, field }) => ({
    code,
    severity,
    line,
    column,
    ...(field === undefined ? {} : { field }),
  }));
}
