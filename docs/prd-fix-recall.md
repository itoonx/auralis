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
