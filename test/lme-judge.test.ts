// M1 judge regression fixtures: every observed judge false-negative becomes a permanent case the
// deterministic pre-check must catch (the ruler gets a unit test). Grown each time a human audit
// finds a new bad verdict — never delete a case.
import { describe, expect, it } from "vitest";
import { goldPrecheck } from "../src/run-longmemeval";

describe("goldPrecheck — judge false-negative regression set", () => {
  it("catches every observed judge FN (gold present verbatim → correct, no LLM needed)", () => {
    const observed: [unknown, string][] = [
      // held-out run 2026-07-09: judged ❌ although the gold is the first two words
      ["Premier Silver", "Premier Silver — you mentioned hitting 20,000 miles and becoming eligible for Premier Silver (2022-09-16), before reaching your current Premier Gold status (2023-05-30)."],
      // held-out run 2026-07-09: judged ❌ although the gold is named verbatim (markdown-wrapped)
      ["Nu, pogodi!", 'The Soviet cartoon was **"Nu, pogodi!"** — I described it as mocking Western culture and portraying the Soviet Union as superior.'],
      // sanity-gate era: gold "4" vs "Four … Mummies (4)" judged wrong
      ["4", "Four. The excerpt lists the exhibits: Ancient Egypt — Mummies (4) among them."],
    ];
    for (const [gold, resp] of observed) expect(goldPrecheck(gold, resp), String(gold)).toBe(true);
  });

  it("does not overclaim — wrong answers and trivial golds fall through to the LLM judge", () => {
    expect(goldPrecheck("Serenity Yoga", "You take yoga classes at home using the Down Dog app.")).toBe(false);
    expect(goldPrecheck("no", "novel ideas were discussed at length")).toBe(false); // <4 chars: never precheck
    expect(goldPrecheck(3, "there were 30 people at the event")).toBe(false); // number needs word boundary
    expect(goldPrecheck(3, "there were 3 people at the event")).toBe(true);
    expect(goldPrecheck(null, "anything")).toBe(false);
    expect(goldPrecheck({ complex: "gold" }, "anything")).toBe(false);
  });

  it("normalizes punctuation and markdown, not meaning", () => {
    expect(goldPrecheck("Patagonia and Southwest Airlines.", "The two companies were **Patagonia and Southwest Airlines** — both prioritize safety.")).toBe(true);
    expect(goldPrecheck("28. Kg3", "My reply was 28. Kg3, attacking the bishop.")).toBe(true);
    expect(goldPrecheck("3.5 weeks", "It took 3.5 weeks in total.")).toBe(true);
  });
});
