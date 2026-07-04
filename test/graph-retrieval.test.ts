// M2: recall USES the graph. injectFor blends flat search with a graph-neighborhood expansion, so it
// surfaces a finding that is CONNECTED to the query's entities even when it shares no keywords — the
// thing flat recall structurally can't do.
import { describe, it, expect } from "vitest";
import { extractEntities, entityVariants } from "../src/graph";
import { MemoryLibrarian } from "../src/participants";
import { NullMemoryAdapter } from "../src/memory";
import type { MemoryAdapter, GraphEdge, SearchHit } from "../src/memory";

describe("extractEntities", () => {
  it("returns entities most-mentioned first", () => {
    const ents = extractEntities("`AuthService` wraps `AuthService`; `AuthService` also calls `Logger`.");
    expect(ents[0]).toBe("AuthService"); // most mentions → first
    expect(ents).toContain("Logger");
  });
});

// search() = naive keyword match; graph() = edge lookup by normalized entity (with docId provenance).
class GraphFake implements MemoryAdapter {
  docs: { id: string; content: string }[] = [];
  edges: GraphEdge[] = [];
  async search(query: string): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    return this.docs
      .filter((d) => terms.some((t) => d.content.toLowerCase().includes(t)))
      .map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(): Promise<{ id: string }> {
    return { id: "x" };
  }
  async graph(entity: string): Promise<{ edges: GraphEdge[]; entities: string[] }> {
    const key = entity.toLowerCase().trim();
    const hit = this.edges.filter((e) => e.subject.toLowerCase() === key || e.object.toLowerCase() === key);
    return { edges: hit, entities: [...new Set(hit.flatMap((e) => [e.subject, e.object]))] };
  }
}

describe("graph retrieval into recall (M2)", () => {
  it("surfaces a connected finding that flat search misses", async () => {
    const a = new GraphFake();
    a.docs.push({ id: "docA", content: "The login flow lives in auth/session.ts" });
    a.docs.push({ id: "docB", content: "A signed cookie carries the session between requests" });
    // cognify(docB) produced this edge — docB never mentions 'login', but is graph-connected to docA's entity.
    a.edges.push({ subject: "auth/session.ts", predicate: "sets", object: "signed cookie", docId: "docB" });

    const { context, hitIds } = await new MemoryLibrarian(a, "demo").injectFor("how does login work");

    expect(context).toContain("Connected in the knowledge graph");
    expect(context).toContain("signed cookie");
    expect(hitIds).toContain("docA"); // flat keyword hit
    expect(hitIds).toContain("docB"); // surfaced purely by the graph
  });

  it("adds no graph block for the null (baseline) adapter", async () => {
    const { context } = await new MemoryLibrarian(new NullMemoryAdapter(), "demo").injectFor("anything");
    expect(context).not.toContain("Connected in the knowledge graph");
  });
});

describe("entityVariants (fuzzy resolution)", () => {
  it("expands a path to its basename and stem", () => {
    const v = entityVariants("auth/session.ts");
    expect(v).toContain("auth/session.ts");
    expect(v).toContain("session.ts"); // basename
    expect(v).toContain("session"); // stem
  });
});

describe("fuzzy graph retrieval", () => {
  it("connects findings that named the same entity in different forms", async () => {
    const a = new GraphFake();
    a.docs.push({ id: "docA", content: "The login flow lives in auth/session.ts" });
    // docB cognified under the BASENAME form 'session.ts' (a different agent, different casing/path depth)
    a.edges.push({ subject: "session.ts", predicate: "sets", object: "signed cookie", docId: "docB" });

    const { context, hitIds } = await new MemoryLibrarian(a, "demo").injectFor("how does login work");
    // seed 'auth/session.ts' expands to the 'session.ts' variant, matching docB's edge
    expect(context).toContain("signed cookie");
    expect(hitIds).toContain("docB");
  });
});
