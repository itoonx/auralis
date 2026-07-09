// `pnpm lme` — the LongMemEval harness (docs/prd-longmemeval.md, phases P1–P3; P4 deliberately deferred).
// Per question: a FRESH project in an isolated scratch brain → ingest every haystack turn through the same
// lanes session-capture uses (user turns trust 1.0 / assistant 0.5, validAt = the session's real date —
// LLM-less, the structural edge) → hybrid retrieval → one Claude call composes the hypothesis → jsonl
// {question_id, hypothesis} compatible with the official judge. A built-in Claude judge gives ITERATION
// numbers; only the official GPT-4o judge produces comparable ones (label anything internal as such).
//
// env: LME_DATA (dataset json) · LME_SUBSET (ids json) · LME_LIMIT · LME_OUT (jsonl)
//      LME_JUDGE=claude|none · AURALIS_SEMANTIC=1 for the P3 embedder arm · LME_CONCURRENCY (default 3)
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { OracleAdapter, oracleReachable } from "./memory";
import { extractEntities } from "./triplets";

const SCRATCH = process.env.LME_SCRATCH ?? "/tmp/auralis-lme";
const PORT = Number(process.env.LME_PORT ?? 47799);
const BASE = `http://localhost:${PORT}`;
const DATA = process.env.LME_DATA ?? `${SCRATCH}/longmemeval_s.json`;
const OUT = process.env.LME_OUT ?? `${SCRATCH}/hypotheses.jsonl`;
const JUDGE = process.env.LME_JUDGE ?? "claude"; // claude | openai | none
const JUDGE_MODEL = process.env.LME_JUDGE_MODEL ?? "gpt-5"; // openai judge model — override if the id differs
const LIMIT = Number(process.env.LME_LIMIT ?? 0);
const CONC = Number(process.env.LME_CONCURRENCY ?? 3);
const EXPAND = process.env.LME_EXPAND !== "0"; // M2 adjacency (default ON = shipped); LME_EXPAND=0 = pre-M2 baseline arm
// Every ask()/judge query() below is an SDK sub-session that inherits this repo's Claude Code hooks. Without
// this, session-capture writes each benchmark answer-prompt into the HUMAN's prod brain (found live: 89 LME
// docs leaked). The spawned CLI inherits process.env, so setting it here stands the hook down for sub-queries.
process.env.AURALIS_NO_CAPTURE = "1";
// Retrieval-recall probe (LLM-free): LME_PROBE_K=12,25,50,100,200 → per question record whether the gold
// string appears in the top-k retrieved content at each k. Splits "retrieval-miss" into ranking-miss
// (gold shows up at higher k → fixable by k/ranking) vs recall-miss (never shows up → needs semantic).
const PROBE = process.env.LME_PROBE_K ? process.env.LME_PROBE_K.split(",").map(Number) : null;

interface Q {
  question_id: string;
  question_type: string;
  question: string;
  answer: unknown;
  question_date: string;
  haystack_dates: string[];
  haystack_sessions: { role: string; content: string; has_answer?: boolean }[][];
  haystack_session_ids?: string[]; // parallel to haystack_sessions — the session id of each
  answer_session_ids?: string[];   // GROUND TRUTH: the sessions that actually contain the evidence
}

// '2023/04/10 (Mon) 17:50' → ISO. Tolerant: unparseable dates just omit validAt (falls back to created_at).
function toIso(d: string): string | undefined {
  const t = Date.parse(d.replace(/\s*\([^)]*\)\s*/, " "));
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// A memory unit should be a unit of THOUGHT, not a whole turn — the same chunking policy the
// session-capture ingress uses in production (single source of truth lives with the hook).
// @ts-expect-error — plain .mjs module, no types
import { chunkTurn } from "../hooks/session-capture.mjs";

async function ask(prompt: string): Promise<string> {
  let out = "";
  for await (const m of query({ prompt, options: { cwd: SCRATCH, maxTurns: 1, allowedTools: [] } as any })) {
    const msg: any = m;
    if (msg.type === "result" && msg.subtype === "success") out = String(msg.result ?? "");
  }
  return out.trim();
}

