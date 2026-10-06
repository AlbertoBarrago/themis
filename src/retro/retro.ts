import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentRunner } from "../adapters/agent-runner.js";
import { callStructured, type Totals } from "../agents/structured.js";
import { sha256 } from "../fs/digest.js";
import { readIfExists } from "../fs/generated.js";
import { loadSpec, readTasks, zodErrors } from "../plan/plan.js";
import { readState } from "../run/state.js";
import type { Diagnostic } from "../spec/diagnostics.js";
import { protectedPaths } from "../stack/node-ts/contract.js";
import { collectEvidence, type Evidence } from "./evidence.js";
import { retroPrompt } from "./prompt.js";
import {
  instructionsPath,
  type Proposal,
  RETRO_PATH,
  RETRO_TARGETS,
  type RetroFile,
  retroFile,
  retroOutput,
  retroOutputJsonSchema,
} from "./schema.js";
import { applyProposals } from "./validate.js";

const TERMINAL = ["done", "failed", "blocked"];

/** A change proposed to one instruction file, with its content before and after. */
export interface FileChange {
  path: string;
  before: string;
  after: string;
}

export type RetroOutcome =
  | { kind: "not-initialized"; message: string }
  | { kind: "spec-unreadable"; message: string }
  | { kind: "invalid-spec"; diagnostics: Diagnostic[] }
  | { kind: "nothing-to-analyse" }
  | { kind: "no-evidence"; warnings: string[] }
  | { kind: "agent-unavailable" | "agent-failed"; message: string; totals: Totals }
  | { kind: "invalid-proposal"; errors: string[]; totals: Totals }
  | {
      kind: "done";
      proposals: Proposal[];
      evidence: Evidence[];
      changes: FileChange[];
      warnings: string[];
      totals: Totals;
    };

export interface RetroOptions {
  root: string;
  specPath: string;
  runner: AgentRunner;
  now?: () => Date;
}

/**
 * `themis retro` (ADR 0015): extracts the evidence of the run, asks the retro agent for
 * changes to the other agents' instructions, validates them and writes the proposal for the
 * third human gate. Instruction files are not touched here.
 */
export async function retro(options: RetroOptions): Promise<RetroOutcome> {
  const { root, specPath, runner } = options;
  const now = options.now ?? (() => new Date());

  const instructions = await readIfExists(join(root, instructionsPath("retro")));
  if (instructions === undefined) {
    return {
      kind: "not-initialized",
      message: `${instructionsPath("retro")} not found; run themis init first`,
    };
  }
  const loaded = await loadSpec(root, specPath);
  if (!loaded.ok) return loaded.outcome;
  const tasks = await readTasks(root);
  const state = await readState(root);
  if (
    tasks === undefined ||
    !tasks.tasks.some((t) => TERMINAL.includes(state.tasks[t.id]?.status ?? "pending"))
  ) {
    return { kind: "nothing-to-analyse" };
  }

  const { items: evidence, warnings } = await collectEvidence(root, tasks.tasks, state);
  if (evidence.length === 0) return { kind: "no-evidence", warnings };

  const current = await readTargets(root);
  const evidenceIds = new Set(evidence.map((e) => e.id));
  const outcome = await callStructured({
    runner,
    root,
    logDir: "retro",
    now,
    invocation: (rejected) => ({
      role: "retro",
      tier: loaded.spec.frontmatter.models.retro,
      cwd: root,
      instructions,
      prompt: retroPrompt(evidence, current, rejected),
      tools: "read-only",
      protectedPaths: protectedPaths(specPath),
      outputSchema: retroOutputJsonSchema,
    }),
    validate: (structured) => {
      const parsed = retroOutput.safeParse(structured);
      if (!parsed.success) return { ok: false, errors: zodErrors(parsed.error) };
      const applied = applyProposals(parsed.data.proposals, current, evidenceIds);
      return applied.ok
        ? { ok: true, value: { proposals: parsed.data.proposals, files: applied.files } }
        : applied;
    },
  });

  switch (outcome.kind) {
    case "unavailable":
      return { kind: "agent-unavailable", message: outcome.message, totals: outcome.totals };
    case "failed":
      return { kind: "agent-failed", message: outcome.message, totals: outcome.totals };
    case "invalid":
      return { kind: "invalid-proposal", errors: outcome.errors, totals: outcome.totals };
    case "ok":
      break;
  }

  const { proposals, files } = outcome.value;
  const draft: RetroFile = {
    themis: "0.1",
    createdAt: now().toISOString(),
    files: Object.fromEntries([...files.keys()].map((p) => [p, sha256(current.get(p) ?? "")])),
    proposals,
  };
  await mkdir(dirname(join(root, RETRO_PATH)), { recursive: true });
  await writeFile(join(root, RETRO_PATH), `${JSON.stringify(draft, null, 2)}\n`);
  return {
    kind: "done",
    proposals,
    evidence,
    changes: changesOf(files, current),
    warnings,
    totals: outcome.totals,
  };
}

