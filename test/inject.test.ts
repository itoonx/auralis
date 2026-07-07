// P1: the injected seed context must be CITABLE — ids in brackets + the cite teach line — so the biggest
// recall path feeds the usage signal (U3 boost, U4 forgetting) instead of starving it.
import { describe, it, expect } from "vitest";
import { MemoryLibrarian } from "../src/participants";
import type { MemoryAdapter, SearchHit } from "../src/memory";

class FakeAdapter implements MemoryAdapter {
  async search(): Promise<SearchHit[]> {
    return [
      { id: "doc_1", content: "the signing flow lives in signer.ts" },
      { id: "doc_2", content: "sessions persist via a signed cookie" },
    ];
  }
  async learn(): Promise<{ id: string }> {
    return { id: "x" };
  }
}

describe("injectFor (P1 citable injection)", () => {
  it("shows each hit's [id] and teaches cite once", async () => {
    const lib = new MemoryLibrarian(new FakeAdapter(), "p");
    const { context, hitIds } = await lib.injectFor("how does signing work");
    expect(context).toContain("[doc_1] the signing flow lives in signer.ts");
    expect(context).toContain("[doc_2]");
    expect(context.match(/mcp__oracle__cite/g)?.length).toBe(1); // teach line exactly once
    expect(context).toContain("only real help"); // the anti-inflation wording must survive edits
    expect(hitIds).toEqual(["doc_1", "doc_2"]);
  });

  it("an empty brain injects nothing — no orphan teach line", async () => {
    class Empty extends FakeAdapter {
      override async search(): Promise<SearchHit[]> {
        return [];
      }
    }
    const { context } = await new MemoryLibrarian(new Empty(), "p").injectFor("anything");
    expect(context).toBe("");
  });
});