// OpenAI judge backend (LME_JUDGE=openai). A cross-family verdict: avoids Claude judging Claude
// (self-preference bias) and moves the internal number toward the official GPT-4o protocol. Plain
// fetch — no SDK dependency. `temperature` omitted so reasoning models that reject it don't 400.
async function askOpenAI(prompt: string, model: string = JUDGE_MODEL): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OpenAI backend needs OPENAI_API_KEY");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`openai ${model} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return String(j.choices?.[0]?.message?.content ?? "").trim();
}
const judgeAsk = (prompt: string) => (JUDGE === "openai" ? askOpenAI(prompt) : ask(prompt));
// Answer backend: default Claude (auralis's real-world config, but 500 answers can exhaust the session
// window). LME_ANSWER=openai answers with GPT-4o too — an apples-to-apples number vs Zep/Mem0 (both
// GPT-4o-answered) that also sidesteps the Claude window entirely (the whole P4 run stays on OpenAI).
const ANSWER_MODEL = process.env.LME_ANSWER_MODEL ?? "gpt-4o";
const answerAsk = (prompt: string) => (process.env.LME_ANSWER === "openai" ? askOpenAI(prompt, ANSWER_MODEL) : ask(prompt));

interface Trace { hits: { id: string; rank: number; cut: number; neighbors?: string[] }[]; excerpts: string }

