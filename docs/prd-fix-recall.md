# PRD — Fix Recall: the loss is chunk-granularity + answer-extraction, NOT session recall

Date: 2026-07-10 · Status: **diagnosis CORRECTED — re-deriving levers**
Basis: the P4 official run + the retrieval-recall probe with a GROUND-TRUTH gold-session metric (P0).
Supersedes the recall threads in `prd-next-phase.md`.

## ⚠️ CORRECTION (2026-07-10) — the first diagnosis was built on a broken instrument

The original claim below ("84% retrieval-miss, retrieval recall is the bottleneck") was measured with a
**gold-STRING-in-excerpts** proxy. P0 replaced it with **ground truth** (does retrieval return a doc from the
evidence session, using `answer_session_ids`) and the picture inverts:

| metric (pooled-100, trigram) | k=12 | k=50 |
|---|---|---|
| gold-SESSION recall (ALL evidence sessions) — GROUND TRUTH | **81%** | **93%** |
| gold-STRING in excerpts — the old proxy | 39% | 43% |

**Retrieval finds the evidence session ~always (81–93%). Retrieval recall is NOT the primary bottleneck.**
The string proxy read 0% on preference only because the answers are paraphrased. Per-type spread (preference
67%, temporal 63%→94%, user 100%) proves the doc→session map works.

## The real problem, in corrected facts

- **Official LongMemEval_S** (GPT-4o answer + official judge): **53.4%**. But session-recall is **81%** at k=12
  — so the ~28-pt gap between "evidence session retrieved" and "answered correctly" is the target, and it is
  NOT session retrieval.
- **Lever 1 — within-session chunk granularity.** The right SESSION reaches top-k (81%) but the answer-bearing
  CHUNK often doesn't (string 39%). Once a session is a hit, surface its answer chunk (adjacency/expand — the
  old M2, now actually justified — or within-session re-rank).
- **Lever 2 — answer-stage paraphrase extraction.** preference: session 67–83% retrieved but only 33% correct
  and 0% verbatim — the evidence is there, worded differently; the reader must extract it. A reader/excerpt
  problem, not retrieval.
- **Lever 3 — k-coverage for multi-evidence.** multi-session/temporal need k>12 to cover ALL their evidence
  sessions (multi-session 75%→94%, temporal 63%→94% from k=12→50). Coverage-aware / higher k for these.
- **Bug (fix regardless) — LanceDB write amplification.** Single-row `vectorAdd` is ~680× bloat (12 questions
  → 8.2GB; 112GB across runs) and was crashing every run tonight, masked as "learn timeout" (ENOSPC). Batch
  adds + compact + make `ORACLE_RESET` drop the lancedb dir.
- **De-prioritized:** the "stronger embedder for session recall" bet — session recall is already 81–93%, so a
  better embedder is not the headline. It may still help CHUNK-level ranking (a smaller, separate question).

## SESSION-2 UPDATE (2026-07-10 cont.) — ground-truth CHUNK probe + correct-column pin the levers

The dataset carries a turn-level `has_answer` flag → built a GROUND-TRUTH chunk-recall probe (evidence-turn
chunk in top-k, paraphrase-immune) and a chunk-in-hand × correct confusion (`LME_DUMP` retrieval dump +
Claude-Code reader/judge; Agent-SDK credit was out). Both wired into `run-longmemeval.ts` (uncommitted).

| ruler | number | reading |
|---|---|---|
| session recall (ground truth) | 77%@12 / 92%@50 | finding the evidence session is ~solved |
| **CHUNK recall (ground truth, main-query probe)** | **82%@12 / 90%@50** | the answer chunk is usually retrievable |
| chunk-in-hand in the ANSWER PATH | **69%** | the answer path under-serves vs the probe (−13 pts) |
| correct (Claude self-answer+judge, 90-Q subset) | 61% | optimistic vs official gpt-4o 53% (self-judge is generous) |

**Lever attribution — of the WRONG answers: Lever 1 (chunk never retrieved) 54% · Lever 2 (chunk in hand,
reader failed) 46%.** It is NOT a single lever. The string-proxy diagnosis AND the "reader is the sole
bottleneck" read (from probe 82%) were both too fast — correct-column split it ~half/half.

