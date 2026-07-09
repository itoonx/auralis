# PRD — Fix Recall: auralis loses at retrieval, close the gap honestly

Date: 2026-07-10 · Status: direction proposed, tasks not yet broken down
Basis: the P4 official run + failure decomposition + retrieval-recall probe (session 2026-07-09→10).
Supersedes the recall threads in `prd-next-phase.md` (M1–M6 + P4 are done; the embedder verdict there is
retracted — see its Deferred table).

## The problem, in measured facts

- **Official LongMemEval_S** (GPT-4o answer + official `evaluate_qa.py` judge): **53.4%** — below
  full-context GPT-4o (60–64), below Zep (71.2), above Mem0 (49). The self-referential 79 was inflated 26 pts.
- **84% of answerable losses are retrieval-miss** — the gold never reaches the reader (191 vs 36 answer-miss).
  The reader/answer stage is NOT the problem.
- It is a **RECALL** problem, not ranking: gold-in-top-k plateaus at k=25 (12→200 moves +4 then flat).
  **Higher-k and rank-tuning are dead levers.**
- Recall by ability (gold-in-top-12): preference **0%**, temporal **6%**, assistant 21%, multi-session 26%
  (we lose) vs user 86%, knowledge-update 75% (we win). ok% tracks recall almost exactly.
- The obvious fix (semantic) is **unverified**: the harness `AURALIS_SEMANTIC` path silently no-ops
  (byte-identical to trigram, 28s wall). When it does engage (manual test), MiniLM-L6's signal is weak —
  a relevant doc ranks only 1.6% above an irrelevant one, so it drowns among ~1000 distractors.

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
