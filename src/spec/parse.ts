import { parseBody } from "./body.js";
import { type Diagnostic, error, hasErrors, sortDiagnostics } from "./diagnostics.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { Spec } from "./types.js";
import { validateBody } from "./validate.js";

export interface ParseResult {
  /** Present only when there are no errors (warnings are allowed). */
  spec?: Spec;
  /** Every problem found, sorted by position. */
  diagnostics: Diagnostic[];
}

/**
 * Parses and validates a `spec.md` source.
 *
 * Collects every diagnostic instead of stopping at the first one, so a human fixing a spec
 * sees all problems at once. The body is still analysed when the frontmatter is invalid.
 */
export function parseSpec(source: string): ParseResult {
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);

  const fm = parseFrontmatter(lines);
  const body = parseBody(lines, fm.bodyStart);
  const diagnostics: Diagnostic[] = [...fm.diagnostics, ...body.diagnostics];

  const titleLine = fm.bodyStart + 1;
  if (body.title === undefined || body.title === "") {
    diagnostics.push(
      error(
        "title-missing",
        body.title === undefined ? "spec has no `# <name>` title" : "title is empty",
        titleLine,
        1,
      ),
    );
  }
  diagnostics.push(
    ...validateBody({
      titleLine,
      decisionsLine: body.decisionsLine,
      decisions: body.decisions,
      criteria: body.criteria,
    }),
  );

  const sorted = sortDiagnostics(diagnostics);
  if (hasErrors(sorted) || fm.frontmatter === undefined || body.title === undefined) {
    return { diagnostics: sorted };
  }
  return {
    spec: {
      frontmatter: fm.frontmatter,
      title: body.title,
      decisions: body.decisions,
      criteria: body.criteria.map(({ dependsRefs: _refs, ...criterion }) => criterion),
      context: body.context,
    },
    diagnostics: sorted,
  };
}
