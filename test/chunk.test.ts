// chunkTurn — a memory unit is a unit of thought: long turns split at sentence
// boundaries, nothing lost, short turns untouched (LongMemEval diagnosis: the
// evidence sat past the excerpt cut in ~1,800-char assistant turns).
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs module, no types
import { chunkTurn } from "../hooks/session-capture.mjs";

describe("chunkTurn", () => {
  it("keeps short text whole", () => {
    expect(chunkTurn("short")).toEqual(["short"]);
  });

  it("splits long text at sentence boundaries without losing content", () => {
    const long = "A sentence here. ".repeat(100).trim();
    const chunks: string[] = chunkTurn(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(600);
    expect(chunks.join(" ")).toBe(long);
  });

  it("keeps an unbreakable run whole rather than dropping it", () => {
    const nostop = "x".repeat(2000);
    expect(chunkTurn(nostop).join("")).toBe(nostop);
  });
});