Per-type (subset, 15/type): multi-session 2/15 (worst — reader can't aggregate across sessions), temporal
8/15 (reader can't anchor/compute dates though the chunk is present), preference miss-heavy (retrieval drops
the chunk), user + knowledge-update 14/15.

**Two real levers going forward:**
- **L1 retrieval: ✅ FIXED + VERIFIED.** The answer path did `search(limit:8)` with entity-union filling to 12
  — main-query ranks 9–12 were evicted. Fix: main query keeps its full top-12, entity hits supplement after
  (same 4-slot budget, cap 16). Verified: subset90 69%→73% = that subset's probe ceiling exactly (every type
  matches the probe row); full-500 answer-path chunk-in-hand = **83% ≥ probe 82%**. (Note: the earlier
  "13-pt drop" compared subset-69% against full-set-82% — sloppy; the true self-inflicted loss on subset90
  was 4 pts, now fully recovered.) `LME_EXPAND=0` had ruled out M2 expand as the cause.
- **L2: ✅ FIXED + MEASURED (+25 pts on the same instrument).** "Reader failure" decomposed into three
  mechanisms (measured, full-500 dump): **(a) multi-evidence COVERAGE** — chunk∃ 83% but evidALL only 56%
  (multi-session 35%, temporal 39%): the other anchor sat at rank 13–48. Two selection tricks failed
  (one-per-unseen-session 57%, per-session≤2 59%); fix = show the whole top-48 (full-context scores 60–64,
  so breadth is safe; still ≥10× compression) → evidALL 71% = the pool ceiling. Remainder is a QUERY gap →
  R4. **(b) TRUNCATION** — the 400-char tail cut chopped the answer out of 11/470 questions (chunks are
  ≤600); cut → 700, loss = 0. **(c) reader aggregation** — added a counting/how-many rule (enumerate every
  mention across excerpts, then count/sum) to the answer prompt.
  **End-to-end (90-Q subset, Claude reader+separate strict judge, same instrument both arms): 55/90 (61%) →
  77/90 (86%).** multi-session 2→9, assistant 7→13, preference 10→14, temporal 8→11, ku/user 15/15.
  Of the 13 still wrong: **10 = evidence not retrieved (query gap → R4 expansion), only 3 = true reader**
  (2 temporal off-by-one date arithmetic, 1 count). NOT comparable to the official 53.4% (different
  reader+judge); the v1→v2 delta is the valid signal. Instrument note: v2 fixed two v1 flaws (gold visible
  to reader; Read-tool line-truncation risk) — v1's gold-peek biased it UP, so the true delta is ≥ this.

**This corrects the Non-goal below:** the answer prompt is NOT a 16%-secondary lever — the reader owns ~46%
of losses (heavily multi-session + temporal). Re-weight R6 (reader) upward when re-deriving the milestones.

**L3 (root-cause forensic on the 10 evidence-miss questions): ✅ FOUND + FIXED — the FTS query was broken.**
Forensic (per-question rank of every ground-truth evidence chunk, oracle on the live scratch brain):
ALL evidence was IN the brain; it lost at query time. Two server bugs in `sanitize()`/FTS:
1. **`slice(0, 8)` token cap** — a long NL question queried only its first 8 non-stopword words:
   "…what color was the Plesiosaur?" NEVER queried "Plesiosaur" (all 5 evidence chunks rank >500 → rank 2–6
   after the fix). Cap → 24 (degenerate-input guard only). Also added `my me our am if` to stopwords.
2. **No stemming** (unicode61): "projects"≠"project", "kits"≠"kit", "trips"≠"trip" — 4/10 questions. Fix:
   `tokenize='porter unicode61'` + boot migration that REBUILDS `docs_fts` from `docs` on old brains
   (verified live: 104,450/104,450 rows; aborts if incomplete — no silent degraded index).
Full-500 dump after fix, NO regression anywhere: chunk∃ 84→**94%**, evidALL 71→**81%** (assistant 63→98,
preference 53→73, temporal 58→74). End-to-end subset90: **79/90 (88%)** vs 77 (v2) vs 55 (v1); the −2/+2
flips vs v2 are reader sampling noise (evidence verified present both rounds). Remaining ~5 real losses:
2 pure-paraphrase (doctors↔Dr., dinner↔basil/mint — the ONLY true R4/semantic residual), 2 common-term
dilution on counting questions (R3 exhaustive), 1-2 temporal gold quirks.

