// analyze mode wires: plan → fleet → auto-cognify → graph-aware recall → synthesis. The synthesizer must
// see the GRAPH connection (not just flat hits), and graph-surfaced findings must be counted as recalled.
import { describe, it, expect } from "vitest";
import { analyze } from "../src/analyze";
import type { MemoryAdapter, GraphEdge, SearchHit } from "../src/memory";

class Fake implements MemoryAdapter {
  docs = [{ id: "d1", content: "login is handled in auth/session.ts" }];
  edges: GraphEdge[] = [{ subject: "auth/session.ts", predicate: "sets", object: "signed cookie", docId: "d2" }];
  async search(q: string): Promise<SearchHit[]> {
    const terms = q.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    return this.docs.filter((d) => terms.some((t) => d.content.toLowerCase().includes(t))).map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(): Promise<{ id: string }> {
    return { id: "x" };
  }
  async graph(entity: string): Promise<{ edges: GraphEdge[]; entities: string[] }> {
    const k = entity.toLowerCase();
    const h = this.edges.filter((e) => e.subject.toLowerCase() === k || e.object.toLowerCase() === k);
    return { edges: h, entities: [...new Set(h.flatMap((e) => [e.subject, e.object]))] };
  }
}

describe("analyze mode", () => {
  it("synthesizes from graph-aware recall", async () => {
    const a = new Fake();
    const ran = { fleet: false, cognify: false };
    const res = await analyze(a, "demo", "how does login work", {
      resolveTasks: async () => [{ id: "t1", question: "explore", dependsOn: [] }],
      runFleet: async () => {
        ran.fleet = true;
        return {} as never;
      },
      cognifyAll: async () => {
        ran.cognify = true;
        return 1;
      },
      synthesize: async (_g, context) => `ANSWER[${context.includes("signed cookie") ? "graph" : "flat"}]`,
    });
    expect(ran.fleet && ran.cognify).toBe(true);
    expect(res.graphUsed).toBe(true); // graph neighborhood was recalled
    expect(res.answer).toBe("ANSWER[graph]"); // synthesis saw the connection, not just flat hits
    expect(res.recalled).toContain("d2"); // graph-surfaced finding counted as recalled
  });
});
