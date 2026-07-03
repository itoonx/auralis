// Distillation: cluster similar findings, and consolidate a cluster into a vetted finding while
// SUPERSEDING the raws (never deleting) — the raws and the vetted result all remain, but only the
// vetted one is "live" (unsuperseded).
import { describe, it, expect } from "vitest";
import { clusterFindings, distill } from "../src/distill";
import type { MemoryAdapter, SearchHit } from "../src/memory";

const TOPICS = ["auth", "login", "credential", "session", "bitcoin", "fee", "mempool", "token"];
function fakeEmbed(text: string): number[] {
  const v = TOPICS.map((t) => (text.toLowerCase().includes(t) ? 1 : 0));
  const n = Math.sqrt(v.reduce((a: number, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / n);
}

class FakeAdapter implements MemoryAdapter {
  docs: { id: string; content: string; tier: string; supersededBy?: string }[] = [];
  private n = 0;
  async search(): Promise<SearchHit[]> {
    return this.docs.map((d) => ({ id: d.id, content: d.content }));
  }
  async learn(p: string, opts: any = {}): Promise<{ id: string }> {
    const id = `doc_${++this.n}`;
    this.docs.push({ id, content: p, tier: opts.tier ?? "raw" });
    return { id };
  }
  async supersede(oldId: string, newId: string): Promise<void> {
    const d = this.docs.find((x) => x.id === oldId);
    if (d) d.supersededBy = newId;
  }
  async listDocs(opts: any = {}): Promise<{ id: string; content: string; tier?: string }[]> {
    return this.docs.filter((d) => !d.supersededBy && (!opts.tier || d.tier === opts.tier)).map((d) => ({ id: d.id, content: d.content, tier: d.tier }));
  }
}

describe("clusterFindings", () => {
  it("groups similar vectors and keeps dissimilar ones apart", () => {
    const items = [
      { id: "a", vector: fakeEmbed("auth login session") },
      { id: "b", vector: fakeEmbed("login credential session") },
      { id: "c", vector: fakeEmbed("bitcoin mempool fee") },
    ];
    const groups = clusterFindings(items, 0.5).map((g) => [...g].sort());
    expect(groups.find((g) => g.includes("a"))).toEqual(["a", "b"]);
    expect(groups.some((g) => g.length === 1 && g[0] === "c")).toBe(true);
  });
});

describe("distill", () => {
  it("consolidates a cluster into a vetted finding and supersedes the raws", async () => {
    const a = new FakeAdapter();
    await a.learn("authentication and login and session", { tier: "raw" });
    await a.learn("login credentials and session token", { tier: "raw" });
    await a.learn("bitcoin mempool fee estimation", { tier: "raw" });

    const res = await distill(a, "p", { threshold: 0.5, embed: async (t) => fakeEmbed(t), synthesize: async (cs) => `VETTED(${cs.length})` });

    expect(res.distilled).toBe(1);
    expect(res.superseded).toBe(2);
    expect(a.docs.find((d) => d.tier === "distilled")?.content).toContain("VETTED(2)");
    // live (unsuperseded) = the untouched bitcoin raw + the new vetted one
    expect((await a.listDocs({})).length).toBe(2);
  });
});
