import { findCycles, topologicalOrder } from "../graph/dag.js";
import type { Spec } from "../spec/types.js";
import { type PlannedTask, type PlannerOutput, SETUP_TASK } from "./schema.js";

export type PlanValidation = { ok: true; tasks: PlannedTask[] } | { ok: false; errors: string[] };

/**
 * Checks a planner answer against the spec (rules in ADR 0010). The planner is an agent, so
 * nothing it returns is trusted: this is what makes the plan safe to show at the human gate.
 * On success, tasks are returned in topological order with normalised dependency lists.
 */
export function validatePlan(spec: Spec, output: PlannerOutput): PlanValidation {
  const errors: string[] = [];
  const criteria = new Map(spec.criteria.map((c) => [c.id as string, c]));
  const byId = new Map<string, PlannedTask>();

  for (const task of output.tasks) {
    if (byId.has(task.id)) {
      errors.push(`${task.id}: listed more than once`);
      continue;
    }
    if (task.id !== SETUP_TASK && !criteria.has(task.id)) {
      errors.push(`${task.id}: not a criterion of the spec`);
      continue;
    }
    byId.set(task.id, task);
  }
  for (const id of criteria.keys()) {
    if (!byId.has(id)) errors.push(`${id}: missing, every criterion needs exactly one task`);
  }

  for (const task of byId.values()) {
    const deps = new Set(task.dependsOn);
    if (deps.size !== task.dependsOn.length) errors.push(`${task.id}: repeated dependency`);
    for (const dep of deps) {
      if (dep === task.id) errors.push(`${task.id}: depends on itself`);
      else if (!byId.has(dep)) errors.push(`${task.id}: depends on unknown task ${dep}`);
    }

    if (task.id === SETUP_TASK) {
      if (deps.size > 0) errors.push(`${SETUP_TASK}: must not depend on other tasks`);
      continue;
    }

    const criterion = criteria.get(task.id);
    const declared = new Set<string>(criterion?.depends ?? []);
    for (const dep of declared) {
      if (!deps.has(dep))
        errors.push(`${task.id}: drops ${dep}, declared in the spec with Depends:`);
    }

    const justified = new Map(task.addedDependencies.map((a) => [a.id, a.reason]));
    for (const dep of deps) {
      if (declared.has(dep)) continue;
      if (dep !== SETUP_TASK && criterion?.depends !== null) {
        errors.push(
          `${task.id}: adds ${dep}, but the spec declares its dependencies with Depends:; only "${SETUP_TASK}" may be added`,
        );
      }
      if (!justified.has(dep))
        errors.push(`${task.id}: adds ${dep} without a reason in addedDependencies`);
    }
    for (const id of justified.keys()) {
      if (!deps.has(id) || declared.has(id)) {
        errors.push(`${task.id}: addedDependencies lists ${id}, which is not an added dependency`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const graph = new Map([...byId.values()].map((t) => [t.id, t.dependsOn]));
  const cycles = findCycles(graph);
  if (cycles.length > 0) {
    return { ok: false, errors: cycles.map((c) => `dependency cycle between ${c.join(", ")}`) };
  }

  // Setup first, then criteria in spec order, subject to dependencies.
  const order = topologicalOrder(
    new Map(
      [SETUP_TASK, ...criteria.keys()]
        .filter((id) => graph.has(id))
        .map((id) => [id, graph.get(id) ?? []] as const),
    ),
  );
  const rank = new Map(order.map((id, i) => [id, i]));
  const tasks = order.map((id) => {
    const task = byId.get(id) as PlannedTask;
    return {
      ...task,
      dependsOn: [...task.dependsOn].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
    };
  });
  return { ok: true, tasks };
}
