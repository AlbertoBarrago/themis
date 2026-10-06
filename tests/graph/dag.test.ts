import { describe, expect, it } from "vitest";
import { findCycles, topologicalOrder } from "../../src/graph/dag.js";

const graph = (entries: Record<string, string[]>) => new Map(Object.entries(entries));

describe("findCycles", () => {
  it("returns nothing for a DAG", () => {
    expect(findCycles(graph({ a: [], b: ["a"], c: ["a", "b"] }))).toEqual([]);
  });

  it("finds disjoint cycles in insertion order and ignores self-loops", () => {
    expect(
      findCycles(graph({ x: ["x"], a: ["c"], b: ["a"], c: ["b"], d: ["e"], e: ["d"] })),
    ).toEqual([
      ["a", "b", "c"],
      ["d", "e"],
    ]);
  });

  it("ignores edges to unknown nodes", () => {
    expect(findCycles(graph({ a: ["zz"] }))).toEqual([]);
  });
});

describe("topologicalOrder", () => {
  it("puts dependencies first, preferring insertion order among ready nodes", () => {
    expect(topologicalOrder(graph({ c: ["a"], a: [], b: [], d: ["c", "b"] }))).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  it("throws on cycles", () => {
    expect(() => topologicalOrder(graph({ a: ["b"], b: ["a"] }))).toThrow(/cycle/);
  });
});
