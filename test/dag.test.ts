import { describe, it, expect } from "vitest";
import { buildLevels, topoOrder, type DagNode } from "../src/dag";

const nodes: DagNode[] = [
  { id: "a", question: "qa", dependsOn: [] },
  { id: "b", question: "qb", dependsOn: ["a"] },
  { id: "c", question: "qc", dependsOn: ["a"] },
  { id: "d", question: "qd", dependsOn: ["b", "c"] },
];

describe("dag", () => {
  it("groups into dependency levels", () => {
    expect(buildLevels(nodes)).toEqual([["a"], ["b", "c"], ["d"]]);
  });
  it("topo order respects dependencies", () => {
    const order = topoOrder(nodes).map((n) => n.id);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });
  it("detects cycles", () => {
    const cyclic: DagNode[] = [
      { id: "x", question: "q", dependsOn: ["y"] },
      { id: "y", question: "q", dependsOn: ["x"] },
    ];
    expect(() => buildLevels(cyclic)).toThrow(/cycle/);
  });
});