**LanceDB bug: ✅ FIXED + VERIFIED (embed queue, R2a).** Reproduced all three failure modes (builtin embed
to isolate the LanceDB write from embed latency): (A) 800 single-row adds → 800 fragments / 34M — one
fragment PER learn; (B) 8-wide concurrent ingest silently dropped 7/800 vectors (per-doc catch hid it);
(C) semantic + concurrent → learn awaited the slow sidecar → 30s timeout (the original ~q13 crash). Fix =
a serialized batch worker: learn `enqueueVector` and returns; one worker batches `embed()` then does ONE
multi-row `vtable.add(rows)` per flush; `/api/embed-settle` drains for read-after-write; counters in
`/api/stats` (embed_queue_ok/failed/depth). Re-measured, SAME conditions: (A) 800 docs → 73 fragments / 1.8M
(11×/19×); (B) 0/800 dropped; (C) **semantic + 8-wide concurrent, 304 docs → 0 timeouts, learn 117ms, 100%
real semantic, 0 failed** — the first time semantic completes a concurrent burst in the project's history.
Regression test `test/embed-queue.test.ts`; harness settles on the semantic path. `ORACLE_NO_VECTORS=1`
remains the fast probe path (vectors not needed for FTS-recall probes).

---
### (superseded — original problem statement, kept for the record)
~~84% of answerable losses are retrieval-miss; preference 0% / temporal 6% gold-in-top-12; higher-k dead;
semantic unverified.~~ All of this was the string-proxy artifact — see the CORRECTION above.

## The honest target (not the leaderboard)

Cross-system LongMemEval numbers are theatre — different reader (GPT-5-mini), judge (GPT-5), extractor,
prompt, rerank, schema, even benchmark variant. The 2026 94–96% wave is not on one condition; our 53.4 is
not comparable to it. The ONLY ungameable metric: **fix reader + judge + pipeline, vary ONLY the memory
layer, and beat full-context + `grep` by ≥10 pts with the same reader.** Today (GPT-4o) memory 53 <
full-context 60–64. **Goal: cross above full-context on that controlled delta.**

## Goals

- Every recall change measured cheaply and honestly: LLM-free probe first, controlled delta at gates.
- Move retrieval recall on the three losing shapes: paraphrase (preference/assistant), aggregation
  (multi-session), temporal.
- End with memory > full-context on the same-reader controlled delta.

## Non-goals

- Chasing others' 95% (incomparable — anti-theatre guard).
- Tuning the answer prompt as the primary lever (only 16% of losses; secondary — R6 only).
- Any README number until it earns it (upside-only rule).

## Milestones (ordered; each gated on the previous)

### R0 · Fix the instrument — prerequisite, nothing downstream is valid without it
1. **Make `AURALIS_SEMANTIC` actually embed, or fail loud.** Today it silently falls back to trigram. On a
   semantic run, assert the sidecar engaged (embedder=semantic, dim 384) AND vectors were written
   (count > 0) — else abort with an error. No more trigram-in-disguise.
2. **The retrieval-recall probe (`LME_PROBE_K`, built this session) is the primary cheap ruler** — LLM-free,
   measures `evid%@k` directly. Every recall experiment is probed first (seconds, $0); a full answer/judge
   run happens only at a gate.
**Gate:** a semantic probe shows recall DIFFERENT from trigram (proves engagement); probe documented as the
recall ruler. **Effort:** ~half a day. **Risk:** none — harness-only.

### R1 · The controlled baseline — the honest metric
Build "memory vs full-context vs `grep`, same reader (GPT-4o), official judge" into the harness.
full-context = feed all haystack turns; grep = lexical top-k of raw turns. This is the number we move.
**Gate:** one command emits the three-way delta and reproduces memory 53 vs full-context 60–64. **Effort:**
~1 day.

### R2 · Recall fix — real semantic + vector-weighted hybrid (paraphrase: preference 0%, assistant 21%)
Prereq R0. (a) Test a STRONGER embedder than MiniLM-L6 — a larger local sentence-transformer or a hosted
embedding API (e.g. text-embedding-3). (b) Fix the hybrid fusion so the vector lane isn't drowned by FTS
(weight it, or union a dedicated semantic top-k before RRF). Probe-first: does preference recall@12 rise
from 0? **Gate:** preference/assistant recall@12 rises materially with NO regression on user/knowledge-update;
a controlled-delta run confirms the end-to-end lift. **Effort:** 1–2 days. **Risk:** an embedding API adds a
dependency/cost — a bigger local model is the fallback.

