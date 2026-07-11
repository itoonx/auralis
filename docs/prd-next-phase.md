# PRD — Next phase: fix the ruler, then teach recall three new moves

Date: 2026-07-09 · Status: direction approved, tasks not yet broken down
Basis: the validation experiments in `prd-longmemeval.md` §Validation — pooled internal score
**77/100**, judge false-negative rate ~4% (measured), answer-stage variance ~6% (measured),
failure taxonomy of 21 real misses across two disjoint subsets.

## The problem, plainly

Two problem groups, in dependency order:

1. **The ruler is bent.** Judge undercounts by ~4%; the answer LLM recovers 3/12 failures on a
   pure re-roll (~6% swing); the harness doesn't record what retrieval returned, so failure
   analysis requires rebuilding brains. Until this is fixed, *no future improvement can be
   measured honestly* — a +4-point delta is indistinguishable from noise.
2. **Recall knows one move.** It finds documents whose words match the question's words. The
   validated taxonomy shows four question shapes it loses: count-everything questions (n=6),
   same-meaning-different-words questions (n=4), the-answer-is-in-the-next-chunk questions
   (n=3, a seam our own chunking created), and false-premise questions answered confidently
   (n=2, worst failure mode for trust).

Everything else measured held up: the 76% survived a held-out subset (78%), ingestion policy
(chunk-with-anchor) is validated in production, and the evidence-only ceiling is 84%.

## Goals

- Make every future benchmark delta trustworthy (noise floor known, retrieval observable).
- Close the three retrieval classes that are deterministic and cheap (adjacency, aggregation,
  premise-check) — each must also earn its keep in the product story, not just the benchmark.
- End the phase with the first **non-self-referential public number** (P4, official judge).

## Non-goals

- Chasing 100% on LongMemEval (chess-notation recall, wrong-instance n=1 cases — not worth it).
- Ranker tuning justified only by LongMemEval (standing anti-gaming guard).
- Re-opening the embedder decision without its own A/B (see Deferred).

## Milestones

Phase vocabulary (agreed 2026-07-09) → milestones: **Phase 1 Fix Measurement + Phase 2
Retrieval Observability = M1** · **Phase 3 Multi-mode Retrieval = M2 + M4** (one mode
interface; the semantic slot stays trigger-gated in Deferred) · **Phase 4 False-premise
Guardrail = M3** · **Phase 5 LongMemEval Regression Suite = M1's judge fixtures +
failure-class report**, grown every run.

### M0 · Production mileage checkpoint — calendar-gated, runs in parallel
The daemon + global hooks are live; the brain accumulates real memories while we work.
**Deliverable:** a review session over the first sleep report post-chunking + brain stats.
**Watch items:** sibling chunks in the 0.75–0.92 dedup band; sibling crowding in recall top-3
(= the MMR trigger); cited/seen ratio. **Gate:** 3–5 days of real usage. **Effort:** half a day
of reading numbers together. The outcome may reorder M2–M4 priorities — that's its job.

### M1 · Fix the ruler — before any capability work
**Why:** measured judge FN 4% + answer variance 6% > the size of most expected improvements.
**Deliverables:**
1. Judge pre-check: gold string appears verbatim in the response → correct, no LLM verdict.
2. Judge regression fixtures: every observed bad verdict ("Premier Silver", "Nu, pogodi!",
   "Four … Mummies (4)") becomes a stored (question, gold, response, expected-verdict) case
   the judge must pass — a unit test for the ruler, grown each time an audit catches a new one.
3. Full per-question trace: retrieved doc ids + ranks + excerpt cuts, answer prompt, hypothesis,
   judge verdict **and judge reason** — this analysis had to rebuild 12 brains to see what
   retrieval did; never again.
4. Failure-class tags: the 21 analyzed misses tagged (aggregation / semantic-mismatch /
   neighbor-chunk / false-premise / lexical) and the run report broken down per class — every
   later milestone must prove it moved *its* class and regressed nothing else.
