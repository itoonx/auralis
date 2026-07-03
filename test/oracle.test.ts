// Live integration: read-after-write against a real Oracle sidecar. Skips cleanly if it is offline,
// so the suite is green without the sidecar; run the sidecar (see README) to actually exercise it.
import { describe, it, expect } from "vitest";
import { OracleAdapter, oracleReachable } from "../src/memory";

describe("Oracle read-after-write (needs sidecar at :47778)", () => {
  it("a just-learned pattern is immediately searchable (synchronous FTS)", async () => {
    if (!(await oracleReachable())) {
      console.warn("Oracle not reachable at :47778 — skipping live read-after-write test.");
      return;
    }
    const oracle = new OracleAdapter();
    const marker = "auralisRAW" + Math.random().toString(36).slice(2, 10);
    await oracle.learn(`Read-after-write probe ${marker}: the shared brain stores and recalls this note.`, {
      concepts: ["auralis-test"],
    });
    const hits = await oracle.search(marker, { limit: 10 });
    expect(hits.some((h) => h.content.includes(marker))).toBe(true);
  }, 60_000);
});
