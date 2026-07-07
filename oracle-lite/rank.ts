// Ranking v2 (U1+U2 from docs/research-memory-os.md): Reciprocal Rank Fusion over the FTS and vector
// lists, then boost multipliers from columns. Pure functions — the server wires them to SQL; tests hit
// them directly. Two design rules from the research: (1) RRF is rank-only, so the incompatible score
// scales of bm25 and cosine never mix; (2) relevance dominates — recency/usage/trust NUDGE (bounded
// multiplier), they never gate.

export const RRF_K = 60; // universal default from the IR literature — gentle decay, rewards consistency

// Reciprocal Rank Fusion: each list is doc ids in rank order (best first). Score = Σ 1/(k + rank).
// A doc found by BOTH lists naturally outranks a doc found by one — no both-modes bonus needed.
export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i];
      score.set(id, (score.get(id) ?? 0) + 1 / (k + i + 1));
    }
  }
  return score;
}

// Trust prior by source (U2). Defaults LOW — Memoria's anti-lesson: unvetted content must not be born
// "verified". ⟲ RETRO is derived from a measured acceptance run, so it earns the test-derived tier.
export function trustOf(source: string): number {
  if (source.startsWith("human")) return 1.0;
  if (source === "auralis:retro") return 0.85; // derived from a real acceptance PASS/FAIL
  if (source === "auralis:decision" || source === "auralis:distilled") return 0.7; // explicit / corroborated
  return 0.5; // agent_inferred — the floor for worker findings
}

export interface BoostInputs {
  trust: number; // [0,1] from trustOf, stored at learn time
  timesUsed: number; // citation count (U3) — 0 until the cite loop lands
  maxUsed: number; // max timesUsed among candidates (log-damped normalizer)
  daysSinceAccess: number; // since last_accessed_at ?? created_at
  superseded: boolean;
}

// final = RRF × (1 + 0.2·recency + 0.1·usage + 0.05·trust) × (superseded ? 0.3 : 1)
// Weights are ordered by how much each may safely move a result: supersede (×0.3) is decisive — a wrong/
// stale answer must sink; citation (0.1) and recency (0.2) are real earned signals; trust is only a
// TIEBREAKER (0.05). The ranking bench (src/run-bench-rank.ts) proved trust at 0.2 could override a genuine
// relevance win (its guardrail query) — RRF is rank-only, so it can't tell a near-tie from a real gap, and a
// strong trust multiplier flips both. So trust nudges exact ties toward the more-credible source and no more;
// its real teeth are in FORGETTING (strength()), not search order. Max multiplier ×1.35 — relevance dominates.
// The component breakdown behind boost() — ONE implementation serves both scoring and `explain=1`
// (philosophy principle 4: every memory must justify why it was retrieved). If the formula and its
// explanation lived apart, they would drift apart.
export function boostParts(b: BoostInputs): { recency: number; usage: number; trust: number; outdated: boolean; multiplier: number } {
  const recency = Math.pow(2, -Math.max(0, b.daysSinceAccess) / 14);
  const usage = b.maxUsed > 0 ? Math.log(1 + Math.max(0, b.timesUsed)) / Math.log(1 + b.maxUsed) : 0;
  const multiplier = (1 + 0.2 * recency + 0.1 * usage + 0.05 * b.trust) * (b.superseded ? 0.3 : 1);
  return { recency, usage, trust: b.trust, outdated: b.superseded, multiplier };
}

export function boost(base: number, b: BoostInputs): number {
  return base * boostParts(b).multiplier;
}

export function daysBetween(fromIso: string | null | undefined, now: number): number {
  if (!fromIso) return 0; // no timestamp → treat as fresh, not dead
  const t = Date.parse(fromIso);
  return Number.isFinite(t) ? (now - t) / 86_400_000 : 0;
}

// U4 forgetting-as-ranking: memory strength decays unless reinforced by use. Retrieval touches
// last_accessed_at, so anything the fleet keeps recalling stays strong (MemoryBank); junk fades.
// Below ARCHIVE_FLOOR the sweep marks it archived=1 — hidden from default search, never deleted
// (deep search still reaches it). Pinned docs (decisions, retros, human) are exempt: never archived.
// Half-lives: raw findings churn fast (14d); distilled knowledge is consolidated — slow (90d).
// An untouched raw worker finding (trust 0.5) crosses the floor after ~47 days.
export const ARCHIVE_FLOOR = 0.05;

export function strength(trust: number, timesUsed: number, daysSinceAccess: number, tier: string): number {
  const halfLife = tier === "distilled" ? 90 : 14;
  return trust * (1 + Math.log(1 + Math.max(0, timesUsed))) * Math.pow(2, -Math.max(0, daysSinceAccess) / halfLife);
}

// Pinned = never forgotten: human-stated, measured retros, and explicit decisions.
export function pinnedOf(source: string): boolean {
  return source.startsWith("human") || source === "auralis:retro" || source === "auralis:decision";
}
