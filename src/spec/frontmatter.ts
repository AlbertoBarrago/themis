import { isMap, isNode, isScalar, LineCounter, type Node, parseDocument, type YAMLMap } from "yaml";
import { z } from "zod";
import { type Diagnostic, error } from "./diagnostics.js";
import { FORMAT_VERSION, type Frontmatter, MODEL_TIERS, STACKS, VERIFY_STEPS } from "./types.js";

const KNOWN_KEYS = new Set(["themis", "stack", "verify", "limits", "models"]);
const EXTENSION_PREFIX = "x-";

const DEFAULT_LIMITS = { max_iterations: 5, parallel: 3 };
const DEFAULT_MODELS = {
  planner: "strong",
  worker: "fast",
  reviewer: "strong",
  retro: "strong",
} as const;

const tier = z.enum(MODEL_TIERS);

/**
 * Schema for every known key except `themis`, which is checked against its raw source text
 * (see {@link checkVersion}) because YAML would read `0.10` and `0.1` as the same number.
 */
const schema = z.object({
  stack: z.enum(STACKS),
  verify: z
    .array(z.enum(VERIFY_STEPS))
    .min(1)
    .superRefine((steps, ctx) => {
      steps.forEach((step, index) => {
        if (steps.indexOf(step) !== index) {
          ctx.addIssue({ code: "custom", path: [index], message: `duplicate step "${step}"` });
        }
      });
      if (!steps.includes("acceptance")) {
        ctx.addIssue({ code: "custom", message: `must include "acceptance"` });
      }
    }),
  limits: z
    .strictObject({
      max_iterations: z.int().min(1).max(50).default(DEFAULT_LIMITS.max_iterations),
      parallel: z.int().min(1).max(16).default(DEFAULT_LIMITS.parallel),
    })
    .default(DEFAULT_LIMITS),
  models: z
    .strictObject({
      planner: tier.default(DEFAULT_MODELS.planner),
      worker: tier.default(DEFAULT_MODELS.worker),
      reviewer: tier.default(DEFAULT_MODELS.reviewer),
      retro: tier.default(DEFAULT_MODELS.retro),
    })
    .default(DEFAULT_MODELS),
});

export interface FrontmatterResult {
  /** Present only when the frontmatter produced no errors. */
  frontmatter?: Frontmatter;
  /** 0-based index of the first body line in the file's line array. */
  bodyStart: number;
  diagnostics: Diagnostic[];
}

type Path = readonly PropertyKey[];

/**
 * Parses and validates the frontmatter of a spec.
 *
 * @param lines The whole file split into lines (already normalised to LF, BOM stripped).
 */
export function parseFrontmatter(lines: readonly string[]): FrontmatterResult {
  if (lines[0] !== "---") {
    return {
      bodyStart: 0,
      diagnostics: [
        error("frontmatter-missing", "spec must start with a `---` frontmatter block", 1, 1),
      ],
    };
  }
  const close = lines.indexOf("---", 1);
  if (close === -1) {
    return {
      bodyStart: lines.length,
      diagnostics: [error("frontmatter-unclosed", "frontmatter has no closing `---`", 1, 1)],
    };
  }

  const ctx = new FrontmatterContext(lines.slice(1, close).join("\n"));
  const diagnostics = ctx.validate();
  const result: FrontmatterResult = { bodyStart: close + 1, diagnostics };
  if (ctx.frontmatter !== undefined && !diagnostics.some((d) => d.severity === "error")) {
    result.frontmatter = ctx.frontmatter;
  }
  return result;
}

class FrontmatterContext {
  readonly #source: string;
  readonly #lineCounter = new LineCounter();
  readonly #doc;
  readonly #diagnostics: Diagnostic[] = [];
  frontmatter: Frontmatter | undefined;

  constructor(source: string) {
    this.#source = source;
    this.#doc = parseDocument(source, { lineCounter: this.#lineCounter });
  }

  validate(): Diagnostic[] {
    if (this.#doc.errors.length > 0) {
      for (const err of this.#doc.errors) {
        const pos = err.linePos?.[0];
        const message = err.message.split("\n")[0] ?? err.message;
        this.#diagnostics.push(
          // YAML line 1 is file line 2, right after the opening `---`.
          error("yaml-syntax", message, (pos?.line ?? 1) + 1, pos?.col ?? 1),
        );
      }
      return this.#diagnostics;
    }

