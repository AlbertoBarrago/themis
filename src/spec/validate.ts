import { findCycles } from "../graph/dag.js";
import type { ParsedCriterion } from "./body.js";
import { type Diagnostic, error, warning } from "./diagnostics.js";
import type { Item } from "./types.js";

/** Cross-section rules that need the whole body: identifiers, dependencies, decisions. */
export function validateBody(input: {
  titleLine: number;
  decisionsLine: number | undefined;
  decisions: Item[];
  criteria: ParsedCriterion[];
}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { criteria } = input;

  if (input.decisionsLine === undefined) {
    diagnostics.push(
      warning(
        "decisions-missing",
        "spec has no `## Decisions` section; agents will have to guess design choices",
        input.titleLine,
        1,
      ),
    );
  } else if (input.decisions.length === 0) {
    diagnostics.push(
      warning("decisions-missing", "`## Decisions` has no list items", input.decisionsLine, 1),
    );
  }

  if (criteria.length === 0) {
    diagnostics.push(
      error(
        "no-acceptance-criteria",
        "spec defines no acceptance criteria; add at least one `## AC-<n> <title>` section",
        input.titleLine,
        1,
      ),
    );
    return diagnostics;
  }

  // First declaration wins; later duplicates are reported and left out of the graph.
  const byId = new Map<string, ParsedCriterion>();
  for (const criterion of criteria) {
    const first = byId.get(criterion.id);
    if (first !== undefined) {
      diagnostics.push(
        error(
          "ac-duplicate",
          `${criterion.id} is already defined on line ${first.line}`,
          criterion.line,
          4,
        ),
      );
      continue;
    }
    byId.set(criterion.id, criterion);
  }

  const graph = new Map<string, string[]>();
  for (const criterion of byId.values()) {
    const edges: string[] = [];
    for (const ref of criterion.dependsRefs) {
      if (ref.id === criterion.id) {
        diagnostics.push(
          error("depends-self", `${criterion.id} depends on itself`, ref.line, ref.column),
        );
      } else if (!byId.has(ref.id)) {
        diagnostics.push(
          error(
            "depends-unknown",
            `${criterion.id} depends on ${ref.id}, which is not defined`,
            ref.line,
            ref.column,
          ),
        );
      } else {
        edges.push(ref.id);
      }
    }
    graph.set(criterion.id, edges);
  }

  for (const cycle of findCycles(graph)) {
    const head = byId.get(cycle[0] ?? "");
    diagnostics.push(
      error(
        "depends-cycle",
        `dependency cycle between ${cycle.join(", ")}`,
        head?.line ?? input.titleLine,
        4,
      ),
    );
  }

  return diagnostics;
}
