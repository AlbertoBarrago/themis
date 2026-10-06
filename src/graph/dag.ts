/** Adjacency list: node id to the ids it depends on. */
export type Graph = ReadonlyMap<string, readonly string[]>;

/**
 * Strongly connected components with more than one node, i.e. dependency cycles.
 * Self-loops are not reported here: callers detect them directly with a clearer message.
 * Uses Tarjan's algorithm; edges to unknown nodes are ignored.
 */
export function findCycles(graph: Graph): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);

    for (const next of graph.get(node) ?? []) {
      if (!graph.has(next)) continue;
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(next) ?? 0));
      }
    }

    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) cycles.push(component);
    }
  };

  for (const node of graph.keys()) {
    if (!index.has(node)) visit(node);
  }

  // Report members in graph insertion order so messages are deterministic and readable.
  const order = [...graph.keys()];
  return cycles
    .map((c) => c.sort((a, b) => order.indexOf(a) - order.indexOf(b)))
    .sort((a, b) => order.indexOf(a[0] ?? "") - order.indexOf(b[0] ?? ""));
}

/**
 * Topological order (dependencies first), stable with respect to insertion order.
 * Throws if the graph has a cycle: callers are expected to have validated it.
 */
export function topologicalOrder(graph: Graph): string[] {
  const remaining = new Map<string, number>();
  for (const [node, deps] of graph) {
    remaining.set(node, deps.filter((d) => graph.has(d) && d !== node).length);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < graph.size) {
    const ready = [...graph.keys()].find((n) => !done.has(n) && remaining.get(n) === 0);
    if (ready === undefined) throw new Error("graph has a cycle");
    order.push(ready);
    done.add(ready);
    for (const [node, deps] of graph) {
      if (!done.has(node) && deps.includes(ready)) {
        remaining.set(node, (remaining.get(node) ?? 0) - 1);
      }
    }
  }
  return order;
}
