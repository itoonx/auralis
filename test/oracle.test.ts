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

  it("explain=1: every hit justifies why it was retrieved (principle 4)", async () => {
    if (!(await oracleReachable())) {
      console.warn("Oracle not reachable — skipping explain test.");
      return;
    }
    const oracle = new OracleAdapter();
    const project = "ex-" + Math.random().toString(36).slice(2, 8);
    await oracle.learn("The `TokenBucket` limiter in net/bucket.ts refills 10 tokens per second.", { project });
    const hits = await oracle.search("TokenBucket limiter refill rate", { project, limit: 1, explain: true });
    expect(hits.length).toBe(1);
    const why = hits[0].why!;
    expect(why.ftsRank).toBe(1); // it topped the keyword list…
    expect(why.rrf).toBeGreaterThan(0); // …with an RRF base…
    expect(why.multiplier).toBeGreaterThan(1); // …and boosts that nudged, never gated
    expect(why.outdated).toBe(false);
    // and without explain, the payload stays lean:
    const lean = await oracle.search("TokenBucket limiter refill rate", { project, limit: 1 });
    expect(lean[0].why).toBeUndefined();
  }, 60_000);

  it("temporal retrieval (U6): invalidated facts sink NOW but as_of returns the truth-at-T", async () => {
    if (!(await oracleReachable())) {
      console.warn("Oracle not reachable — skipping temporal test.");
      return;
    }
    const oracle = new OracleAdapter();
    const project = "tt-" + Math.random().toString(36).slice(2, 8);
    // The world: gateway timeout was 30s from Jan, changed to 60s on Jun 1st.
    const T_OLD = "2026-01-01T00:00:00Z", T_CHANGE = "2026-06-01T00:00:00Z";
    const a = await oracle.learn("The gateway request timeout is 30 seconds.", { project, validAt: T_OLD });
    const b = await oracle.learn("The gateway request timeout is 60 seconds.", { project, validAt: T_CHANGE });
    await oracle.invalidate!(a.id, { newId: b.id, reason: "config changed June 1st", invalidAt: T_CHANGE });

    // NOW: the current fact must outrank the expired one (semantic similarity is identical — time decides).
    const nowHits = await oracle.search("gateway request timeout", { project, limit: 2 });
    expect(nowHits[0].id).toBe(b.id);

    // Truth at a date BEFORE the change: only the old fact was true (validity of b starts at its creation,
    // which is after T; a's interval covers it).
    const before = await oracle.search("gateway request timeout", { project, limit: 5, asOf: "2026-03-01T00:00:00Z" });
    expect(before.map((h) => h.id)).toContain(a.id);
    expect(before.map((h) => h.id)).not.toContain(b.id);

    // Truth AFTER the change: the old fact's interval has ended.
    const after = await oracle.search("gateway request timeout", { project, limit: 5, asOf: "2026-07-01T00:00:00Z" });
    expect(after.map((h) => h.id)).toContain(b.id);
    expect(after.map((h) => h.id)).not.toContain(a.id);
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

  it("timeline all=1 is one continuous feed across runs — a new session appends, never resets", async () => {
    if (!(await oracleReachable())) {
      console.warn("Oracle not reachable at :47778 — skipping live timeline test.");
      return;
    }
    const oracle = new OracleAdapter();
    const project = "tl-" + Math.random().toString(36).slice(2, 8);
    await oracle.recordEvent!({ runId: "session:one", project, kind: "prompt", actor: "human", human: "🗣 first session" });
    await oracle.recordEvent!({ runId: "session:two", project, kind: "prompt", actor: "human", human: "🗣 second session" });
    // Both sessions in ONE stream, oldest→newest — the run-scoped default would show only session:two.
    const events = await oracle.timeline!({ project, all: true });
    expect(events.map((e) => e.runId)).toEqual(["session:one", "session:two"]);
  }, 60_000);
});
