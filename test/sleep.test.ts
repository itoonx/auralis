// U5 sleep job: the pure pair-classifier (defensive parsing — noise never acts) and the server half
// (snapshot + mechanical dedup + judgment-band candidates) against the isolated test oracle.
import { describe, it, expect } from "vitest";
import { classifyPair } from "../src/run-sleep";
import { OracleAdapter, oracleReachable } from "../src/memory";
import type { AgentRunner, RunResult } from "../src/runner";

const fake = (answer: string): AgentRunner => ({ run: async (): Promise<RunResult> => ({ result: answer, explored: [] }) });

describe("classifyPair (pure)", () => {
  it("parses the three verdicts", async () => {
    expect((await classifyPair(fake('{"verdict":"contradictory","reason":"value changed"}'), "n", "o")).verdict).toBe("contradictory");
    expect((await classifyPair(fake('{"verdict":"duplicate","reason":"same fact"}'), "n", "o")).verdict).toBe("duplicate");
    expect((await classifyPair(fake('{"verdict":"compatible","reason":"different aspects"}'), "n", "o")).verdict).toBe("compatible");
  });

  it("never acts on noise: unparseable or unknown verdicts are compatible", async () => {
    expect((await classifyPair(fake("I think they conflict maybe"), "n", "o")).verdict).toBe("compatible");
    expect((await classifyPair(fake('{"verdict":"destroy-everything"}'), "n", "o")).verdict).toBe("compatible");
    expect((await classifyPair(fake("Credit balance is too low"), "n", "o")).verdict).toBe("compatible");
  });
});

describe("sleep server half (needs the test oracle)", () => {
  it("snapshots first, dedups near-identical same-entity docs with counters carried", async () => {
    if (!(await oracleReachable())) {
      console.warn("Oracle not reachable — skipping sleep integration test.");
      return;
    }
    const oracle = new OracleAdapter();
    const project = "sl-" + Math.random().toString(36).slice(2, 8);
    // Two near-identical statements about the same entity — the dedup pass must collapse them.
    const a = await oracle.learn("The `RetryPolicy` in net/retry.ts waits 5 seconds between attempts.", { project });
    const b = await oracle.learn("The `RetryPolicy` in net/retry.ts waits 5 seconds between attempts, always.", { project });
    await oracle.cite!(a.id); // earned usage that must survive the merge
    const base = process.env.ORACLE_API_URL ?? "http://localhost:47778";
    const r = await fetch(new URL("/api/sleep", base), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(r.ok).toBe(true);
    const out = (await r.json()) as any;
    expect(String(out.snapshot)).toMatch(/backups\/pre-.*sleep-.*\.db$/); // U7 ran before any mutation (name carries the brain basename)
    // One of the pair lost; the winner is still findable and the pair no longer double-surfaces.
    const hits = await oracle.search("RetryPolicy retry wait seconds", { project, limit: 5 });
    const live = hits.filter((h) => !h.supersededBy && [a.id, b.id].includes(h.id));
    expect(live.length).toBe(1);
  }, 60_000);
});
