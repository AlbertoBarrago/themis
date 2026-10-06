import { instructionsPath, type Proposal } from "./schema.js";

export type Applied = { ok: true; files: Map<string, string> } | { ok: false; errors: string[] };

/**
 * Applies the proposals in order to the current instruction files (path to content) and
 * returns the resulting content of every changed file. Every evidence id must be known, and
 * every edit must match exactly once the file as left by the previous edits, so the result
 * never depends on where an ambiguous `old` would land.
 */
export function applyProposals(
  proposals: readonly Proposal[],
  current: ReadonlyMap<string, string>,
  evidenceIds: ReadonlySet<string>,
): Applied {
  const errors: string[] = [];
  const files = new Map<string, string>();
  for (const [p, proposal] of proposals.entries()) {
    const where = `proposals.${p}`;
    for (const id of proposal.evidence) {
      if (!evidenceIds.has(id)) errors.push(`${where}.evidence: unknown evidence id "${id}"`);
    }
    const path = instructionsPath(proposal.role);
    let content = files.get(path) ?? current.get(path);
    if (content === undefined) {
      errors.push(`${where}.role: ${path} does not exist`);
      continue;
    }
    for (const [e, edit] of proposal.edits.entries()) {
      const at = `${where}.edits.${e}`;
      if (edit.old === "") {
        errors.push(`${at}.old: must not be empty`);
        continue;
      }
      if (edit.new === edit.old) {
        errors.push(`${at}: new is identical to old`);
        continue;
      }
      const count = content.split(edit.old).length - 1;
      if (count !== 1) {
        const previous = files.has(path) || e > 0 ? " after the previous edits" : "";
        errors.push(`${at}.old: must occur exactly once in ${path}${previous}, found ${count}`);
        continue;
      }
      content = content.replace(edit.old, () => edit.new);
    }
    files.set(path, content);
  }
  return errors.length === 0 ? { ok: true, files } : { ok: false, errors };
}
