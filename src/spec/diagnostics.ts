/**
 * Stable diagnostic codes, mirrored in SPEC_FORMAT.md section 7.
 * Codes are part of the public contract: tools and agents may match on them.
 */
export type DiagnosticCode =
  | "frontmatter-missing"
  | "frontmatter-unclosed"
  | "yaml-syntax"
  | "frontmatter-not-mapping"
  | "unsupported-version"
  | "unknown-field"
  | "invalid-field"
  | "title-missing"
  | "title-duplicate"
  | "content-before-title"
  | "decisions-duplicate"
  | "decisions-missing"
  | "ac-heading-malformed"
  | "ac-duplicate"
  | "ac-no-clauses"
  | "ac-missing-then"
  | "no-acceptance-criteria"
  | "depends-malformed"
  | "depends-duplicate"
  | "depends-misplaced"
  | "depends-unknown"
  | "depends-self"
  | "depends-cycle";

export type Severity = "error" | "warning";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  /** 1-based line in the spec file. */
  line: number;
  /** 1-based column in the spec file. */
  column: number;
  /** Dotted frontmatter path (e.g. `limits.parallel`), only for frontmatter diagnostics. */
  field?: string;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

/** Sorts by position so output reads top to bottom regardless of which pass found what. */
export function sortDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  return [...diagnostics].sort((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Formats a diagnostic in the conventional `file:line:col: severity[code] field: message`
 * shape, which editors and terminals recognise as a clickable location.
 */
export function formatDiagnostic(file: string, d: Diagnostic): string {
  const field = d.field === undefined ? "" : ` ${d.field}:`;
  return `${file}:${d.line}:${d.column}: ${d.severity}[${d.code}]${field} ${d.message}`;
}

export function error(
  code: DiagnosticCode,
  message: string,
  line: number,
  column: number,
  field?: string,
): Diagnostic {
  const d: Diagnostic = { code, severity: "error", message, line, column };
  if (field !== undefined) d.field = field;
  return d;
}

export function warning(
  code: DiagnosticCode,
  message: string,
  line: number,
  column: number,
): Diagnostic {
  return { code, severity: "warning", message, line, column };
}
