import { describe, it, expect } from "vitest";
import { redundantCount, reductionPct, fleetRedundantCount } from "../src/metrics";

describe("redundancy metric", () => {
  it("counts targets both workers explored", () => {
    const a = [{ tool: "Read", target: "x.rs" }, { tool: "Read", target: "shared.rs" }];
    const b = [{ tool: "Read", target: "shared.rs" }, { tool: "Read", target: "y.rs" }];
    expect(redundantCount(a, b)).toBe(1);
  });

  it("reduction pct", () => {
    expect(reductionPct(4, 1)).toBeCloseTo(0.75);
    expect(reductionPct(2, 0)).toBe(1);
    expect(reductionPct(0, 0)).toBe(0);
  });

  it("fleetRedundantCount splits duplicate file reads from cheap glob scans", () => {
    const workers = [
      [{ tool: "Read", target: "a.ts" }, { tool: "Glob", target: "**/*.ts" }],
      [{ tool: "Read", target: "a.ts" }, { tool: "Glob", target: "**/*.ts" }],
    ];
    expect(fleetRedundantCount(workers)).toBe(2); // no filter: both a.ts and the glob count
    expect(fleetRedundantCount(workers, new Set(["Read"]))).toBe(1); // only the duplicate file read
    expect(fleetRedundantCount(workers, new Set(["Grep", "Glob"]))).toBe(1); // only the repeated scan
  });
});
