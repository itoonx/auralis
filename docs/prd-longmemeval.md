# PRD — LongMemEval: auralis on a neutral benchmark

Date: 2026-07-07 · Status: proposed (plan only — no harness built yet)
Why: our benches prove mechanisms honestly but are self-authored. LongMemEval (ICLR 2025,
[repo](https://github.com/xiaowu0162/LongMemEval), MIT, data on HuggingFace) is the field's most credible
public memory benchmark — the arena where a competitive claim stops being self-referential.

## The benchmark, in facts

- **Variants:** `S` (~40 sessions ≈115k tokens per question, 500 questions) · `M` (~500 sessions) ·
  `oracle` (evidence-only sessions). Start with `S`; `M` later.
- **Five abilities:** information extraction · multi-session reasoning · **knowledge updates** ·
  **temporal reasoning** · abstention.
- **Format per question:** `haystack_sessions` (user/assistant turns), `haystack_dates` (session
  timestamps), `question`, `question_date`, `answer`.
- **Integration contract:** emit `jsonl` of `{question_id, hypothesis}` → official `evaluate_qa.py`
  judges with **GPT-4o**.

## Why this maps unusually well onto what we built

1. **Free ingestion is a structural edge.** Every competitor pays an LLM per write (Mem0 extraction,
   Zep graph build). Our ingest is `learn()` — deterministic lanes, auto graph, no LLM. 500 haystacks
   ≈ 100–300k learns ≈ minutes of wall, ~zero cost.
2. **`haystack_dates` → `validAt` verbatim.** Session timestamps back-date each memory's validity —
   then **knowledge-update questions** are literally our supersede/invalidate semantics and **temporal
   questions** are `as_of` queries. These two categories are the field's universal weak spot (lowest
   sub-scores for every vendor) and our two newest proven mechanisms.
3. **Abstention** maps to our confidence machinery: weak/empty retrieval → decline to answer.

**Honest expectation:** chat-history memory is Zep's home turf, not ours (coding-agent memory). The
trigram embedder will hurt on paraphrase-heavy extraction questions — which is exactly why this doubles
as the **§7 embedder instrument**: the trigram-vs-semantic A/B this benchmark provides is the evidence
the deferred embedder decision is waiting for.

## Plan — four phases, each gated on the previous one's numbers

| phase | what | measure / gate |
|---|---|---|
| **P0 · scout** (~1h) | download `S` + `oracle`, inspect format, build the 50-question stratified subset (10 per ability) | data loads; subset covers all 5 abilities |
| **P1 · harness** (~half day) | `run-longmemeval.ts`: per question — fresh project → ingest turns through the session-capture lanes (user turns `validAt`=session date; assistant turns 0.5 trust) → retrieve (top-k; temporal questions add `as_of`=question context) → Claude composes the hypothesis → jsonl out. Abstention rule: retrieval below floor → "no answer" | oracle-variant sanity ≥ high (evidence-only should be near-ceiling; if not, the harness is broken — instrument-first) |
| **P2 · smoke, trigram** | 50-Q subset, current defaults; judge twice — Claude-judge for fast iteration, official GPT-4o judge for the reportable number (needs an OpenAI key; ~$2–5) | per-ability breakdown; expectation: temporal/updates strong, extraction weak |
| **P3 · embedder A/B** | same 50-Q with `AURALIS_SEMANTIC=1` (+ re-embed backfill built here — the §7 blocker) | **the embedder decision gets made on this delta** — flip default only if the gap is real |
| **P4 · full run** | 500-Q `S` with the winning config; publish per-ability table vs published numbers (Zep: +18.5% over full-context, gpt-4o) | the first non-self-referential auralis number |

## Costs, stated plainly

- Ingest: ~free (the edge). Hypothesis generation: 500 Claude calls (subscription; do P2/P3 on 50 first).
- Official judge: GPT-4o API — the one external dependency; without an OpenAI key we can iterate on
  Claude-judge but must label those numbers non-comparable.
- Wall time: P2/P3 ≈ an hour each; P4 ≈ several hours unattended.

## Out of scope (v1)

`M` variant (1.5M tokens — after `S` says we belong) · leaderboard submissions/PR to their repo ·
tuning the ranker specifically to LongMemEval (benchmark-gaming; config changes must be justified by
our own benches too, or they're overfitting).

## Results (P0–P3 executed 2026-07-07 · P4 remains deferred)

- **P0** ✅ S+oracle downloaded; deterministic 50-Q stratified subset (8 abstention).
- **P1** ✅ harness + gate did its job: oracle-variant sanity started at 40% and exposed two real harness
  bugs (judge failed "Two"≡2 and correct abstentions; single-query retrieval missed two-event temporal
  questions) → fixed (equivalence-aware judge, multi-entity union retrieval) → 70%. Remaining misses are
  retrieval-capability, not harness. Bonus: the concurrent run exposed and fixed an oracle id-collision
  bug under same-millisecond parallel learns.
  **Correction (validation, 2026-07-09):** the multi-entity union was a NO-OP on this benchmark —
  `extractEntities` is lexical and code-oriented (backticks, paths, CamelCase) and yields ≥1 entity on
  only **12/500** LongMemEval questions. The 40%→70% gain came from the judge fix alone. The union code
  stays (it is correct for the product's code-entity queries) but it earns nothing here.
- **P2** ✅ trigram baseline 58% (internal Claude-judge; 480s wall for 50 full haystacks — LLM-less
  ingestion held: ~500 turns/question, zero ingest cost).
- **P3** ✅ semantic A/B: 56% — no win; per-category table in research-memory-os.md §7-resolved. The
  embedder decision is CLOSED (trigram stays) — this PRD's second purpose is fulfilled.
- **P4** ⏸ deferred by design: the public number waits for production mileage + distribution
  (docs/research-memory-os.md §10 sequence). Internal numbers are Claude-judged and labelled non-comparable.

## Weak-point analysis (2026-07-07) — 58% → 76% on the same subset, no ranker changes

Opened every failing case in the three worst categories instead of guessing. Three distinct root causes,
none of them retrieval-ranking:

1. **Excerpt truncation** (preference 17%, assistant 33%): the evidence sat in assistant turns averaging
   ~1,800 chars (max 4,000+) but excerpts cut at 500 — retrieval found the right doc, the answer stage
   never saw the answer. This also explains why the P3 embedder swap moved preference 17%→17%: the
   bottleneck was after retrieval. → **chunk long turns at ingest** (a memory unit is a unit of thought,
   not a turn; `chunkTurn`, sentence boundaries, ≤600 chars) + rank-aware excerpts (top-4 get 1,400).
2. **Lost topic anchor** (chunking's own side effect, caught by the re-run: assistant 33%→17%): a
   mid-list chunk ("7. Transcriptionist…") no longer contains the words that make it findable
   ("work-from-home jobs"). → continuation chunks carry a `[re: <turn opening>…]` contextual header.
3. **Over-strict answer grounding** (preference all-abstain; temporal "No"-questions): "answer ONLY from
   excerpts else I don't know" made the model refuse recommendation questions and grounded-absence
   yes/no questions it had the evidence for. → answer rules: recommendations build on the user's stated
   context; topic-covered-but-detail-absent yes/no → "no"; date questions compute from `[said]` dates;
   abstain only when nothing is relevant.

| category | baseline | +chunking | +anchor+answer-rules |
|---|---|---|---|
| knowledge-update | 80% | 90% | 90% |
| multi-session | 70% | 80% | 80% |
| single-session-assistant | 33% | 17% | 67% |
| single-session-preference | 17% | 17% | 50% |
| single-session-user | 75% | 100% | 100% |
| temporal-reasoning | 50% | 50% | 60% |
| **TOTAL** | **58%** | **64%** | **76%** |

Honesty notes: internal Claude-judge numbers (≥1 observed judge false-negative: "Four … Mummies (4)"
judged wrong vs gold "4"); two iterations on one 50-Q subset means some subset-fit risk — the changes are
generic ingestion/answer policies (chunking, contextual headers, grounded-answer rules), the ranker and
oracle were not touched. Remaining known gap: exact-notation recall (chess moves) and two-event date math.
Product follow-up worth considering (deferred): apply the same chunk-with-anchor policy to
`hooks/session-capture.mjs` for long assistant conclusions.

## Validation (2026-07-09) — the 76% survives a held-out subset; the remaining gap decomposed

Three experiments, run to test the 76% rather than to improve it:

1. **Held-out subset** — 50 fresh questions, zero overlap, per-(type,abstention) distribution matched,
   frozen config: **78%** (39/50). The subset-fit fear dies: two tuning iterations did not overfit the
   original 50. Best current estimate is the pooled **77/100**. Per-category numbers at n=6–10 swing
   ±15–20% between subsets (preference 50↔83, temporal 60↔90, multi-session 80↔60) — never read a
   single-category number on one subset as signal.
2. **Oracle-variant rerun** (evidence-only sessions, same 50 original questions, frozen config): **84%**
   (up from 70% at P1). This splits the 24-point gap to 100: **~8 points are retrieval under haystack
   noise; ~16 points survive even with retrieval solved** (answer-stage + judge). Category tells:
   preference 50→**100** (pure retrieval problem — given evidence the model is perfect), assistant
   67→**67** (unchanged: the failure is query↔answer token mismatch, scale-independent), temporal 60→80.
3. **Retrieval probe + answer replay on all 12 original failures** — rebuilt each failed question's
   brain, reran the exact harness retrieval, checked mechanically (via `answer_session_ids`) whether
   evidence made top-12, then re-asked the exact answer prompt on those excerpts:
   - **3/12 recovered on a pure re-roll** (two temporal date computations, the beer recommendation —
     evidence was at ranks 1–5 all along). Answer-stage sampling variance is worth ~6% on a 50-Q subset:
     larger than judge noise. Single-run comparisons under ~±6% are meaningless.
   - **2/50 judge false-negatives measured** on the held-out run (gold "Premier Silver" vs our answer
     beginning "Premier Silver —"; gold "Nu, pogodi!" named verbatim) — Claude-judge undercounts by ~4%;
     held-out is arguably 82%.
   - The rest are real, and they cluster:

| root cause (pooled, both subsets, judge-FNs removed) | n | mechanism |
|---|---|---|
| exhaustive aggregation ("how many/total/order across sessions") | 6 | top-12 covers 1–2 of k evidence mentions; count/sum comes out short — retrieval has no "collect ALL mentions" mode |
| preference paraphrase/transfer | 4 | zero token overlap (Q "homegrown ingredients" vs evidence "fresh basil and mint"; Miami question, Seattle preferences) — beyond any lexical ranker |
| sibling-chunk miss (assistant recall) | 3 | the answer chunk shares no tokens with the question ("28. Kg3" vs "what came after 27. Kg2 Bd5+") — the right *session* ranks top-3, the right *chunk* doesn't; chunking created the seam |
| abstention premise-traps | 2 | 2/2 failed identically on both subsets: topic-adjacent evidence exists, model answers instead of checking the premise ("Software Engineer Manager" role never existed) — and unstably (5 vs 4 engineers on identical input) |
| second-event date retrieval + "today"-inference | 2 | second event absent from top-8, or the event's date is the session date itself and the model refuses the inference |
| wrong-instance selection | 1 | multiple yoga mentions; retrieval surfaced the app, not the studio |

Directions this ranks (none started): **(a)** adjacency expansion at read time — a hit pulls its
neighbouring turn/chunk from the same session; kills the sibling-chunk class and is the natural graph
edge the oracle already almost has. **(b)** an aggregation retrieval mode — "all dated mentions of X",
feasible deterministically. **(c)** a premise-check line in the answer rules. **(d)** the preference
class needs semantic representation or preference-tagging at ingest — the trigram-stays decision was
made on P3 data that predates the truncation fix, so it is *decided on stale evidence*, but re-opening
it requires its own A/B, not vibes. **(e)** harness observability: log retrieved doc ids per question
(this analysis had to rebuild brains to see what retrieval did). **(f)** judge: 4% FN rate justifies a
cheap "gold string appears verbatim in response → correct" pre-check before the LLM verdict.
