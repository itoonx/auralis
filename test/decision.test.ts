// Honest ADRs into the brain: the format keeps rejected alternatives and, when the agent captured no
// external constraints, explicitly hands that off to a human. A reversed decision is superseded (kept),
// never deleted — so the original AND its reversal both survive and stay searchable.
import { describe, it, expect } from "vitest";
import { formatDecision, recordDecision, listDecisions, reverseDecision } from "../src/decision";
import type { MemoryAdapter, SearchHit } from "../src/memory";

class FakeAdapter implements MemoryAdapter {
  private docs: { id: string; content: string; supersededBy?: string }[] = [];
  private n = 0;
  async search(q: string): Promise<SearchHit[]> {
    const w = q.toLowerCase().split(/\W+/).filter((x) => x.length > 2);
    return this.docs.filter((d) => w.some((x) => d.content.toLowerCase().includes(x))).map((d) => ({ id: d.id, content: d.content, supersededBy: d.supersededBy }));
  }
  async learn(p: string): Promise<{ id: string }> {
    const id = `doc_${++this.n}`;
    this.docs.push({ id, content: p });
    return { id };
  }
  async supersede(oldId: string, newId: string): Promise<void> {
    const d = this.docs.find((x) => x.id === oldId);
    if (d) d.supersededBy = newId; // flag, never delete
  }
  find(id: string) {
    return this.docs.find((d) => d.id === id);
  }
}

describe("decisions (honest ADR into the brain)", () => {
  it("keeps rejected alternatives and flags missing external constraints for a human", () => {
    const text = formatDecision({ title: "use SQLite", chose: "SQLite FTS5", because: "zero-config and fast", rejected: [{ option: "Postgres", why: "operational overkill here" }] });
    expect(text).toContain("use SQLite");
    expect(text).toContain("Postgres");
    expect(text.toLowerCase()).toContain("human");
  });

  it("records a decision and lists it back from the brain", async () => {
    const a = new FakeAdapter();
    await recordDecision(a, "p", { title: "pick LanceDB", chose: "LanceDB", because: "loads under Bun", external: ["no Ollama available on the box"] });
    const list = await listDecisions(a, "p");
    expect(list.length).toBe(1);
    expect(list[0].text).toContain("pick LanceDB");
    expect(list[0].text).toContain("no Ollama available");
  });

  it("reverses a decision by superseding it (never deletes) — both survive", async () => {
    const a = new FakeAdapter();
    const first = await recordDecision(a, "p", { title: "use library A", chose: "A", because: "simplest" });
    const second = await reverseDecision(a, "p", first.id, { title: "switch to library B", chose: "B", because: "A was abandoned upstream" });
    expect(a.find(first.id)).toBeDefined(); // original still there
    expect(a.find(first.id)!.supersededBy).toBe(second.id); // marked reversed, not deleted
    expect((await listDecisions(a, "p")).length).toBe(2); // both are searchable
  });
});