5. Evaluation discipline: pooled-100 is the iteration unit; **milestone gates run 3× and compare
   means** (3× on every iteration would triple cost to beat noise we only face at decision
   points — single runs stay for smoke). Borderline judge verdicts get a human-audit pass; the
   manual audit is exactly what caught both FNs this round.
**Gate:** pooled-100 × 3 with the new judge establishes the phase baseline and its real spread
(expected ~80±3 after FN correction). **Effort:** ~1 day. **Risk:** none — harness-only,
ranker untouched.
**✅ Result (gate passed, 3× pooled-100):** baseline **79.3 ± 1.5** (81/79/78) — right on the
expectation. The judge-fn class is 2/2 fixed in all three runs (pre-check works); variance-tagged
questions flip run-to-run exactly as predicted; `single-session-user` is 16/16 in all three runs.
The classes M2–M4 exist for are confirmed still broken: neighbor-chunk ≤1/3, aggregation ≤2/6,
false-premise ≤1/2. Decision rule from here: **a milestone counts as landed only if its own class
moves and the pooled-100 3× mean beats 79.3 by more than 3 points of its class's share.**

### M2 · Adjacency expansion — a hit pulls its neighbours
**Why:** kills the sibling-chunk class (n=3): the answer to "what came after X" doesn't contain
X's words, but it sits in the chunk *next to* the one that does. The seam is ours (chunking);
the stitch should be too. **Product story:** conversational continuity — "what did we decide
after the retrieval discussion" is a real fleet/session query; this is also the graph edge the
oracle almost has already (turn-adjacent docs).
**Deliverables:** read-time option: each top-k hit may pull its immediate neighbour chunk(s)
(same turn/session, bounded ±1) into the context; wired into the LME harness and the recall
lane behind a flag.
**Gate:** pooled-100 assistant class improves beyond the noise bar with no regression elsewhere;
`pnpm bench` recall benches don't regress. **Effort:** ~1 day. **Risk:** context growth — bound
it (neighbours only for top-3 hits).
**❌ Result (gate NOT passed, 3× pooled-100, expand ON via CLI):** TOTAL 80/80/75 → mean **78.3**
(vs baseline 79.3 ± 1.5 — delta −1.0, inside noise). neighbor-chunk class **0/3, 1/3, 1/3** — did
not move (run-to-run flips are answer variance, not adjacency). Per the M1 decision rule, M2 lands
neither test. **Root cause (from the M1 traces):** all 3 neighbor-chunk questions fail because the
gold never reaches the answer stage — base retrieval misses the anchor chunk, so adjacency has
nothing to expand (it only pulls neighbours of top-3 hits). The tag was mis-diagnosed: 1/3 is a
true seam (chess notation — a stated non-goal), the other 2 (Sugar Factory, Patagonia) are
retrieval-recall/semantic misses adjacency can't fix. **Decision:** keep the mechanism (default-OFF
flag, cheap, regresses nothing, real product story) but do NOT credit it as a benchmark win; the
real lever is retrieval **recall**, which fires the Deferred semantic-embedder re-A/B trigger
("real paraphrase misses" — now on evidence, not vibes).

### M3 · Answer rules v2 — premise check + "today" inference
**Why:** false-premise questions failed 2/2 identically on both subsets (confident wrong answer,
unstable content — "5 engineers" vs "4 engineers" on identical input); one temporal miss needs
the inference "an event described as 'today/just now' dates to the session date".
**Deliverables:** two lines in the harness answer prompt: (a) verify the question's premise
against the excerpts — if the premise never happened, say so; (b) date events by their session
date when stated as current.
**Gate:** both abstention traps flip on pooled-100 **without** lowering the abstention-correct
rate elsewhere (over-abstaining is the failure mode to watch). **Effort:** hours.
**Honesty note:** harness-only value; in production the answering agent owns premise-checking.

