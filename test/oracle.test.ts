// Live integration: read-after-write against a real Oracle sidecar. Skips cleanly if it is offline,
// so the suite is green without the sidecar; run the sidecar (see README) to actually exercise it.
import { describe, it, expect } from "vitest";
import { OracleAdapter, oracleReachable } from "../src/memory";
import { scorecard } from "../src/narrate";

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

  it("learn builds the graph at the ingress, idempotently (auto heuristic edges)", async () => {
    if (!(await oracleReachable())) {
      console.warn("Oracle not reachable — skipping ingress-graph test.");
      return;
    }
    const oracle = new OracleAdapter();
    const project = "ig-" + Math.random().toString(36).slice(2, 8);
    const text = "The `PaymentGateway` retries via gateway/retry.ts and logs to audit/log.ts on failure.";
    await oracle.learn(text, { project });
    const g1 = await oracle.graph!("PaymentGateway", project);
    expect(g1.edges.length).toBeGreaterThanOrEqual(2); // hub linked to both files — no client-side step
    // Re-relating the same triplets must not inflate the graph (unique edge index → INSERT OR IGNORE).
    const docId = g1.edges[0].docId!;
    await oracle.relate!(docId, project, g1.edges.map(({ subject, predicate, object }) => ({ subject, predicate, object })));
    const g2 = await oracle.graph!("PaymentGateway", project);
    expect(g2.edges.length).toBe(g1.edges.length);
  }, 60_000);

  it("timeline records events and replays them in seq order", async () => {
    if (!(await oracleReachable())) {
      console.warn("Oracle not reachable at :47778 — skipping live timeline test.");
      return;
    }
    const oracle = new OracleAdapter();
    const project = "tl-" + Math.random().toString(36).slice(2, 8); // namespaced so it can't collide
    const runId = `${project}:shared:probe`;
    await oracle.recordEvent!({ runId, project, kind: "intent", actor: "A", human: "▸ A starting", nodeId: "A" });
    await oracle.recordEvent!({ runId, project, kind: "dedup", actor: "B", human: "⇄ B skipped x", nodeId: "B", refs: ["x"] });
    await oracle.recordEvent!({ runId, project, kind: "finding", actor: "A", human: "✓ A done", nodeId: "A" });
    const events = await oracle.timeline!({ project, run: runId });
    expect(events.map((e) => e.kind)).toEqual(["intent", "dedup", "finding"]); // seq order, not ts
    expect(events[1].refs).toEqual(["x"]);
    expect(scorecard(events)).toMatchObject({ tasks: 2, deduped: 1 });
  }, 60_000);
});