### R3 · Recall fix — aggregation + temporal retrieval (multi-session 26%, temporal 6%)
(a) Exhaustive / `mode=all` retrieval for count/aggregation: every match above a floor for a topic (the old
M4). (b) Real multi-query per named event/entity — the current per-entity union is a NO-OP because
`extractEntities` is code-lexical; use NL entity extraction or the R4 query-expansion to name the events.
**Gate:** multi-session + temporal recall@12 rise; no regression; latency bounded on the prod brain.
**Effort:** 2–3 days. **Risk:** recall-vs-precision — the floor needs its own small bench.

### R4 · Query expansion — paraphrase, a lever that doesn't depend on the embedder
A cheap LLM rewrites each question into retrieval queries (synonyms, named entities, dated events) before
search, unioned in. Different axis than dense vectors — may be more robust and subsume part of R2/R3.
Probe-measured. **Gate:** recall lift on preference/temporal beyond R2/R3 alone. **Effort:** ~1 day (reuses
the `ApiRunner` cheap-LLM seam). **Risk:** query fan-out cost/latency — cap the expansions.

### R5 · Re-measure — the controlled delta + the official number
After the recall fixes land: re-run R1's controlled delta (did memory cross above full-context?) and the
official 500-Q number for the record. **Gate:** memory > full-context + grep on the same-reader delta — the
real win condition. **Effort:** one unattended run + ~$10.

### R6 · Answer-model attribution — secondary, cheap
Isolate the −17 Claude>GPT-4o gap: run Claude-answer + official judge (auralis's real-deployment number,
officially judged) and/or GPT-4o-answer with a GPT-4o-tuned prompt. Tells us whether auralis's real number
is higher and whether the prompt is the fixable part. **Effort:** one run each. **Slot:** anywhere after R1.

## Deferred option (post-phase) — BGE-M3 embedder swap

Proposed 2026-07-10, parked by decision. The ONLY validated reason to adopt BGE-M3 is **multilingual
(Thai/Vietnamese)** — trigram/MiniLM are genuinely weak there and LongMemEval (English) can never prove it;
it needs our own Thai/Viet eval. The PRD's other premises were refuted by ground truth: retrieval is NOT the
sole bottleneck (reader owns ~46% of losses), MiniLM was never actually measured (every run was trigram),
English chunk recall is already 82% (narrow upside), and the biggest retrieval loss is a pipeline slot bug,
not embedding quality. Preconditions before ANY embedder decision: LanceDB batch fix + embed queue + a real
MiniLM-vs-trigram probe baseline. Cost note: BGE-M3 = 568M params / 1024-dim on a CPU/WASM sidecar (~26×
MiniLM) — infra must be fixed first or it's just a slower broken run.

## Carried-over from this session (not recall — do not lose)

- **Secret cleanup + ingress scrub** (do SOON): purge the leaked OpenAI key from the prod brain (stop daemon
  → delete matching docs from docs/docs_fts/edges → restart); add secret-pattern redaction to
  `hooks/session-capture.mjs` so future pastes never persist. See memory `auralis-secret-leak-followup`.
- **Lifecycle managed scheduling**: wire `pnpm lifecycle` (built + proven this session) into a process
  manager / the `auralis` CLI so the LLM lifecycle (contradiction→invalidation, distillation) runs
  unattended in prod.
- **Durability single-instance lock**: belt-and-suspenders so two daemons can never open the same brain
  (the boot integrity-check catches it after the fact; a lock prevents it).

## Sequence

```
R0 (fix instrument) ▶ R1 (controlled baseline) ▶ R2 ┐
                                                 R3 ├▶ R5 (re-measure: beat full-context?)
                                                 R4 ┘   (R2–R4 parallel-ish, each probed cheaply first)
R6 (independent, cheap — slot anywhere after R1)
carried-over: secret cleanup (soon) · lifecycle-scheduling + single-instance-lock (slot when convenient)
```

R0 is strictly first: every recall number is measured through it.

## Phase exit criteria

1. On the controlled same-reader delta, auralis-memory beats full-context (and `grep`) by a real margin.
2. Any retrieval change is measured in one probe command (recall) + one controlled-delta command
   (end-to-end), both with a known noise bar.
3. The semantic path is verified-engaging (no silent fallback), and the embedder question is answered on
   valid evidence — not the retracted 2026-07-09 "closed" verdict.