### M4 · Aggregation retrieval — "collect ALL mentions", not "best match"
**Why:** biggest class (n=6). Count/total/order questions need every dated mention of a topic;
top-k returns the best 1–2 and the count comes out wrong — and *unstably* wrong (2 vs 1 items
on identical input). **Product story:** "list everything we know about X / every decision on Y"
is a real agent query the oracle can't serve today.
**Deliverables:** a deterministic retrieval mode (API-level: `mode=all` or similar) that returns
every match above a floor for a topic, harness detects count/order/total questions by pattern
and uses it. This lands the **mode interface**: keyword (today's default), neighbor expansion
(M2), exhaustive (this), time/entity filtering (already exists via `as_of` + query terms) — and
a semantic mode plugs into the same seam if its Deferred trigger ever fires.
**Gate:** aggregation class majority-fixed on pooled-100; API latency bounded on the production
brain. **Effort:** 2–3 days (API + harness + tests). **Risk:** recall-vs-precision — the floor
needs its own small bench.
**⊘ DROPPED (2026-07-12) — premise refuted by our own evidence; deferred with explicit triggers.**
The R3 probe showed the 7 counting losses are FLAT at k=48→800 (the evidence is rank-∞: instance
vocabulary — "Tamiya Spitfire" — shares no words with the question), so "return every match above a
floor" cannot recover this class by construction. What actually remained of M4 has since shipped or
been proven elsewhere: the reader half landed in L2 (enumerate-then-count + whole top-48), the
vocabulary half has two answers — R4 blind expansion (+3, verified; prod use blocked on LLM credit)
and the BGE-M3 semantic lane (SHIPPED 2026-07-12; subset50-cleaned probe: multi-session
session-coverage 100%@48, 100% semantic engagement verified). The product story (`mode=all`, "list
everything about X") has no live consumer today — every current caller (recall hook, fleet, MCP,
studio) uses ranked top-k. Reopen triggers (do NOT build without one):
(a) a fleet/MCP feature actually needs exhaustive listing → build `mode=all` (half a day);
(b) the post-credit answer-stage A/B on the semantic stack shows aggregation still failing
end-to-end → re-probe the lexical-miss residue (trigram-era "6/7" is stale), then sparse lane /
expansion routing sized to what the probe finds.

### M5 · P4 — the public number
**Why:** the whole point of the benchmark line: one non-self-referential number.
**Prereqs:** M1 (trustworthy internal numbers) + whichever of M2–M4 landed; an OpenAI key
(~$5, the official GPT-4o judge is the one external dependency); user green light.
**Deliverables:** full 500-Q `S` run, judged by official `evaluate_qa.py`; per-ability table
published honestly (README upside-only rule applies — the table goes in docs, the README gets
one line only if the number earns it).
**Gate:** user says go. **Effort:** one unattended evening + $5.
**◐ Result (2026-07-09, all-OpenAI, NOT yet the official judge):** full 500-Q, trigram, expand-off,
**GPT-4o answer + GPT-4o judge (our prompt, `LME_ANSWER=openai LME_JUDGE=openai`)** = **58%** (289/500).
Per-ability: single-session-user 89 · knowledge-update 76 · temporal 55 · multi-session 44 · assistant
43 · preference 43. **The humbling decomposition:** the *same* pooled-100 questions scored **62%** here
vs **79.3%** Claude-answer+Claude-judge — **−17 points from the model pairing alone**, not distribution
(full-500 is only −4 vs pooled-62). So most of the self-referential 79 was Claude-answers-Claude, not
memory quality. Competitively (all GPT-4o-answered): Zep 71.2 · **full-context GPT-4o 60–64** · **us 58**
· Mem0 49 — i.e. our memory + GPT-4o currently does NOT beat dumping full context into GPT-4o on S.
**Caveats (= next steps, not excuses):** (a) our GPT-4o judge ≠ official `evaluate_qa.py` and is likely
STRICTER (the field's standard judge is lenient) — 58 is a floor; the official judge may lift us several
points. (b) the answer prompt was implicitly Claude-tuned; GPT-4o follows the abstain/recommend/date rules
differently. **✅ True M5 — OFFICIAL number (2026-07-09):** ran the official `evaluate_qa.py` (gpt-4o-2024-08-06,
per-type calibrated prompts) on the same 500 GPT-4o-answered hypotheses: **53.4%** (267/500).
Per-ability: single-session-user 88.6 · knowledge-update 76.9 · temporal 46.6 · multi-session 39.9 ·
assistant 35.7 · preference 33.3. Surprise: the official judge is **4.6 pts LOWER** than our own
(58%) — it is STRICTER ("a subset of the answer = no") and has no gold-precheck, so our judge was the
lenient one, not it. **Full decomposition 79.3 → 53.4 = −26 across three stacked confounds:**
distribution −4 (pooled→full), **answer model −17 (Claude→GPT-4o, the biggest)**, judge −5 (ours→official).
**Apples-to-apples (all GPT-4o-answered + official judge): Zep 71.2 · full-context GPT-4o 60–64 ·
us 53.4 · Mem0 49.** Honest reading: on `S` our memory + GPT-4o does NOT beat dumping full context into
GPT-4o (S fits in a context window — the field's contamination critique), and trails Zep by 18. Two live
threads: (1) the −17 answer-model gap — is our answer prompt Claude-tuned (fixable) or is Claude simply the
better reader (so auralis's real deployment number is higher but not Zep-comparable)? (2) auralis's actual
edge — free LLM-less ingestion at scale — shows on `M` (1.5M tokens, doesn't fit a context window), not `S`.
README upside-only rule holds: this number is NOT README-worthy; it lives here.

### M6 · Distribution round 2 — ghcr images + npm CLI
**Why:** standing decision ("next production round we should have ghcr/npm"). Independent of
the benchmark line; makes `auralis start` work on a machine that never built the repo.
**Deliverables:** CI-published ghcr image, `npx auralis` (or global npm) wrapping the compose
lifecycle, README quickstart updated.
**Gate:** a clean machine (or clean user account) goes zero-to-daemon with two commands.
**Effort:** ~1 day. **Risk:** none technical; registry auth plumbing only.

## Benchmark interpretation discipline (2026-07-10 — reference for every future number)

The 2026 wave of 94–96% LongMemEval claims are NOT on one condition: different reader (GPT-5-mini vs
our GPT-4o), different judge (GPT-5, often more lenient), different extractor/prompt/rerank/schema, and
some run a modified benchmark variant. **Reader choice alone dominates the absolute score** — our own
Claude→GPT-4o swap moved the same retrieval −17 points. So a cross-system "X% vs Y%" is mostly theatre.
- **Do NOT** compare our 53.4 to anyone's 95 — different axes, meaningless.
- **Do NOT** let "their 95 is inflated" erase the ONE fair comparison: same reader (GPT-4o) + official
  judge puts us at 53.4 vs full-context 60–64 vs Zep 71.2 — and there we lose to full-context. Real signal.
- **The only ungameable metric** = a controlled delta on OUR use case: fix reader+judge+pipeline, vary
  ONLY the memory layer, measure auralis-memory vs full-context vs `grep` with the same reader. Memory
  must beat full-context/grep by ≥10 pts to justify itself (per the field's own "Benchmark Theatre"). On
  `S` with GPT-4o we're currently BELOW full-context — that, not the leaderboard, is the number to move.

## P4 failure diagnosis (2026-07-10) — we lose at RETRIEVAL, not the reader

Decomposed all 500 official-judged results against the trace (gold-string-in-excerpts = did retrieval
deliver the evidence to the reader). **Answerable failures: 191 retrieval-miss vs 36 answer-miss — ~84%
of losses are the gold never reaching the reader.** ok% tracks retrieval-recall (evid%) almost exactly:

| ability | N | ok% | evid% (retrieval recall) | fails ret/ans |
|---|---|---|---|---|
| single-session-user | 70 | 89 | 86 | 3 / 5 |
| knowledge-update | 78 | 77 | 75 | 8 / 9 |
| multi-session | 133 | 40 | 26 | 64 / 14 |
| single-session-assistant | 56 | 36 | 21 | 34 / 2 |
| temporal-reasoning | 133 | 47 | 16 | 62 / 6 |
| single-session-preference | 30 | 33 | **0** | 20 / 0 |

Where retrieval delivers the gold (user 86, knowledge-update 75) we win; where it doesn't (preference 0,
temporal 16, assistant 21, multi-session 26) we lose. The reader/answer stage is NOT the problem (36/500).
The −17 Claude>GPT-4o gap is secondary: it's about extracting from noisy/partial excerpts — the ceiling is
still set by retrieval. **evid% is a string-match lower bound** (semantic-equivalent evidence undercounted),
but the pattern is unambiguous. **Levers, by failures gained:** (1) multi-session 64 + temporal 62 →
aggregation/exhaustive mode (M4) + temporal-aware retrieval; (2) assistant 34 + preference 20 →
paraphrase/semantic recall — but MiniLM already lost the A/B, so it needs HYBRID fusion (keep lexical, add
semantic only for zero-overlap) or a better embedder or query expansion, PROVEN to move preference (0%);
(3) reader: leave it. Note: `S` fits a context window so full-context wins here regardless — auralis's real
edge (free ingestion at scale) is an `M`-variant (1.5M-token) question, not `S`.

## Sequence

```
M0 ──────────────(calendar, parallel)──────────────▶ review session
M1 ▶ M2 ▶ M4 ▶ M5(gate: key + green light)
      ╲ M3 (independent, hours — slot anywhere after M1)
M6 (independent — slot when a break is wanted from recall work)
```

M1 is strictly first: every later gate is measured through it.

## Deferred — with explicit triggers (do NOT start without one)

| item | trigger |
|---|---|
| Semantic embedder re-A/B (preference class, n=4) — **RE-OPENED 2026-07-10, the "CLOSED" verdict was wrong** | First read (2026-07-09): `AURALIS_SEMANTIC=1` pooled-100 = 72 vs trigram 79.3, "decisively worse, trigram stays." **That conclusion is now retracted.** The retrieval-recall probe (2026-07-10) found the semantic harness run gives byte-identical recall to trigram with a 28s wall (embedding 100k chunks is impossible in 28s) — i.e. **the corpus was almost certainly never actually embedded in the harness `AURALIS_SEMANTIC` path** (best-effort embed silently no-ops / sidecar timing). So the 72 was trigram-with-variance, NOT a semantic test. A clean manual test DID engage MiniLM (boot log "embedder: semantic dim 384") but its signal is WEAK — query "homegrown ingredients" ranks "fresh basil from my garden" only 1.6% above "weather in Tokyo" (0.0205 vs 0.0202), so among ~1000 distractors the paraphrase evidence drowns. **Real state: (a) the harness semantic path is broken/unverified — fix it before any A/B counts; (b) MiniLM-L6 alone looks too weak for paraphrase recall — a stronger embedder and/or vector-weighted fusion is the real question. The embedder question is OPEN.** |
| MMR / diversity re-ranking | sibling crowding actually observed in recall top-3 (M0 watch item) |
| M4 aggregation retrieval (`mode=all`) — DROPPED 2026-07-12, see M4 section | a fleet/MCP feature needs exhaustive listing; OR post-credit answer-stage A/B on the semantic stack shows aggregation still failing end-to-end |
| Context budget for recall injection | injected context exceeds ~10KB in real sessions |
| LongMemEval-M (1.5M tokens) | after the P4 `S` number is published and worth extending |
| Cross-machine claim TTL/lease, hetero runtimes | unchanged — see `roadmap.md` (platform axis) |

## Phase exit criteria

1. A public per-ability LongMemEval table exists, produced by the official judge.
2. Any future retrieval change can be evaluated in one command with a known noise bar.
3. The production brain has survived ≥2 weeks of dogfooding, with at least one sleep-report
   review done and the MMR question answered with data (yes it's needed / no it isn't).
