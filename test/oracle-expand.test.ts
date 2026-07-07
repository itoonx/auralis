// M2 adjacency expansion: a top hit carries its insertion-order neighbours (same project, ±1) —
// the answer to "what came after X" rarely shares X's words; it sits in the chunk NEXT to the match.
// Runs against the isolated test oracle (test/setup/oracle-global.ts) — always current server code.
import { describe, it, expect } from "vitest";
import { OracleAdapter } from "../src/memory";

describe("search expand=1 (adjacency expansion)", () => {
  it("a hit carries prev/next neighbours from its own project only", async () => {
    const oracle = new OracleAdapter();
    const project = "expand-t-" + Math.random().toString(36).slice(2, 8);
    // Interleave a foreign-project doc between ours: rowid adjacency must respect the project fence.
    await oracle.learn("user: make your move, the board position is set and waiting", { project, source: "human:prompt" });
    await oracle.learn("user: an unrelated note from another project entirely", { project: `${project}-other`, source: "human:prompt" });
    await oracle.learn("assistant: my apologies, the position is 27. Kg2 Bd5+ zugzwang", { project, source: "session:assistant" });
    await oracle.learn("assistant: 28. Kg3 would be my move.", { project, source: "session:assistant" });
    const hits = await oracle.search("zugzwang", { project, limit: 1, expand: true }); // token unique to the middle doc
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("27. Kg2");
    const texts = (hits[0].neighbors ?? []).map((n) => n.content);
    expect(texts.some((t) => t.includes("28. Kg3"))).toBe(true); // next — the actual answer chunk
    expect(texts.some((t) => t.includes("make your move"))).toBe(true); // prev
    expect(texts.some((t) => t.includes("another project"))).toBe(false); // project fence holds
  }, 30_000);

  it("without expand the response shape is unchanged", async () => {
    const oracle = new OracleAdapter();
    const hits = await oracle.search("position 27. Kg2 Bd5+ zugzwang", { limit: 3 });
    for (const h of hits) expect(h.neighbors).toBeUndefined();
  }, 30_000);
});
