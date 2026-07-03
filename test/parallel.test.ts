// Level-parallel coordination: same-level nodes run concurrently when concurrency > 1, stays strictly
// sequential at concurrency = 1 (the default), and cross-level ordering is preserved so a dependent
// task still sees its prerequisite's finding.
import { describe, it, expect } from "vitest";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { Worker, MemoryLibrarian } from "../src/participants";
import { coordinate } from "../src/conductor";
import { StubRunner } from "../src/runner";
import { NullMemoryAdapter, type MemoryAdapter, type SearchHit } from "../src/memory";
import type { AgentRunner, RunResult } from "../src/runner";
import type { DagNode } from "../src/dag";

// Records the peak number of concurrently-running workers.
class ProbeRunner implements AgentRunner {
  constructor(private readonly state: { active: number; max: number }) {}
  async run(): Promise<RunResult> {
    this.state.active++;
    this.state.max = Math.max(this.state.max, this.state.active);
    await new Promise((r) => setTimeout(r, 15));
    this.state.active--;
    return { result: "ok", explored: [] };
  }
}

class FakeAdapter implements MemoryAdapter {
  private docs: { id: string; content: string }[] = [];
  private n = 0;
  async search(query: string): Promise<SearchHit[]> {
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    return this.docs.filter((d) => words.some((w) => d.content.toLowerCase().includes(w))).map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(pattern: string): Promise<{ id: string }> {
    const id = `doc_${++this.n}`;
    this.docs.push({ id, content: pattern });
    return { id };
  }
}

function society(runnerFor: (id: string) => AgentRunner, adapter: MemoryAdapter) {
  const env = new AgenticEnvironment();
  const makeWorker = (id: string) => {
    const w = new Worker(id, env, runnerFor(id));
    w.join(env);
    return w;
  };
  return { makeWorker, librarian: new MemoryLibrarian(adapter) };
}

const flat: DagNode[] = [
  { id: "a", question: "qa", dependsOn: [] },
  { id: "b", question: "qb", dependsOn: [] },
  { id: "c", question: "qc", dependsOn: [] },
];

describe("parallel coordinate", () => {
  it("runs same-level nodes concurrently when concurrency > 1", async () => {
    const state = { active: 0, max: 0 };
    const s = society(() => new ProbeRunner(state), new NullMemoryAdapter());
    await coordinate(flat, s.makeWorker, s.librarian, { concurrency: 3 });
    expect(state.max).toBeGreaterThanOrEqual(2);
  });

  it("stays strictly sequential at concurrency = 1 (default)", async () => {
    const state = { active: 0, max: 0 };
    const s = society(() => new ProbeRunner(state), new NullMemoryAdapter());
    await coordinate(flat, s.makeWorker, s.librarian);
    expect(state.max).toBe(1);
  });

  it("preserves cross-level ordering: a dependent task sees its prerequisite's finding", async () => {
    const nodes: DagNode[] = [
      { id: "root", question: "analyze the core module", dependsOn: [] },
      { id: "child", question: "analyze how the core module is used", dependsOn: ["root"] },
    ];
    const s = society(() => new StubRunner([]), new FakeAdapter());
    const out = await coordinate(nodes, s.makeWorker, s.librarian, { concurrency: 3 });
    const child = out.provenance.find((p) => p.task === "child");
    expect(child?.recalled.length).toBeGreaterThanOrEqual(1);
  });
});
