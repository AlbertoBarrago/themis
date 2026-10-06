import { type Diagnostic, error, warning } from "./diagnostics.js";
import type { AcceptanceCriterion, AcceptanceCriterionId, ContextSection, Item } from "./types.js";

/** A dependency reference with its position, kept so validation can point at it. */
export interface DependencyRef {
  id: AcceptanceCriterionId;
  line: number;
  column: number;
}

export interface ParsedCriterion extends AcceptanceCriterion {
  dependsRefs: DependencyRef[];
}

export interface BodyResult {
  title: string | undefined;
  /** Line of the `## Decisions` heading, `undefined` when the section is absent. */
  decisionsLine: number | undefined;
  decisions: Item[];
  criteria: ParsedCriterion[];
  context: ContextSection[];
  diagnostics: Diagnostic[];
}

interface Line {
  text: string;
  /** 1-based line number in the file. */
  number: number;
  /** True when the line is a fence delimiter or sits inside a fenced code block. */
  fenced: boolean;
}

type Section =
  | { kind: "preamble"; lines: Line[] }
  | { kind: "decisions"; lines: Line[] }
  | { kind: "criterion"; id: AcceptanceCriterionId; title: string; line: number; lines: Line[] }
  | { kind: "context"; heading: string; line: number; lines: Line[] }
  | { kind: "ignored"; lines: Line[] };

