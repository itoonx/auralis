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
  haystack_sessions: { role: string; content: string }[][];
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

async function runOne(oracle: OracleAdapter, q: Q): Promise<{ id: string; type: string; hypothesis: string; ingested: number; trace: Trace; probe?: Record<number, boolean> }> {
  const project = `lme_${q.question_id}`;
  let ingested = 0;
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const validAt = toIso(q.haystack_dates?.[i] ?? "");
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
        try {
          await oracle.learn(`${turn.role}: ${body}`, opts);
        } catch {
          // one retry — a 100k-turn run must not die on a single hiccup; a persistent failure still throws
          await new Promise((r) => setTimeout(r, 300));
          await oracle.learn(`${turn.role}: ${body}`, opts);
        }
        ingested++;
      }
    }
  }
  // Retrieval-recall probe (LLM-free): main-query top-k at each k, does the gold string appear? Skips answer/judge.
  if (PROBE) {
    const goldAt: Record<number, boolean> = {};
    for (const K of PROBE) {
      const hh = await oracle.search(q.question, { project, limit: K });
      goldAt[K] = goldPrecheck(q.answer, hh.map((h) => h.content).join("\n"));
    }
    return { id: q.question_id, type: q.question_type, hypothesis: "", ingested, trace: { hits: [], excerpts: "" }, probe: goldAt };
  }
  // Multi-query retrieval: a "days between A and B" question names TWO events — one query's top-k tends
  // to cover only the dominant one (sanity-gate finding). Union the main search with a per-entity search
  // so every named event gets its own shot. Deterministic, no LLM.
  const seen = new Map<string, (typeof hits0)[number]>();
  // M2 adjacency expansion: top hits carry their insertion-order neighbours — the answer to
  // "what came after X" sits in the chunk NEXT to the one that matches the question's words.
  const hits0 = await oracle.search(q.question, { project, limit: 8, expand: EXPAND });
  for (const h of hits0) seen.set(h.id, h);
  for (const ent of extractEntities(q.question).slice(0, 3)) {
    for (const h of await oracle.search(ent, { project, limit: 4 })) if (!seen.has(h.id)) seen.set(h.id, h);
  }
  const hits = [...seen.values()].slice(0, 12);
  if (!hits.length) return { id: q.question_id, type: q.question_type, hypothesis: "I don't know.", ingested, trace: { hits: [], excerpts: "" } };
  // Rank-aware excerpts: the top hits carry the evidence — give them room (chunked memories fit whole);
  // the tail is context, a teaser is enough. Neighbour chunks (M2) render indented under their hit,
  // deduped against anything already retrieved in its own right.
  const shown = new Set(hits.map((h) => String(h.id)));
  const excerpts = hits
    .map((h, i) => {
      let line = `- [said ${String(h.validAt ?? "").slice(0, 10) || "unknown date"}] ${h.content.slice(0, i < 4 ? 1400 : 400)}`;
      for (const n of h.neighbors ?? []) {
        if (shown.has(n.id)) continue;
        shown.add(n.id);
        line += `\n  ↳ [${n.position === "prev" ? "said just before" : "said right after"}] ${n.content.slice(0, 400)}`;
      }
      return line;
    })
    .join("\n");
  // M1 observability: record exactly what retrieval returned and what the answer stage saw — the
  // validation round had to rebuild 12 brains to learn this; the trace makes every run inspectable.
  const trace: Trace = { hits: hits.map((h, i) => ({ id: String(h.id), rank: i + 1, cut: i < 4 ? 1400 : 400, neighbors: (h.neighbors ?? []).map((n) => n.id) })), excerpts };
  const hypothesis = await answerAsk(
    `Today is ${q.question_date}. Below are excerpts from the user's past chat sessions, each marked with when it was said.\n\n` +
      `${excerpts}\n\nQuestion: ${q.question}\n\n` +
      `Answer concisely, grounded in the excerpts:\n` +
      `- A suggestion/recommendation question: recommend something that builds on the user's stated gear, plans, or preferences in the excerpts.\n` +
      `- A yes/no question where the excerpts cover the topic but never mention the asked detail: answer no.\n` +
      `- A date or duration question: compute carefully from the [said ...] dates.\n` +
      `- Only if the excerpts contain nothing relevant to the question, reply exactly: I don't know.`,
  );
  return { id: q.question_id, type: q.question_type, hypothesis: hypothesis || "I don't know.", ingested, trace };
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
    const results: { id: string; type: string; ok?: boolean }[] = [];
    const probes: { id: string; type: string; probe?: Record<number, boolean> }[] = [];
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
          appendFileSync(TRACE, JSON.stringify({ question_id: r.id, type: r.type, question: q.question, gold: q.answer, ...r.trace, hypothesis: r.hypothesis, ok: j?.ok, judge_reason: j?.reason, ingested: r.ingested }) + "\n");
          results.push({ id: r.id, type: r.type, ok: j?.ok });
          if (PROBE) probes.push({ id: r.id, type: r.type, probe: r.probe });
          done++;
          console.log(`  [${done}/${qs.length}] ${r.id} · ${r.type}${PROBE ? " · gold@k " + JSON.stringify(r.probe) : ` · ingested=${r.ingested}${j === undefined ? "" : j.ok ? " · ✅" : " · ❌"}`}`);
        }
      }),
    );

    if (PROBE) {
      // gold-in-top-k % per type (non-abstention). Rising with k = ranking-miss (fixable); flat/low = recall-miss (needs semantic).
      const byType = new Map<string, Record<number, [number, number]>>();
      for (const p of probes) {
        if (p.id.includes("_abs") || !p.probe) continue;
        const m = byType.get(p.type) ?? {};
        for (const K of PROBE) { const c = m[K] ?? [0, 0]; if (p.probe[K]) c[0]++; c[1]++; m[K] = c; }
        byType.set(p.type, m);
      }
      const tot: Record<number, [number, number]> = {};
      console.log(`\n━━━ retrieval-recall probe · gold-in-top-k % (non-abstention, ${process.env.AURALIS_SEMANTIC === "1" ? "semantic" : "trigram"}) ━━━`);
      console.log(`  ${"type".padEnd(28)}${PROBE.map((k) => ("k=" + k).padStart(7)).join("")}`);
      for (const [t, m] of [...byType.entries()].sort()) {
        console.log(`  ${t.padEnd(28)}${PROBE.map((k) => { const [g, n] = m[k] ?? [0, 0]; if (n) { tot[k] = tot[k] ?? [0, 0]; tot[k][0] += g; tot[k][1] += n; } return (n ? Math.round(g / n * 100) + "%" : "-").padStart(7); }).join("")}`);
      }
      console.log(`  ${"OVERALL".padEnd(28)}${PROBE.map((k) => { const [g, n] = tot[k] ?? [0, 0]; return (n ? Math.round(g / n * 100) + "%" : "-").padStart(7); }).join("")}`);
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