async function runOne(oracle: OracleAdapter, q: Q): Promise<{ id: string; type: string; hypothesis: string; ingested: number; trace: Trace; probe?: Record<number, boolean>; probeSession?: Record<number, boolean>; probeDoc?: Record<number, boolean>; chunkHit?: boolean | null; sessHit?: boolean | null; evidAll?: boolean | null; evidAllDeep?: boolean | null; goldStrFull?: boolean; goldStrShown?: boolean }> {
  const project = `lme_${q.question_id}`;
  let ingested = 0;
  // GROUND TRUTH (P0, verify-in-reality): the sessions that actually hold the evidence + a doc→session map,
  // so the probe can ask "did retrieval return a doc from the gold session?" — immune to paraphrase, unlike
  // the gold-STRING proxy which reads 0% on preference simply because the answer is worded differently.
  const goldSessions = new Set<string>(q.answer_session_ids ?? []);
  const docSession = new Map<string, string>();
  // GROUND-TRUTH chunk recall: LongMemEval_S flags the evidence turns (`has_answer`). Track which ingested
  // docs came from an evidence turn, so the probe can ask "did the ANSWER-BEARING chunk reach top-k?" —
  // immune to paraphrase, unlike the gold-STRING proxy. This is the honest Lever-1 (chunk granularity) ruler.
  const goldDocs = new Set<string>();
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const validAt = toIso(q.haystack_dates?.[i] ?? "");
    const sessionId = q.haystack_session_ids?.[i] ?? String(i);
    for (const turn of q.haystack_sessions[i]) {
      const text = String(turn.content ?? "").trim();
      if (text.length < 20) continue; // trivial acks carry no memory
      const opts = {
        project,
        source: turn.role === "user" ? "human:prompt" : "session:assistant",
        pinned: false, // benchmark corpora must age like everything else
        validAt,
      };
      // Contextual anchor: a mid-list chunk ("7. Transcriptionist…") loses the topic words that make it
      // findable ("work-from-home jobs") — prefix continuation chunks with the turn's opening as a header.
      const chunks = chunkTurn(text);
      const anchor = chunks.length > 1 ? text.slice(0, 80).replace(/\s+\S*$/, "") : "";
      for (let ci = 0; ci < chunks.length; ci++) {
        const body = ci === 0 ? chunks[ci] : `[re: ${anchor}…] ${chunks[ci]}`;
        let learnedId = "";
        try {
          learnedId = (await oracle.learn(`${turn.role}: ${body}`, opts)).id;
        } catch {
          // one retry — a 100k-turn run must not die on a single hiccup; a persistent failure still throws
          await new Promise((r) => setTimeout(r, 300));
          learnedId = (await oracle.learn(`${turn.role}: ${body}`, opts)).id;
        }
        if (learnedId) {
          docSession.set(String(learnedId), sessionId);
          if (turn.has_answer === true) goldDocs.add(String(learnedId)); // this chunk came from an evidence turn
        }
        ingested++;
      }
    }
  }
  // Read-after-write for vectors (R2a): learn now enqueues embeddings on a background worker, so a semantic
  // run must drain the queue before searching or it queries a half-written vector table. FTS is synchronous
  // (no settle needed); skip entirely when vectors are off. Assert the worker didn't silently drop a batch.
  if (process.env.AURALIS_SEMANTIC === "1") {
    const s = await oracle.settleVectors();
    if (s.failed > 0) console.error(`  ⚠ embed queue dropped ${s.failed} vectors for ${q.question_id} — semantic recall is degraded`);
  }
  // Retrieval-recall probe (LLM-free): main-query top-k at each k, does the gold string appear? Skips answer/judge.
  if (PROBE) {
    const goldAt: Record<number, boolean> = {};       // gold STRING in top-k content (proxy)
    const goldSessAt: Record<number, boolean> = {};   // gold SESSION in top-k (ground truth)
    const goldDocAt: Record<number, boolean> = {};    // evidence CHUNK in top-k (ground truth, has_answer)
    for (const K of PROBE) {
      const hh = await oracle.search(q.question, { project, limit: K });
      goldAt[K] = goldPrecheck(q.answer, hh.map((h) => h.content).join("\n"));
      // ALL gold sessions must appear in top-k (the correct recall bar — a multi-session answer needs every
      // evidence session, not just one). "some" over-counts. The doc→session map is proven working by the
      // per-type spread (preference 67% ≠ temporal 100% — a broken map would give uniform 0%).
      const hitSessions = new Set(hh.map((h) => docSession.get(String(h.id))).filter(Boolean));
      goldSessAt[K] = goldSessions.size > 0 && [...goldSessions].every((gs) => hitSessions.has(gs));
      // Chunk-level: did ANY evidence-turn chunk reach top-k? (some = the answer is in hand for the reader).
      goldDocAt[K] = goldDocs.size > 0 && hh.some((h) => goldDocs.has(String(h.id)));
    }
    return { id: q.question_id, type: q.question_type, hypothesis: "", ingested, trace: { hits: [], excerpts: "" }, probe: goldAt, probeSession: goldSessAt, probeDoc: goldDocAt };
  }
  // Multi-query retrieval: a "days between A and B" question names TWO events — one query's top-k tends
  // to cover only the dominant one (sanity-gate finding). Union the main search with a per-entity search
  // so every named event gets its own shot. Deterministic, no LLM.
  // Leak #1 fix (correct-column session): the main query used to get only limit:8 with entity hits filling
  // to 12 — main-query ranks 9–12 were EVICTED, collapsing chunk-in-hand to 69% vs the probe's 82%. Now the
  // main query keeps its full top-12 (matching the probe) and entity hits SUPPLEMENT after it (same 4-slot
  // budget, cap 16) — union may only ever add evidence, never displace it.
  const seen = new Map<string, (typeof hits0)[number]>();
  // M2 adjacency expansion: top hits carry their insertion-order neighbours — the answer to
  // "what came after X" sits in the chunk NEXT to the one that matches the question's words.
  const hits0 = await oracle.search(q.question, { project, limit: 48, expand: EXPAND });
  for (const h of hits0.slice(0, 12)) seen.set(h.id, h);
  for (const ent of extractEntities(q.question).slice(0, 3)) {
    for (const h of await oracle.search(ent, { project, limit: 4 })) if (!seen.has(h.id)) seen.set(h.id, h);
  }
  // Leak-#2a fix — multi-evidence COVERAGE: chunk∃ was 83% but evidALL only 56% (multi-session 35%,
  // temporal 39%) — the other anchors sat at rank 13–48. Two selection tricks failed (one-per-unseen-session
  // 57%, per-session≤2 59% — a 24-slot budget never reaches rank 35+). Full-context scores 60–64 with the
  // ENTIRE haystack, so the reader tolerates breadth; slot-parsimony was self-inflicted. Take the whole
  // top-48 (still ≥10× compression of the corpus) — evidALL rises to its pool ceiling (71%) by construction.
  // ponytail: remaining coverage loss is a QUERY gap (evidence outside top-48) → R4 query expansion.
  for (const h of hits0.slice(12)) if (!seen.has(h.id)) seen.set(h.id, h);
  const hits = [...seen.values()].slice(0, 48);
  if (!hits.length) return { id: q.question_id, type: q.question_type, hypothesis: "I don't know.", ingested, trace: { hits: [], excerpts: "" } };
  // Rank-aware excerpts: the top hits carry the evidence — give them room (chunked memories fit whole);
  // the tail is context, a teaser is enough. Neighbour chunks (M2) render indented under their hit,
  // deduped against anything already retrieved in its own right.
  const shown = new Set(hits.map((h) => String(h.id)));
  const excerpts = hits
    .map((h, i) => {
      // Truncation fix (leak-#2b): memory chunks are ≤600 chars (chunkTurn) — a 400 cut chopped the answer
      // out of 11/470 questions the retrieval had already won. 700 shows any single chunk whole.
      let line = `- [said ${String(h.validAt ?? "").slice(0, 10) || "unknown date"}] ${h.content.slice(0, i < 4 ? 1400 : 700)}`;
      for (const n of h.neighbors ?? []) {
        if (shown.has(n.id)) continue;
        shown.add(n.id);
        line += `\n  ↳ [${n.position === "prev" ? "said just before" : "said right after"}] ${n.content.slice(0, 700)}`;
      }
      return line;
    })
    .join("\n");
  // M1 observability: record exactly what retrieval returned and what the answer stage saw — the
  // validation round had to rebuild 12 brains to learn this; the trace makes every run inspectable.
  const trace: Trace = { hits: hits.map((h, i) => ({ id: String(h.id), rank: i + 1, cut: i < 4 ? 1400 : 400, neighbors: (h.neighbors ?? []).map((n) => n.id) })), excerpts };
  // LME_DUMP: retrieval only — emit excerpts+gold+chunkHit to the trace, skip the answer LLM. Lets an
  // external reader (here: Claude Code itself, when the SDK credit is out) do answer+judge off the dump.
  const hypothesis = process.env.LME_DUMP ? "" : await answerAsk(
    `Today is ${q.question_date}. Below are excerpts from the user's past chat sessions, each marked with when it was said.\n\n` +
      `${excerpts}\n\nQuestion: ${q.question}\n\n` +
      `Answer concisely, grounded in the excerpts:\n` +
      `- A suggestion/recommendation question: recommend something that builds on the user's stated gear, plans, or preferences in the excerpts.\n` +
      `- A yes/no question where the excerpts cover the topic but never mention the asked detail: answer no.\n` +
      `- A date or duration question: compute carefully from the [said ...] dates.\n` +
      `- A counting/how-many/total question: the mentions are usually SPREAD ACROSS many excerpts and dates — enumerate every matching mention first, then count/sum them.\n` +
      `- Only if the excerpts contain nothing relevant to the question, reply exactly: I don't know.`,
  );
  // Lever-1 vs Lever-2 attribution: did an evidence-turn chunk actually reach the reader's top-k? (ground
  // truth via has_answer, immune to paraphrase). Cross-tabbed with the judge's verdict at the summary:
  // chunk-in-hand & wrong ⇒ the reader lost with the answer present (Lever 2); miss & wrong ⇒ the chunk
  // never surfaced (Lever 1). sessHit is the coarser session-level companion.
  const chunkHit = goldDocs.size > 0 ? hits.some((h) => goldDocs.has(String(h.id))) : null;
  const hitSess = new Set(hits.map((h) => docSession.get(String(h.id))).filter(Boolean));
  const sessHit = goldSessions.size > 0 ? [...goldSessions].every((gs) => hitSess.has(gs)) : null;
  // Leak-#2 mechanism split (measure BEFORE fixing the reader — "reader failed" hides three different leaks):
  // evidAll: EVERY gold session has an evidence chunk in hand — `some` over-counts multi-evidence questions
  //   (one anchor retrieved, the other missing = a COVERAGE loss, no reader prompt can fix it).
  // goldStrFull vs goldStrShown: answer string in the retrieved chunks' FULL content but not in the rendered
  //   excerpts = a TRUNCATION loss (rank 5+ hits are cut to 400 chars; chunks are ≤600).
  const evidAll = goldDocs.size > 0 && goldSessions.size > 0
    ? [...goldSessions].every((gs) => hits.some((h) => goldDocs.has(String(h.id)) && docSession.get(String(h.id)) === gs))
    : null;
  // Ceiling check: is the missing evidence even IN the deep candidate pool (top-48)? If not, no selection
  // strategy can fix coverage — the query itself must change (multi-query / expansion, R4).
  const evidAllDeep = goldDocs.size > 0 && goldSessions.size > 0
    ? [...goldSessions].every((gs) => hits0.some((h) => goldDocs.has(String(h.id)) && docSession.get(String(h.id)) === gs))
    : null;
  const fullText = hits.map((h) => [h.content, ...(h.neighbors ?? []).map((n) => n.content)].join("\n")).join("\n");
  const goldStrFull = goldPrecheck(q.answer, fullText);
  const goldStrShown = goldPrecheck(q.answer, excerpts);
  return { id: q.question_id, type: q.question_type, hypothesis: hypothesis || "I don't know.", ingested, trace, chunkHit, sessHit, evidAll, evidAllDeep, goldStrFull, goldStrShown };
}

