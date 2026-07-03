import { describe, it, expect } from "vitest";
import { parsePlan } from "../src/planner";

describe("planner parse", () => {
  it("parses a bare JSON array", () => {
    const nodes = parsePlan('[{"id":"arch","question":"architecture?","dependsOn":[]},{"id":"flow","question":"flow?","dependsOn":["arch"]}]');
    expect(nodes.map((n) => n.id)).toEqual(["arch", "flow"]);
    expect(nodes[1].dependsOn).toEqual(["arch"]);
  });
  it("parses a fenced ```json block with surrounding prose", () => {
    const nodes = parsePlan('Here is the plan:\n```json\n[{"question":"a?"},{"question":"b?"}]\n```\nDone.');
    expect(nodes).toHaveLength(2);
    expect(nodes[0].id).toBe("task-1");
  });
  it("degrades to a single whole-goal node on garbage", () => {
    const nodes = parsePlan("sorry, I could not produce JSON");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("whole");
  });
});
