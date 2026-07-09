// R2a embed-queue regression: a CONCURRENT burst of learns used to silently drop vectors — 7/800 measured
// (single-row vtable.add races), and under a slow semantic sidecar it blocked learn to a 30s timeout. The
// serialized batch worker must (a) never drop a batch and (b) let learn return without awaiting the embed.
// This is a live test (needs the global oracle from test/setup/oracle-global.ts).
import { describe, expect, it } from "vitest";
import { OracleAdapter } from "../src/memory";

describe("embed queue (R2a) — burst ingest never drops vectors", () => {
  it("settles a concurrent burst with zero dropped batches, and learn does not block on the embed", async () => {
    const o = new OracleAdapter(process.env.ORACLE_API_URL ?? "http://localhost:47788");
    const project = `embed_queue_test_${Date.now()}`;
    const N = 32; // 32-wide concurrent — the race condition that dropped vectors before the single writer
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: N }, (_, i) => o.learn(`embed queue probe doc ${i} about topic ${i % 5} basil mint`, { project })),
    );
    const learnMs = Date.now() - t0;
    const s = await o.settleVectors();
    expect(s.failed).toBe(0); // a concurrent-write race (the old single-row add) resurfaces as failed > 0
    // learn returns before the embed worker finishes: N enqueues must be far cheaper than N embeds+writes.
    expect(learnMs).toBeLessThan(10_000);
  });
});
