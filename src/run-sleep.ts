// `pnpm sleep` — the full U5 sleep job. The server half (POST /api/sleep) snapshots the brain (U7) and
// runs the mechanical dedup pass, then hands back the AMBIGUOUS same-entity pairs (cos ~0.75–0.92) that
// need judgment. This host half classifies each pair with Claude Code and acts:
//   contradictory → the newer fact INVALIDATES the older (the world changed — Zep's "new information wins")
//   duplicate     → the older is SUPERSEDED by the newer (dedup the band missed)
//   compatible    → nothing; both stay current.
// Budget-capped, append-only either way, and the snapshot taken BEFORE any of it means one file restores
// everything. AURALIS_SLEEP_LLM=0 skips judgment and only reports the candidates.
import { OracleAdapter, oracleReachable } from "./memory";
import { ClaudeCodeRunner, type AgentRunner } from "./runner";

export type Verdict = "contradictory" | "duplicate" | "compatible";

// Pure: one pair → verdict, parsed defensively (an unparseable answer is "compatible" — never act on noise).
export async function classifyPair(runner: AgentRunner, newer: string, older: string): Promise<{ verdict: Verdict; reason: string }> {
  const prompt =
    `Two memory records about the same entity, NEWER first:\n\nNEWER: ${newer}\n\nOLDER: ${older}\n\n` +
    `Classify their relationship. Answer with EXACTLY one line of JSON, nothing else:\n` +
    `{"verdict":"contradictory|duplicate|compatible","reason":"<one short sentence>"}\n` +
    `contradictory = they cannot both be true now (a value/behaviour changed). duplicate = same statement in different words. compatible = both can hold.`;
  try {
    const { result } = await runner.run(prompt);
    const m = result.match(/\{[\s\S]*?\}/);
    if (!m) return { verdict: "compatible", reason: "unparseable — no action" };
    const o = JSON.parse(m[0]);
    const v = String(o?.verdict ?? "");
    if (v === "contradictory" || v === "duplicate") return { verdict: v, reason: String(o?.reason ?? "") };
    return { verdict: "compatible", reason: String(o?.reason ?? "") };
  } catch {
    return { verdict: "compatible", reason: "classification failed — no action" };
  }
}

async function main() {
  if (!(await oracleReachable())) {
    console.error("oracle-lite is not reachable on :47778 — start it first (`pnpm oracle` or `auralis start`).");
    process.exit(1);
  }
  const oracle = new OracleAdapter();
  const base = process.env.ORACLE_API_URL ?? "http://localhost:47778";
  const auth: Record<string, string> = process.env.ORACLE_TOKEN ? { authorization: `Bearer ${process.env.ORACLE_TOKEN}` } : {};
  const r = await fetch(new URL("/api/sleep", base), { method: "POST", headers: { "content-type": "application/json", ...auth }, body: "{}" });
  if (!r.ok) throw new Error(`/api/sleep → ${r.status}`);
  const sleep = (await r.json()) as { snapshot: string; deduped: number; scanned: number; candidates: { newerId: string; olderId: string; newer: string; older: string }[] };

  console.log(`━━━ sleep ━━━`);
  console.log(`  snapshot   ${sleep.snapshot}`);
  console.log(`  dedup      ${sleep.deduped} superseded (of ${sleep.scanned} scanned)`);
  console.log(`  ambiguous  ${sleep.candidates.length} same-entity pair(s) in the judgment band`);

  const useLlm = process.env.AURALIS_SLEEP_LLM !== "0" && sleep.candidates.length > 0;
  if (!useLlm) {
    if (sleep.candidates.length) console.log("  (AURALIS_SLEEP_LLM=0 — candidates reported, not judged)");
    return;
  }
  const runner = new ClaudeCodeRunner({ cwd: process.cwd(), maxTurns: 2 });
  let contradicted = 0, duplicated = 0;
  for (const c of sleep.candidates) {
    const { verdict, reason } = await classifyPair(runner, c.newer, c.older);
    if (verdict === "contradictory") {
      await oracle.invalidate!(c.olderId, { newId: c.newerId, reason: `sleep: ${reason}` });
      contradicted++;
      console.log(`  ↻ invalidated ${c.olderId.slice(0, 40)} — ${reason}`);
    } else if (verdict === "duplicate") {
      await oracle.supersede!(c.olderId, c.newerId, `sleep: ${reason}`);
      duplicated++;
      console.log(`  ⇄ superseded ${c.olderId.slice(0, 40)} — ${reason}`);
    }
  }
  console.log(`\n  judged ${sleep.candidates.length} → contradictions ${contradicted} · duplicates ${duplicated} · compatible ${sleep.candidates.length - contradicted - duplicated}`);
}

// Import-safe for tests (classifyPair is the unit under test).
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
