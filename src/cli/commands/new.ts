import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_LIMITS, DEFAULT_VERIFY, renderSpec, type SpecDraft } from "../../spec/template.js";
import { LIMIT_BOUNDS, type Limits, VERIFY_STEPS, type VerifyStep } from "../../spec/types.js";
import { type CliIo, ExitCode } from "../io.js";

export const NEW_HELP = `Usage: themis new [spec] [--yes] [--force]

Writes a spec skeleton to fill in (default: spec.md). In a terminal, a short wizard asks for
the title, the verification steps, the limits and the acceptance criteria; without one, or
with --yes, the skeleton uses the defaults. Every <...> placeholder is left for you to write.

Options:
  -y, --yes   Skip the wizard and use the defaults
  --force     Overwrite an existing file
  -h, --help
`;

/** `themis new`: scaffold a spec, interactively when a terminal is attached. */
export async function newCommand(args: string[], io: CliIo): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    io.stdout(NEW_HELP);
    return ExitCode.Ok;
  }
  if (positionals.length > 1) {
    io.stderr(`themis new: expected at most one spec path\n\n${NEW_HELP}`);
    return ExitCode.Usage;
  }

  const path = resolve(io.cwd, positionals[0] ?? "spec.md");
  const rel = relative(io.cwd, path);
  const display = rel === "" || rel.startsWith("..") ? path : rel;
  // Checked before the wizard, so nobody answers every question only to be refused at the end.
  if (!values.force && existsSync(path)) {
    io.stderr(`themis new: ${display} already exists (use --force to overwrite)\n`);
    return ExitCode.Usage;
  }

  const defaults: SpecDraft = {
    title: basename(dirname(path)),
    summary: "",
    verify: DEFAULT_VERIFY,
    limits: DEFAULT_LIMITS,
    criteria: [],
  };
  let draft = defaults;
  if (!values.yes && io.prompt !== undefined) {
    const answered = await wizard(io.prompt, io, defaults);
    if (answered === undefined) {
      io.stderr("themis new: aborted, nothing written\n");
      return ExitCode.Usage;
    }
    draft = answered;
  } else if (!values.yes) {
    io.stdout("no interactive terminal: writing the skeleton with the defaults\n");
  }

  try {
    await mkdir(dirname(path), { recursive: true });
    // `wx` closes the gap between the existence check above and the write.
    await writeFile(path, renderSpec(draft), { flag: values.force ? "w" : "wx" });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    io.stderr(`themis new: cannot write ${display}: ${reason}\n`);
    return ExitCode.Usage;
  }

  const count = Math.max(draft.criteria.length, 1);
  const custom = positionals[0] !== undefined && display !== "spec.md";
  io.stdout(
    `wrote ${display} (${count} acceptance ${count === 1 ? "criterion" : "criteria"})\n` +
      "next: replace every <...> placeholder, then run\n" +
      `  themis check${custom ? ` ${display}` : ""}\n` +
      `  themis init${custom ? ` --spec ${display}` : ""}\n`,
  );
  return ExitCode.Ok;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Raised when input ends mid-wizard; caught once, so the questions read as straight-line code. */
class Aborted extends Error {}

async function wizard(
  prompt: NonNullable<CliIo["prompt"]>,
  io: CliIo,
  defaults: SpecDraft,
): Promise<SpecDraft | undefined> {
  /** Asks until the answer parses; an empty answer takes the default when there is one. */
  const ask = async <T>(question: string, parse: (answer: string) => Parsed<T>): Promise<T> => {
    for (;;) {
      const answer = await prompt(question);
      if (answer === undefined) throw new Aborted();
      const parsed = parse(answer.trim());
      if (parsed.ok) return parsed.value;
      io.stderr(`  ${parsed.error}\n`);
    }
  };

  try {
    const title = await ask(`Title [${defaults.title}]: `, (a) => ok(a || defaults.title));
    const summary = await ask("One-line summary (optional): ", (a) => ok(a));
    const verify = await ask(`Verify steps [${defaults.verify.join(", ")}]: `, (a) =>
      a === "" ? ok(defaults.verify) : parseSteps(a),
    );
    const limits: Limits = {
      max_iterations: await ask(
        `Max iterations per criterion [${defaults.limits.max_iterations}]: `,
        (a) => parseLimit(a, "max_iterations", defaults.limits.max_iterations),
      ),
      parallel: await ask(`Criteria run in parallel [${defaults.limits.parallel}]: `, (a) =>
        parseLimit(a, "parallel", defaults.limits.parallel),
      ),
    };

    io.stdout("Acceptance criteria, one per line; an empty title ends the list.\n");
    const criteria: SpecDraft["criteria"] = [];
    for (;;) {
      const n = criteria.length + 1;
      const criterionTitle = await ask(`AC-${n} title: `, (a) => ok(a));
      if (criterionTitle === "") break;
      // Only earlier criteria can be named, which keeps the graph acyclic by construction.
      const dependsOn =
        n === 1
          ? []
          : await ask(`AC-${n} depends on (e.g. AC-1, AC-2; empty for none): `, (a) =>
              parseDependencies(a, n),
            );
      criteria.push({ title: criterionTitle, dependsOn });
    }
    return { title, summary, verify, limits, criteria };
  } catch (err) {
    if (err instanceof Aborted) return undefined;
    throw err;
  }
}

function ok<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

function parseSteps(answer: string): Parsed<VerifyStep[]> {
  const steps = answer.split(/[\s,]+/).filter((s) => s !== "");
  const unknown = steps.find((s) => !(VERIFY_STEPS as readonly string[]).includes(s));
  if (unknown !== undefined)
    return { ok: false, error: `unknown step "${unknown}" (known: ${VERIFY_STEPS.join(", ")})` };
  const duplicate = steps.find((s, i) => steps.indexOf(s) !== i);
  if (duplicate !== undefined) return { ok: false, error: `duplicate step "${duplicate}"` };
  if (!steps.includes("acceptance")) return { ok: false, error: `must include "acceptance"` };
  return ok(steps as VerifyStep[]);
}

function parseLimit(answer: string, key: keyof Limits, fallback: number): Parsed<number> {
  if (answer === "") return ok(fallback);
  const { min, max } = LIMIT_BOUNDS[key];
  const value = Number(answer);
  if (!Number.isInteger(value) || value < min || value > max)
    return { ok: false, error: `expected a whole number from ${min} to ${max}` };
  return ok(value);
}

function parseDependencies(answer: string, n: number): Parsed<string[]> {
  const ids = answer
    .split(/[\s,]+/)
    .filter((s) => s !== "")
    .map((s) => s.toUpperCase());
  for (const id of ids) {
    const k = /^AC-([1-9]\d*)$/.exec(id)?.[1];
    if (k === undefined || Number(k) >= n)
      return {
        ok: false,
        error: `"${id}" is not an earlier criterion (choose from AC-1 to AC-${n - 1})`,
      };
  }
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate !== undefined) return { ok: false, error: `duplicate dependency "${duplicate}"` };
  return ok(ids);
}