export type ApproveRetroOutcome =
  | { kind: "no-proposal" }
  | { kind: "changed"; files: string[] }
  | { kind: "invalid-proposal"; errors: string[] }
  | { kind: "approved"; changes: FileChange[] };

/**
 * `themis approve retro`: the third gate. Applies every proposal to the instruction files,
 * provided none of them changed since the proposal was made, then removes the proposal.
 */
export async function approveRetro(root: string): Promise<ApproveRetroOutcome> {
  const draft = await readRetro(root);
  if (draft === undefined) return { kind: "no-proposal" };

  const current = await readTargets(root);
  const changed = Object.entries(draft.files)
    .filter(([path, digest]) => {
      const content = current.get(path);
      return content === undefined || sha256(content) !== digest;
    })
    .map(([path]) => path);
  if (changed.length > 0) return { kind: "changed", files: changed };

  // Evidence ids were checked when the proposal was made; the file may have been edited since.
  const ids = new Set(draft.proposals.flatMap((p) => p.evidence));
  const applied = applyProposals(draft.proposals, current, ids);
  if (!applied.ok) return { kind: "invalid-proposal", errors: applied.errors };
  const untracked = [...applied.files.keys()].filter((p) => !(p in draft.files));
  if (untracked.length > 0) {
    return {
      kind: "invalid-proposal",
      errors: untracked.map((p) => `${p} has no recorded digest in ${RETRO_PATH}`),
    };
  }

  for (const [path, content] of applied.files) await writeFile(join(root, path), content);
  await rm(join(root, RETRO_PATH));
  return { kind: "approved", changes: changesOf(applied.files, current) };
}

/** A `.themis/runs/retro.json` that exists but cannot be used. */
export class RetroFileError extends Error {
  override readonly name = "RetroFileError";
}

export async function readRetro(root: string): Promise<RetroFile | undefined> {
  const source = await readIfExists(join(root, RETRO_PATH));
  if (source === undefined) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(source);
  } catch (err) {
    throw new RetroFileError(
      `${RETRO_PATH} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const parsed = retroFile.safeParse(data);
  if (!parsed.success)
    throw new RetroFileError(
      `${RETRO_PATH} is invalid: ${zodErrors(parsed.error)[0] ?? "unknown"}`,
    );
  return parsed.data;
}

/** The instruction files a retrospective may change that exist, by path. */
async function readTargets(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const role of RETRO_TARGETS) {
    const path = instructionsPath(role);
    const content = await readIfExists(join(root, path));
    if (content !== undefined) files.set(path, content);
  }
  return files;
}

function changesOf(
  files: ReadonlyMap<string, string>,
  current: ReadonlyMap<string, string>,
): FileChange[] {
  return [...files].map(([path, after]) => ({ path, before: current.get(path) ?? "", after }));
}