const HEADING = /^(#{1,2})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const CRITERION_HEADING = /^AC-([1-9]\d*)[ \t]+(\S.*)$/;
/** Headings that look like an attempt at `AC-<n>` (AC-01, AC 1, ac-2, AC-3 without title). */
const CRITERION_LIKE = /^AC(?:-|[ \t]*\d)/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BULLET = /^[-*+][ \t]+(.*)$/;
const DEPENDS = /^Depends:[ \t]*(.*)$/i;
const CRITERION_ID = /^AC-[1-9]\d*$/;
const THEN_CLAUSE = /^[*_]*then\b/i;

/**
 * Parses the Markdown body of a spec into its structural parts.
 *
 * Only ATX level-1 and level-2 headings outside fenced code blocks carry structure; this is
 * deliberately not a full CommonMark parser, since the format only needs sections and
 * top-level list items.
 *
 * @param lines The whole file split into lines.
 * @param start 0-based index of the first body line.
 */
export function parseBody(lines: readonly string[], start: number): BodyResult {
  const diagnostics: Diagnostic[] = [];
  const sections = splitSections(annotate(lines, start), diagnostics);

  const result: BodyResult = {
    title: sections.title,
    decisionsLine: undefined,
    decisions: [],
    criteria: [],
    context: [],
    diagnostics,
  };

  for (const section of sections.list) {
    switch (section.kind) {
      case "decisions": {
        result.decisionsLine = section.lines[0]?.number;
        result.decisions = parseItems(section.lines.slice(1)).items;
        break;
      }
      case "criterion":
        result.criteria.push(parseCriterion(section, diagnostics));
        break;
      case "context":
        result.context.push({
          heading: section.heading,
          line: section.line,
          body: joinText(section.lines.slice(1)),
        });
        break;
      case "preamble":
      case "ignored":
        break;
    }
  }
  return result;
}

function annotate(lines: readonly string[], start: number): Line[] {
  const out: Line[] = [];
  let fence: { char: string; length: number } | undefined;
  for (let i = start; i < lines.length; i++) {
    const text = lines[i] ?? "";
    if (fence === undefined) {
      const match = FENCE.exec(text);
      if (match?.[1] !== undefined) {
        fence = { char: match[1][0] ?? "`", length: match[1].length };
        out.push({ text, number: i + 1, fenced: true });
        continue;
      }
      out.push({ text, number: i + 1, fenced: false });
      continue;
    }
    // A closing fence repeats the opening character at least as many times, and nothing else.
    const closing = FENCE_CLOSE.exec(text);
    const closes =
      closing?.[1] !== undefined &&
      closing[1][0] === fence.char &&
      closing[1].length >= fence.length;
    out.push({ text, number: i + 1, fenced: true });
    if (closes) fence = undefined;
  }
  return out;
}

function splitSections(
  lines: Line[],
  diagnostics: Diagnostic[],
): { title: string | undefined; list: Section[] } {
  const list: Section[] = [];
  let current: Section = { kind: "preamble", lines: [] };
  let title: string | undefined;
  let titleLine: number | undefined;
  let sawDecisions = false;
  let reportedEarlySection = false;

  for (const line of lines) {
    const heading = line.fenced ? null : HEADING.exec(line.text);
    if (heading === null) {
      current.lines.push(line);
      continue;
    }
    const level = heading[1]?.length;
    const text = (heading[2] ?? "").trim();

    if (level === 1) {
      if (title !== undefined) {
        diagnostics.push(
          error(
            "title-duplicate",
            `spec already has a title on line ${titleLine}; only one level-1 heading is allowed`,
            line.number,
            1,
          ),
        );
      } else {
        title = text;
        titleLine = line.number;
      }
      current.lines.push(line);
      continue;
    }

    // Level 2: closes the current section and opens a new one.
    list.push(current);
    if (title === undefined && !reportedEarlySection) {
      reportedEarlySection = true;
      diagnostics.push(
        error(
          "content-before-title",
          "level-2 heading appears before the `# <name>` title",
          line.number,
          1,
        ),
      );
    }

    if (text === "Decisions") {
      if (sawDecisions) {
        diagnostics.push(
          error(
            "decisions-duplicate",
            "only one `## Decisions` section is allowed",
            line.number,
            1,
          ),
        );
        current = { kind: "ignored", lines: [line] };
      } else {
        sawDecisions = true;
        current = { kind: "decisions", lines: [line] };
      }
      continue;
    }

    const criterion = CRITERION_HEADING.exec(text);
    if (criterion?.[1] !== undefined && criterion[2] !== undefined) {
      current = {
        kind: "criterion",
        id: `AC-${Number(criterion[1])}`,
        title: criterion[2].trim(),
        line: line.number,
        lines: [line],
      };
      continue;
    }

    if (CRITERION_LIKE.test(text)) {
      diagnostics.push(
        error(
          "ac-heading-malformed",
          `"${text}" is not a valid criterion heading; expected "AC-<n> <title>" with n a positive integer without leading zeros`,
          line.number,
          4,
        ),
      );
      current = { kind: "ignored", lines: [line] };
      continue;
    }

    current = { kind: "context", heading: text, line: line.number, lines: [line] };
  }
  list.push(current);
  return { title, list };
}

function parseCriterion(
  section: Extract<Section, { kind: "criterion" }>,
  diagnostics: Diagnostic[],
): ParsedCriterion {
  const body = section.lines.slice(1);
  let depends: AcceptanceCriterionId[] | null = null;
  let dependsRefs: DependencyRef[] = [];
  let dependsLine: number | undefined;
  const rest: Line[] = [];
  let sawClause = false;

  for (const line of body) {
    if (!line.fenced && BULLET.test(line.text)) sawClause = true;
    const match = line.fenced ? null : DEPENDS.exec(line.text);
    if (match === null) {
      rest.push(line);
      continue;
    }
    if (dependsLine !== undefined) {
      diagnostics.push(
        error(
          "depends-duplicate",
          `${section.id} already declares dependencies on line ${dependsLine}`,
          line.number,
          1,
        ),
      );
      continue;
    }
    dependsLine = line.number;
    if (sawClause) {
      diagnostics.push(
        error(
          "depends-misplaced",
          `\`Depends:\` must come before the first clause of ${section.id}`,
          line.number,
          1,
        ),
      );
    }
    const parsed = parseDepends(line, match[1] ?? "", diagnostics);
    if (parsed !== undefined) {
      dependsRefs = parsed;
      depends = parsed.map((ref) => ref.id);
    }
  }

  const { items, other } = parseItems(rest);
  if (items.length === 0) {
    diagnostics.push(
      error(
        "ac-no-clauses",
        `${section.id} has no clauses; add at least one "- Given/When/Then ..." list item`,
        section.line,
        1,
      ),
    );
  } else if (!items.some((item) => THEN_CLAUSE.test(item.text))) {
    diagnostics.push(
      warning(
        "ac-missing-then",
        `${section.id} has no "Then" clause stating an observable outcome`,
        section.line,
        1,
      ),
    );
  }

  return {
    id: section.id,
    title: section.title,
    line: section.line,
    depends,
    dependsRefs,
    clauses: items,
    description: joinText(other),
  };
}

/** Returns `undefined` when the value is malformed (a diagnostic has been recorded). */
function parseDepends(
  line: Line,
  value: string,
  diagnostics: Diagnostic[],
): DependencyRef[] | undefined {
  const valueColumn = line.text.length - value.length + 1;
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "none") return [];

  const refs: DependencyRef[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let valid = trimmed !== "";
  for (const raw of value.split(",")) {
    const id = raw.trim();
    const column = valueColumn + offset + (raw.length - raw.trimStart().length);
    offset += raw.length + 1;
    if (!CRITERION_ID.test(id)) {
      valid = false;
      continue;
    }
    if (seen.has(id)) {
      diagnostics.push(error("depends-duplicate", `${id} is listed twice`, line.number, column));
      continue;
    }
    seen.add(id);
    refs.push({ id: id as AcceptanceCriterionId, line: line.number, column });
  }
  if (!valid) {
    diagnostics.push(
      error(
        "depends-malformed",
        `expected "none" or a comma-separated list like "AC-1, AC-2", got "${trimmed}"`,
        line.number,
        valueColumn,
      ),
    );
    return undefined;
  }
  return refs;
}

/**
 * Collects top-level list items. Indented lines continue the open item, also across blank
 * lines; any other non-blank line closes it and is returned as free text.
 */
function parseItems(lines: Line[]): { items: Item[]; other: Line[] } {
  const items: Item[] = [];
  const other: Line[] = [];
  let open: Item | undefined;

  for (const line of lines) {
    if (line.fenced) {
      open = undefined;
      other.push(line);
      continue;
    }
    const bullet = BULLET.exec(line.text);
    if (bullet !== null) {
      open = { text: (bullet[1] ?? "").trim(), line: line.number };
      items.push(open);
      continue;
    }
    if (line.text.trim() === "") {
      if (open === undefined) other.push(line);
      continue;
    }
    if (open !== undefined && /^[ \t]/.test(line.text)) {
      open.text = `${open.text} ${line.text.trim()}`.trim();
      continue;
    }
    open = undefined;
    other.push(line);
  }
  return { items, other };
}

function joinText(lines: Line[]): string {
  return lines
    .map((l) => l.text)
    .join("\n")
    .trim();
}