    const contents = this.#doc.contents;
    if (contents !== null && !isMap(contents)) {
      const { line, column } = this.#position(contents.range?.[0] ?? 0);
      this.#diagnostics.push(
        error("frontmatter-not-mapping", "frontmatter must be a YAML mapping", line, column),
      );
      return this.#diagnostics;
    }

    this.#checkVersion();
    const known = this.#checkKeys(contents);
    this.#checkSchema(known);
    return this.#diagnostics;
  }

  #checkVersion(): void {
    const node = this.#doc.get("themis", true);
    if (node === undefined) {
      this.#diagnostics.push(error("invalid-field", "is required", 1, 1, "themis"));
      return;
    }
    const raw = isScalar(node) && node.range ? this.#raw(node) : undefined;
    if (raw !== FORMAT_VERSION) {
      const { line, column } = this.#nodePosition(isNode(node) ? node : null);
      this.#diagnostics.push(
        error(
          "unsupported-version",
          `unsupported format version ${raw === undefined ? "(not a scalar)" : `"${raw}"`}, expected "${FORMAT_VERSION}"`,
          line,
          column,
          "themis",
        ),
      );
    }
  }

  /** Reports unknown top-level keys and returns the JS value of the known ones. */
  #checkKeys(map: YAMLMap | null): {
    known: Record<string, unknown>;
    extensions: Record<string, unknown>;
  } {
    const known: Record<string, unknown> = {};
    const extensions: Record<string, unknown> = {};
    const js: unknown = this.#doc.toJS();
    const values = (js ?? {}) as Record<string, unknown>;
    for (const pair of map?.items ?? []) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (key === undefined) {
        const { line, column } = this.#nodePosition(pair.key as Node | null);
        this.#diagnostics.push(error("unknown-field", "keys must be scalars", line, column));
        continue;
      }
      if (key === "themis") continue;
      if (key.startsWith(EXTENSION_PREFIX)) {
        extensions[key] = values[key];
      } else if (KNOWN_KEYS.has(key)) {
        known[key] = values[key];
      } else {
        const { line, column } = this.#nodePosition(pair.key as Node);
        this.#diagnostics.push(error("unknown-field", `unknown field "${key}"`, line, column, key));
      }
    }
    return { known, extensions };
  }

  #checkSchema({
    known,
    extensions,
  }: {
    known: Record<string, unknown>;
    extensions: Record<string, unknown>;
  }): void {
    const parsed = schema.safeParse(known, { reportInput: true });
    if (parsed.success) {
      this.frontmatter = { themis: FORMAT_VERSION, ...parsed.data, extensions };
      return;
    }
    for (const issue of parsed.error.issues) {
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          const path = [...issue.path, key];
          const { line, column } = this.#keyPosition(path);
          this.#diagnostics.push(
            error("unknown-field", `unknown field "${key}"`, line, column, formatPath(path)),
          );
        }
        continue;
      }
      const { line, column } = this.#pathPosition(issue.path);
      this.#diagnostics.push(
        error("invalid-field", describeIssue(issue), line, column, formatPath(issue.path)),
      );
    }
  }

  /** Position of the value at `path`, falling back to the closest existing ancestor. */
  #pathPosition(path: Path): { line: number; column: number } {
    for (let depth = path.length; depth > 0; depth--) {
      const node = this.#doc.getIn(path.slice(0, depth), true);
      if (node !== undefined && node !== null) return this.#nodePosition(node as Node);
    }
    return { line: 1, column: 1 };
  }

  /** Position of the key (not the value) at `path`, used for unknown nested keys. */
  #keyPosition(path: Path): { line: number; column: number } {
    const parent = this.#doc.getIn(path.slice(0, -1), true);
    const key = path.at(-1);
    if (isMap(parent)) {
      const pair = parent.items.find((p) => isScalar(p.key) && p.key.value === key);
      if (pair) return this.#nodePosition(pair.key as Node);
    }
    return this.#pathPosition(path);
  }

  #nodePosition(node: Node | null | undefined): { line: number; column: number } {
    return this.#position(node?.range?.[0] ?? 0);
  }

  #position(offset: number): { line: number; column: number } {
    const pos = this.#lineCounter.linePos(offset);
    return { line: pos.line + 1, column: pos.col };
  }

  #raw(node: Node): string {
    const [start, end] = node.range ?? [0, 0];
    return this.#source
      .slice(start, end)
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2");
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined
        ? "is required"
        : `expected ${issue.expected}, got ${describeValue(issue.input)}`;
    case "invalid_value":
      return `must be one of: ${issue.values.map((v) => String(v)).join(", ")}`;
    case "too_small":
      return issue.origin === "array" ? "must not be empty" : `must be >= ${issue.minimum}`;
    case "too_big":
      return `must be <= ${issue.maximum}`;
    default:
      return issue.message;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "mapping";
  if (typeof value === "number" && !Number.isInteger(value)) return `number ${value}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

function formatPath(path: Path): string {
  return path
    .map((segment, i) =>
      typeof segment === "number" ? `[${segment}]` : `${i === 0 ? "" : "."}${String(segment)}`,
    )
    .join("");
}
