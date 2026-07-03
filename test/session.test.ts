// Deterministic cross-session persistence: no LLM, no network. A fresh environment (a new "session")
// sharing ONLY a persistent brain recalls an earlier session's finding and explores fewer targets
// than a cold session with no prior knowledge.
import { describe, it, expect } from "vitest";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { Worker, MemoryLibrarian } from "../src/participants";
import { runOneSession } from "../src/conductor";
import { StubRunner } from "../src/runner";
import { NullMemoryAdapter, type MemoryAdapter, type SearchHit } from "../src/memory";

class PersistentFakeAdapter implements MemoryAdapter {
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

const CORE = ["core/a.ts", "core/b.ts"];
const GOAL_SEED = "analyze the shared core modules";
const GOAL_RELATED = "analyze how the entry harness uses the shared core modules";

function factory(env: AgenticEnvironment, files: string[]) {
  return (id: string) => {
    const w = new Worker(id, env, new StubRunner(files));
    w.join(env);
    return w;
  };
}

describe("cross-session persistence (deterministic)", () => {
  it("a fresh session recalls an earlier session's findings and explores less than cold", async () => {
    const brain = new PersistentFakeAdapter(); // survives across sessions

    // session 1 (seed) — fresh env
    await runOneSession(GOAL_SEED, "seed", new MemoryLibrarian(brain), factory(new AgenticEnvironment(), [...CORE, "seed.ts"]));

    // session 2 (warm) — BRAND NEW env, SAME persistent brain
    const warm = await runOneSession(GOAL_RELATED, "warm", new MemoryLibrarian(brain), factory(new AgenticEnvironment(), [...CORE, "related.ts"]));

    // session 3 (cold) — fresh env, NO shared brain
    const cold = await runOneSession(GOAL_RELATED, "cold", new MemoryLibrarian(new NullMemoryAdapter()), factory(new AgenticEnvironment(), [...CORE, "related.ts"]), true);

    expect(warm.crossSessionRecall).toBeGreaterThanOrEqual(1); // recalled seed across a fresh session
    expect(warm.explored).toBeLessThan(cold.explored); // persistence advantage
  });
});
