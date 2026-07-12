// /brainstorm engine (docs/prd-multi-runner.md M6) — a panel of models thinks together until it converges,
// then a synthesizer merges the best idea and the brief is LEARNED into the brain. Pure and injectable:
// a Panelist is just (prompt) => text, so the whole loop is testable with scripted panelists, no LLM.
//
// Loop: round 0 independent proposals (diversity first) → rounds 1..K each panelist sees the whole board
// and returns structured {revision, critiques, vote} → converge when votes stable 2 rounds / delta≈0 / K.

export type Panelist = { name: string; run: (prompt: string) => Promise<string> };

export interface RoundEntry { name: string; idea: string; critiques: string[]; vote: string }
export interface BrainstormResult {
  topic: string;
  rounds: RoundEntry[][]; // rounds[i] = every panelist's entry that round
  synthesis: string;
  converged: "vote-stable" | "no-change" | "max-rounds";
  roundsUsed: number;
}

export interface BrainstormOpts {
  rounds?: number; // hard cap (default 3)
  onEvent?: (kind: string, name: string, human: string) => void; // timeline hook
}

// Tolerant structured-output parse: models drift from JSON, so accept a fenced/loose object and fall back
// to treating the whole text as the idea (never crash the panel on one bad emit).
export function parseEntry(name: string, text: string): RoundEntry {
  const obj = extractObject(text);
  if (obj) {
    return {
      name,
      idea: String(obj.idea ?? obj.revision ?? obj.idea_revision ?? "").trim() || text.trim(),
      critiques: Array.isArray(obj.critiques) ? obj.critiques.map((c: any) => (typeof c === "string" ? c : `${c.of ?? "?"}: ${c.point ?? ""}`)).filter(Boolean) : [],
      vote: String(obj.vote ?? "").trim(),
    };
  }
  return { name, idea: text.trim(), critiques: [], vote: "" };
}

function extractObject(text: string): any | null {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const raw = fenced ? fenced[1] : (() => { const s = text.indexOf("{"), e = text.lastIndexOf("}"); return s >= 0 && e > s ? text.slice(s, e + 1) : null; })();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const PROPOSE = (topic: string) =>
  `You are on a panel brainstorming the best answer to this problem. Give your BEST independent idea — do ` +
  `not hedge, take a position.\n\nProblem: ${topic}\n\n` +
  `Reply with JSON only: {"idea":"your concrete proposal","vote":"a one-line summary of what you'd pick"}`;

const CRITIQUE = (topic: string, board: RoundEntry[]) =>
  `Panel brainstorm — problem: ${topic}\n\nThe whole board this round:\n` +
  board.map((e) => `[${e.name}] ${e.idea}${e.vote ? `  (picks: ${e.vote})` : ""}`).join("\n\n") +
  `\n\nRevise YOUR idea in light of the others — borrow what's better, defend what's right, drop what's ` +
  `been refuted. Reply with JSON only: {"idea":"your revised proposal","critiques":["short point about ` +
  `another idea", "..."],"vote":"the ONE approach you now back, one line"}`;

const SYNTHESIZE = (topic: string, rounds: RoundEntry[][]) =>
  `You are the synthesizer for a multi-model panel. Problem: ${topic}\n\nFinal positions:\n` +
  (rounds.at(-1) ?? []).map((e) => `[${e.name}] backs: ${e.vote || e.idea.slice(0, 120)}`).join("\n") +
  `\n\nWrite the decision brief: the single best answer and WHY it won, what each panelist contributed, ` +
  `the strongest rejected alternative and why it lost, and any open risk. Be concrete and concise.`;

// A round "signature" = the multiset of votes, normalized. Stable across two rounds ⇒ converged.
const voteSig = (r: RoundEntry[]) => r.map((e) => e.vote.toLowerCase().replace(/\s+/g, " ").trim()).sort().join(" | ");
const ideaSig = (r: RoundEntry[]) => r.map((e) => e.idea.toLowerCase().replace(/\s+/g, " ").trim()).sort().join(" | ");

export async function brainstorm(topic: string, panel: Panelist[], synthesizer: Panelist, opts: BrainstormOpts = {}): Promise<BrainstormResult> {
  if (!panel.length) throw new Error("brainstorm needs at least one panelist");
  const maxRounds = Math.max(1, opts.rounds ?? 3);
  const ev = opts.onEvent;
  const rounds: RoundEntry[][] = [];

  // round 0 — independent proposals (no cross-talk; diversity first)
  ev?.("phase", "panel", `round 1/${maxRounds} · ${panel.length} models proposing independently`);
  rounds.push(await Promise.all(panel.map(async (p) => {
    const entry = parseEntry(p.name, await p.run(PROPOSE(topic)));
    ev?.("finding", p.name, `${p.name}: ${entry.idea.slice(0, 90)}`);
    return entry;
  })));

  let converged: BrainstormResult["converged"] = "max-rounds";
  for (let r = 1; r < maxRounds; r++) {
    const board = rounds[rounds.length - 1];
    ev?.("phase", "panel", `round ${r + 1}/${maxRounds} · critique + revise`);
    const next = await Promise.all(panel.map(async (p) => {
      const entry = parseEntry(p.name, await p.run(CRITIQUE(topic, board)));
      ev?.("finding", p.name, `${p.name}: ${entry.vote || entry.idea.slice(0, 90)}`);
      return entry;
    }));
    rounds.push(next);
    // no substantive change this round → done
    if (ideaSig(next) === ideaSig(board)) { converged = "no-change"; break; }
    // votes identical for two consecutive rounds → done
    if (voteSig(next) === voteSig(board) && next.some((e) => e.vote)) { converged = "vote-stable"; break; }
  }

  ev?.("phase", "synthesizer", `synthesizing from ${rounds.length} round(s) (${converged})`);
  const synthesis = (await synthesizer.run(SYNTHESIZE(topic, rounds))).trim();
  return { topic, rounds, synthesis, converged, roundsUsed: rounds.length };
}
