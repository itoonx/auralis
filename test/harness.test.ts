// Deterministic end-to-end of the coordination path: no LLM, no network. Proves the shared brain
// cuts cross-worker redundant exploration and that the mozaik bus/observer fire.
import { describe, it, expect } from "vitest";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { Worker, Auditor, MemoryLibrarian, conductRun, type TaskSpec } from "../src/participants";
import { StubRunner } from "../src/runner";
import { NullMemoryAdapter, type MemoryAdapter, type SearchHit } from "../src/memory";
import { redundantCount, reductionPct } from "../src/metrics";

// In-memory brain: learn stores the pattern; search returns any doc sharing a content word with the query.
class FakeAdapter implements MemoryAdapter {
  private docs: { id: string; content: string }[] = [];
  private n = 0;
  async search(query: string): Promise<SearchHit[]> {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    return this.docs
      .filter((d) => words.some((w) => d.content.toLowerCase().includes(w)))
      .map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(pattern: string): Promise<{ id: string }> {
    const id = `doc_${++this.n}`;
    this.docs.push({ id, content: pattern });
    return { id };
  }
}

const SHARED = ["core/engine.ts", "core/shared.ts"]; // the common core both workers would otherwise re-read
const task: TaskSpec = {
  qA: "how does module A process a request",
  qB: "how does module B process a request",
};

function society(adapter: MemoryAdapter) {
  const env = new AgenticEnvironment();
  const auditor = new Auditor();
  auditor.join(env);
  const a = new Worker("A", env, new StubRunner([...SHARED, "moduleA.ts"]));
  a.join(env);
  const b = new Worker("B", env, new StubRunner([...SHARED, "moduleB.ts"]));
  b.join(env);
  return { auditor, a, b, librarian: new MemoryLibrarian(adapter) };
}

describe("shared brain beats baseline (deterministic)", () => {
  it("cuts cross-worker redundant exploration and records reuse", async () => {
    const base = society(new NullMemoryAdapter());
    const baseOut = await conductRun(task, base.a, base.b, base.librarian);

    const shared = society(new FakeAdapter());
    const sharedOut = await conductRun(task, shared.a, shared.b, shared.librarian);

    const baseRed = redundantCount(baseOut.exploredA, baseOut.exploredB);
    const sharedRed = redundantCount(sharedOut.exploredA, sharedOut.exploredB);

    expect(baseRed).toBeGreaterThan(0); // baseline re-explores the shared core
    expect(reductionPct(baseRed, sharedRed)).toBeGreaterThanOrEqual(0.3);
    expect(sharedOut.reuse).toBe(true); // B reused a doc A wrote
    expect(base.auditor.events.length).toBeGreaterThan(0); // mozaik bus + observer worked
  });
});
