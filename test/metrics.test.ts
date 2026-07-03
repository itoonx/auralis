import { describe, it, expect } from "vitest";
import { redundantCount, reductionPct } from "../src/metrics";

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
});
