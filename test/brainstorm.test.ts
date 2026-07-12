// M6 — the brainstorm engine: convergence rules, tolerant parsing, event stream. Scripted panelists, no LLM.
import { describe, it, expect } from "vitest";
import { brainstorm, parseEntry, type Panelist } from "../src/brainstorm";

// A panelist that returns a queue of scripted replies (JSON strings), one per call.
const scripted = (name: string, replies: string[]): Panelist => {
  let i = 0;
  return { name, run: async () => replies[Math.min(i++, replies.length - 1)] };
};
const J = (idea: string, vote: string) => JSON.stringify({ idea, vote });

describe("brainstorm engine (M6)", () => {
  it("parseEntry: JSON, fenced JSON, alt keys, and plain-text fallback", () => {
    expect(parseEntry("a", J("use bge", "bge")).vote).toBe("bge");
    expect(parseEntry("a", '```json\n{"idea_revision":"x","vote":"y"}\n```').idea).toBe("x");
    expect(parseEntry("a", "no json here, just prose")).toEqual({ name: "a", idea: "no json here, just prose", critiques: [], vote: "" });
    expect(parseEntry("a", JSON.stringify({ idea: "z", critiques: [{ of: "b", point: "slow" }], vote: "z" })).critiques).toEqual(["b: slow"]);
  });

  it("converges on VOTE-STABLE: two consecutive rounds with the same votes stop early", async () => {
    const panel = [
      scripted("m1", [J("idea A", "A"), J("idea A refined", "A"), J("A", "A")]),
      scripted("m2", [J("idea B", "B"), J("agree", "A"), J("agree", "A")]), // flips to A in round 2
    ];
    const res = await brainstorm("A or B?", panel, scripted("s", ["A wins because …"]), { rounds: 5 });
    expect(res.converged).toBe("vote-stable");
    expect(res.roundsUsed).toBe(3); // r1 {A,B}, r2 {A,A}, r3 {A,A} == r2 → stop
    expect(res.synthesis).toContain("A wins");
  });

  it("converges on NO-CHANGE: identical ideas two rounds running", async () => {
    const same = J("keep it simple", "simple");
    const res = await brainstorm("how?", [scripted("m1", [same, same]), scripted("m2", [J("other", "other"), J("other", "other")])], scripted("s", ["brief"]), { rounds: 4 });
    expect(res.converged).toBe("no-change");
    expect(res.roundsUsed).toBe(2);
  });

  it("hits MAX-ROUNDS when the panel keeps churning", async () => {
    const churn = (n: string) => scripted(n, [J(`${n}1`, `${n}1`), J(`${n}2`, `${n}2`), J(`${n}3`, `${n}3`)]);
    const res = await brainstorm("q", [churn("m1"), churn("m2")], scripted("s", ["brief"]), { rounds: 3 });
    expect(res.converged).toBe("max-rounds");
    expect(res.roundsUsed).toBe(3);
    expect(res.rounds).toHaveLength(3);
  });

  it("emits a timeline event per phase and per panelist finding", async () => {
    const events: string[] = [];
    await brainstorm("q", [scripted("m1", [J("x", "x")]), scripted("m2", [J("x", "x")])], scripted("s", ["b"]), {
      rounds: 1,
      onEvent: (kind, name) => events.push(`${kind}:${name}`),
    });
    expect(events).toContain("phase:panel");
    expect(events).toContain("finding:m1");
    expect(events).toContain("finding:m2");
    expect(events).toContain("phase:synthesizer");
  });

  it("single panelist is allowed; empty panel throws", async () => {
    const res = await brainstorm("q", [scripted("solo", [J("idea", "v")])], scripted("s", ["brief"]), { rounds: 2 });
    expect(res.roundsUsed).toBe(2); // solo repeats its reply → round 2 == round 1 → no-change
    await expect(brainstorm("q", [], scripted("s", ["b"]))).rejects.toThrow(/at least one/);
  });
});
