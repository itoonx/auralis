// Deterministic fleet coordination: no LLM, no network. Proves the DAG walk + shared brain cut FLEET
// redundant exploration, that reuse is recorded, and that the reactive Sentry sees fewer overlaps
// with the shared brain than without.
import { describe, it, expect } from "vitest";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { Worker, Sentry, MemoryLibrarian } from "../src/participants";
import { coordinate } from "../src/conductor";
import { StubRunner } from "../src/runner";
import { NullMemoryAdapter, type MemoryAdapter, type SearchHit } from "../src/memory";
import { fleetRedundantCount, reductionPct } from "../src/metrics";
import type { DagNode } from "../src/dag";

class FakeAdapter implements MemoryAdapter {
  private docs: { id: string; content: string }[] = [];
  private n = 0;
  async search(query: string): Promise<SearchHit[]> {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    return this.docs.filter((d) => words.some((w) => d.content.toLowerCase().includes(w))).map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(pattern: string): Promise<{ id: string }> {
    const id = `doc_${++this.n}`;
    this.docs.push({ id, content: pattern });
    return { id };
  }
}

const CORE = ["core/a.ts", "core/b.ts"]; // both workers would otherwise re-read this
const nodes: DagNode[] = [
  { id: "arch", question: "describe the core architecture modules", dependsOn: [] },
  { id: "flow", question: "describe the core data flow modules", dependsOn: [] },
  { id: "errs", question: "describe the core error handling modules", dependsOn: [] },
];
const files: Record<string, string[]> = {
  arch: [...CORE, "arch.ts"],
  flow: [...CORE, "flow.ts"],
  errs: [...CORE, "errs.ts"],
};

function society(adapter: MemoryAdapter) {
  const env = new AgenticEnvironment();
  const sentry = new Sentry();
  sentry.join(env);
  const makeWorker = (id: string) => {
    const w = new Worker(id, env, new StubRunner(files[id]));
    w.join(env);
    return w;
  };
  return { sentry, makeWorker, librarian: new MemoryLibrarian(adapter) };
}

describe("coordinated fleet beats baseline (deterministic)", () => {
  it("cuts fleet redundancy, records reuse, and Sentry sees fewer overlaps with the brain", async () => {
    const base = society(new NullMemoryAdapter());
    const baseOut = await coordinate(nodes, base.makeWorker, base.librarian);

    const shared = society(new FakeAdapter());
    const sharedOut = await coordinate(nodes, shared.makeWorker, shared.librarian);

    const baseRed = fleetRedundantCount(baseOut.perWorker.map((w) => w.explored));
    const sharedRed = fleetRedundantCount(sharedOut.perWorker.map((w) => w.explored));

    expect(baseRed).toBeGreaterThan(0); // baseline: all 3 re-read the core
    expect(reductionPct(baseRed, sharedRed)).toBeGreaterThanOrEqual(0.3);
    expect(sharedOut.reuses).toBeGreaterThanOrEqual(1); // later tasks reused earlier findings
    expect(base.sentry.warnings.length).toBeGreaterThan(shared.sentry.warnings.length); // reactive observer
  });
});