// M1 "fix the ruler": deterministic pre-check kills the measured judge false-negatives (~4% —
// gold "Premier Silver" verbatim in the response, judged wrong). Gold present verbatim → correct,
// no LLM verdict. Ceiling: a response that QUOTES the gold while denying it would pass wrongly —
// accepted; the LLM judge still handles everything the pre-check can't claim.
export function goldPrecheck(answer: unknown, hypothesis: string): boolean {
  if (answer == null || typeof answer === "object") return false;
  const clean = (s: string) => s.toLowerCase().replace(/[*_"'`’“”]/g, "").replace(/\s+/g, " ").trim();
  const gold = clean(String(answer)).replace(/[.?!]+$/, "");
  const resp = clean(hypothesis);
  if (!gold || !resp) return false;
  // Bare numbers need word boundaries ("4" must not match "42"); everything else needs length ≥4
  // so trivial golds ("no") can't false-positive their way past the real judge.
  if (/^\d+(\.\d+)?$/.test(gold)) return new RegExp(`\\b${gold.replace(".", "\\.")}\\b`).test(resp);
  if (gold.length < 4) return false;
  return resp.includes(gold);
}

async function judgeOne(q: Q, hypothesis: string): Promise<{ ok: boolean; reason: string }> {
  const abstention = q.question_id.includes("_abs");
  if (!abstention && goldPrecheck(q.answer, hypothesis)) return { ok: true, reason: "gold-precheck: gold string present verbatim" };
  // Sanity-gate finding: the judge failed "Two: Dr. Smith…" against gold `2` and penalised correct
  // abstentions — be explicit that equivalence (number words, extra explanation) counts as correct.
  const verdict = await judgeAsk(
    abstention
      ? `This question has NO answer in the source material; the correct behaviour is to decline.\n` +
          `Question: ${q.question}\nResponse: ${hypothesis}\n` +
          `Any response expressing lack of information (e.g. "I don't know", "not enough information") is CORRECT.\n` +
          `Did the response correctly decline (yes/no)? Answer yes or no, then one short reason on the same line.`
      : `Question: ${q.question}\nGold answer: ${JSON.stringify(q.answer)}\nResponse: ${hypothesis}\n` +
          `Judge SEMANTIC equivalence: number words equal digits ("Two" = 2), extra correct detail or ` +
          `explanation does NOT make it wrong, paraphrases count. Wrong facts or missing the gold's core answer = no.\n` +
          `Is the response correct (yes/no)? Answer yes or no, then one short reason on the same line.`,
  );
  return { ok: /^\s*\W*yes/i.test(verdict), reason: verdict.slice(0, 300) };
}

async function main() {
  mkdirSync(SCRATCH, { recursive: true });
  const all: Q[] = JSON.parse(readFileSync(DATA, "utf8"));
  const subset = process.env.LME_SUBSET ? new Set(JSON.parse(readFileSync(process.env.LME_SUBSET, "utf8"))) : null;
  let qs = subset ? all.filter((q) => subset.has(q.question_id)) : all;
  if (LIMIT > 0) qs = qs.slice(0, LIMIT);

  // Isolated scratch brain — never the real one. Semantic arm (P3): spawn the embed sidecar first.
  const kids: ChildProcess[] = [];
  const env: Record<string, string | undefined> = { ...process.env, ORACLE_PORT: String(PORT), ORACLE_DB: `${SCRATCH}/brain.sqlite`, ORACLE_RESET: "1", ORACLE_API_URL: BASE };
  if (process.env.AURALIS_SEMANTIC === "1") {
    const embedPort = 47798;
    kids.push(spawn("pnpm", ["exec", "tsx", "src/embed-sidecar.ts"], { env: { ...process.env, EMBED_PORT: String(embedPort) }, stdio: "ignore" }));
    for (let i = 0; i < 180; i++) {
      try { if ((await fetch(`http://localhost:${embedPort}/health`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    env.ORACLE_EMBED_URL = `http://localhost:${embedPort}`;
  }
  rmSync(`${SCRATCH}/brain.sqlite`, { force: true });
  kids.push(spawn("bun", ["run", "oracle-lite/server.ts"], { env: env as any, stdio: "ignore" }));
  const stop = () => kids.forEach((k) => { try { k.kill(); } catch { /* noop */ } });
  try {
    for (let i = 0; i < 60 && !(await oracleReachable(BASE)); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await oracleReachable(BASE))) throw new Error("lme oracle did not start");
    process.env.ORACLE_API_URL = BASE; // adapters in THIS process point at the scratch brain
    const oracle = new OracleAdapter(BASE);

    writeFileSync(OUT, "");
    const TRACE = OUT.replace(/\.jsonl$/, "") + ".trace.jsonl";
    writeFileSync(TRACE, "");
    const results: { id: string; type: string; ok?: boolean; chunkHit?: boolean | null; sessHit?: boolean | null }[] = [];
    const probes: { id: string; type: string; probe?: Record<number, boolean>; probeSession?: Record<number, boolean>; probeDoc?: Record<number, boolean> }[] = [];
    let done = 0;
    const t0 = Date.now();
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONC, qs.length) }, async () => {
        for (let i = next++; i < qs.length; i = next++) {
          const q = qs[i];
          const r = await runOne(oracle, q);
          const j = (!PROBE && JUDGE !== "none") ? await judgeOne(q, r.hypothesis) : undefined;
          appendFileSync(OUT, JSON.stringify({ question_id: r.id, hypothesis: r.hypothesis }) + "\n");
          appendFileSync(TRACE, JSON.stringify({ question_id: r.id, type: r.type, question: q.question, question_date: q.question_date, gold: q.answer, chunkHit: r.chunkHit, sessHit: r.sessHit, evidAll: r.evidAll, evidAllDeep: r.evidAllDeep, goldStrFull: r.goldStrFull, goldStrShown: r.goldStrShown, ...r.trace, hypothesis: r.hypothesis, ok: j?.ok, judge_reason: j?.reason, ingested: r.ingested }) + "\n");
          results.push({ id: r.id, type: r.type, ok: j?.ok, chunkHit: r.chunkHit, sessHit: r.sessHit });
          if (PROBE) probes.push({ id: r.id, type: r.type, probe: r.probe, probeSession: r.probeSession, probeDoc: r.probeDoc });
          done++;
          console.log(`  [${done}/${qs.length}] ${r.id} · ${r.type}${PROBE ? " · gold@k " + JSON.stringify(r.probe) : ` · ingested=${r.ingested}${j === undefined ? "" : j.ok ? " · ✅" : " · ❌"}`}`);
        }
      }),
    );

    // R0-2 semantic guard: a "semantic" run silently ran on trigram when the sidecar hiccupped. Read the
    // oracle's real embed stats and SCREAM if most embeddings fell back to builtin — never trust the flag.
    if (process.env.AURALIS_SEMANTIC === "1") {
      try {
        const st: any = await (await fetch(`${BASE}/api/stats`)).json();
        const ok = st.semantic_embeds ?? 0, fb = st.embed_fallbacks ?? 0, ratio = ok / Math.max(1, ok + fb);
        console.log(`  [semantic] embedder=${st.embedder} real=${ok} fallback=${fb} → ${(ratio * 100).toFixed(0)}% actually semantic`);
        if (ratio < 0.5) console.error(`  ⚠⚠ SEMANTIC DEGRADED — only ${(ratio * 100).toFixed(0)}% real embeddings; this run is mostly builtin trigram. Fix the sidecar before trusting any "semantic" number.`);
      } catch { console.error("  ⚠ could not read /api/stats to verify semantic engagement"); }
    }
    if (PROBE) {
      const report = (label: string, field: "probe" | "probeSession" | "probeDoc") => {
        const byType = new Map<string, Record<number, [number, number]>>();
        for (const p of probes) {
          const data = (p as any)[field] as Record<number, boolean> | undefined;
          if (p.id.includes("_abs") || !data) continue;
          const m = byType.get(p.type) ?? {};
          for (const K of PROBE) { const c = m[K] ?? [0, 0]; if (data[K]) c[0]++; c[1]++; m[K] = c; }
          byType.set(p.type, m);
        }
        const tot: Record<number, [number, number]> = {};
        console.log(`\n━━━ ${label} · ${process.env.AURALIS_SEMANTIC === "1" ? "semantic" : "trigram"} ━━━`);
        console.log(`  ${"type".padEnd(28)}${PROBE.map((k) => ("k=" + k).padStart(7)).join("")}`);
        for (const [t, m] of [...byType.entries()].sort()) {
          console.log(`  ${t.padEnd(28)}${PROBE.map((k) => { const [g, n] = m[k] ?? [0, 0]; if (n) { tot[k] = tot[k] ?? [0, 0]; tot[k][0] += g; tot[k][1] += n; } return (n ? Math.round(g / n * 100) + "%" : "-").padStart(7); }).join("")}`);
        }
        console.log(`  ${"OVERALL".padEnd(28)}${PROBE.map((k) => { const [g, n] = tot[k] ?? [0, 0]; return (n ? Math.round(g / n * 100) + "%" : "-").padStart(7); }).join("")}`);
      };
      // GROUND TRUTH first (did retrieval hit the evidence session — immune to paraphrase), then the string proxy.
      report("gold-SESSION in top-k % — GROUND TRUTH (answer_session_ids)", "probeSession");
      report("evidence-CHUNK in top-k % — GROUND TRUTH (has_answer) — the honest Lever-1 ruler", "probeDoc");
      report("gold-STRING in top-k % — proxy (undercounts paraphrase)", "probe");
      // Decomposition (the 28-pt gap): AMONG questions where the evidence SESSION was retrieved, how often is
      // the answer STRING also in top-k? Low ⇒ chunk-granularity (right session, wrong chunk, Lever 1);
      // high-but-still-wrong ⇒ extraction (Lever 2, needs the correct-column to confirm). String-paraphrase
      // still inflates the "missing" side, so read this as an upper bound on the chunk-granularity slice.
      {
        console.log(`\n━━━ answer-chunk surfaced GIVEN session hit (str∧sess / sess) · ${process.env.AURALIS_SEMANTIC === "1" ? "semantic" : "trigram"} ━━━`);
        console.log(`  ${"type".padEnd(28)}${PROBE.map((k) => ("k=" + k).padStart(7)).join("")}`);
        const byType = new Map<string, Record<number, [number, number]>>();
        for (const p of probes) {
          const sess = (p as any).probeSession as Record<number, boolean> | undefined;
          const str = (p as any).probe as Record<number, boolean> | undefined;
          if (p.id.includes("_abs") || !sess || !str) continue;
          const m = byType.get(p.type) ?? {};
          for (const K of PROBE) { const c = m[K] ?? [0, 0]; if (sess[K]) { c[1]++; if (str[K]) c[0]++; } m[K] = c; }
          byType.set(p.type, m);
        }
        const tot: Record<number, [number, number]> = {};
        for (const [t, m] of [...byType.entries()].sort()) {
          console.log(`  ${t.padEnd(28)}${PROBE.map((k) => { const [g, n] = m[k] ?? [0, 0]; if (n) { tot[k] = tot[k] ?? [0, 0]; tot[k][0] += g; tot[k][1] += n; } return (n ? Math.round(g / n * 100) + "%" : "-").padStart(7); }).join("")}`);
        }
        console.log(`  ${"OVERALL".padEnd(28)}${PROBE.map((k) => { const [g, n] = tot[k] ?? [0, 0]; return (n ? Math.round(g / n * 100) + "%" : "-").padStart(7); }).join("")}`);
      }
      console.log(`  wall ${(Date.now() - t0) / 1000 | 0}s`);
      return;
    }
    console.log(`\n━━━ LongMemEval (${process.env.AURALIS_SEMANTIC === "1" ? "semantic" : "trigram"} · judge=${JUDGE} · INTERNAL numbers) ━━━`);
    if (JUDGE !== "none") {
      const byType = new Map<string, { n: number; ok: number }>();
      for (const r of results) {
        const t = byType.get(r.type) ?? { n: 0, ok: 0 };
        t.n++; if (r.ok) t.ok++;
        byType.set(r.type, t);
      }
      let N = 0, OK = 0;
      for (const [t, v] of [...byType.entries()].sort()) {
        console.log(`  ${t.padEnd(28)} ${v.ok}/${v.n}  (${((v.ok / v.n) * 100).toFixed(0)}%)`);
        N += v.n; OK += v.ok;
      }
      console.log(`  ${"TOTAL".padEnd(28)} ${OK}/${N}  (${((OK / N) * 100).toFixed(0)}%)`);
      console.log(`  (judge=${JUDGE}${JUDGE === "openai" ? " " + JUDGE_MODEL : ""} → iteration numbers; official comparability needs evaluate_qa.py + GPT-4o)`);
      // Lever attribution (the correct-column): among WRONG answers, was the evidence chunk in the reader's
      // hand? chunk&✗ = reader lost with the answer present (Lever 2 / extraction); miss&✗ = chunk never
      // surfaced (Lever 1 / retrieval). Ground truth (has_answer), so paraphrase does not distort it.
      const conf = new Map<string, { cOk: number; cNo: number; mOk: number; mNo: number }>();
      for (const r of results) {
        if (r.chunkHit == null) continue;
        const c = conf.get(r.type) ?? { cOk: 0, cNo: 0, mOk: 0, mNo: 0 };
        if (r.chunkHit) { r.ok ? c.cOk++ : c.cNo++; } else { r.ok ? c.mOk++ : c.mNo++; }
        conf.set(r.type, c);
      }
      if (conf.size) {
        console.log(`\n  ━━━ Lever attribution — evidence-chunk in reader top-k × judged correct (ground truth) ━━━`);
        console.log(`  ${"type".padEnd(28)}${"chunk&✓".padStart(9)}${"chunk&✗".padStart(9)}${"miss&✓".padStart(9)}${"miss&✗".padStart(9)}`);
        const T = { cOk: 0, cNo: 0, mOk: 0, mNo: 0 };
        for (const [t, c] of [...conf.entries()].sort()) {
          console.log(`  ${t.padEnd(28)}${String(c.cOk).padStart(9)}${String(c.cNo).padStart(9)}${String(c.mOk).padStart(9)}${String(c.mNo).padStart(9)}`);
          T.cOk += c.cOk; T.cNo += c.cNo; T.mOk += c.mOk; T.mNo += c.mNo;
        }
        console.log(`  ${"TOTAL".padEnd(28)}${String(T.cOk).padStart(9)}${String(T.cNo).padStart(9)}${String(T.mOk).padStart(9)}${String(T.mNo).padStart(9)}`);
        const wrong = T.cNo + T.mNo;
        if (wrong) console.log(`  → of ${wrong} wrong: ${T.cNo} had the chunk in hand (Lever 2 / reader, ${Math.round(T.cNo / wrong * 100)}%) · ${T.mNo} chunk missed (Lever 1 / retrieval, ${Math.round(T.mNo / wrong * 100)}%)`);
      }
      // Failure-class report: questions tagged by a past failure analysis (bench/lme/failure-tags.json)
      // — each milestone must prove it moved ITS class and regressed nothing else.
      let tags: Record<string, string> = {};
      try { tags = JSON.parse(readFileSync(new URL("../bench/lme/failure-tags.json", import.meta.url), "utf8")); } catch { /* no tags — skip */ }
      const byClass = new Map<string, { n: number; ok: number }>();
      for (const r of results) {
        const c = tags[r.id];
        if (!c) continue;
        const t = byClass.get(c) ?? { n: 0, ok: 0 };
        t.n++; if (r.ok) t.ok++;
        byClass.set(c, t);
      }
      if (byClass.size) {
        console.log(`\n  previously-analyzed misses by failure class (pass/total this run):`);
        for (const [c, v] of [...byClass.entries()].sort()) console.log(`  ${c.padEnd(20)} ${v.ok}/${v.n}`);
      }
    }
    console.log(`  wall ${(Date.now() - t0) / 1000 | 0}s · hypotheses → ${OUT}`);
  } finally {
    stop();
  }
}

// Run only when executed as the entrypoint — chunkTurn is imported by tests.
if (process.argv[1]?.includes("run-longmemeval")) main().catch((e) => { console.error(e); process.exit(1); });
