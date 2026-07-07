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

### M5 · P4 — the public number
**Why:** the whole point of the benchmark line: one non-self-referential number.
**Prereqs:** M1 (trustworthy internal numbers) + whichever of M2–M4 landed; an OpenAI key
(~$5, the official GPT-4o judge is the one external dependency); user green light.
**Deliverables:** full 500-Q `S` run, judged by official `evaluate_qa.py`; per-ability table
published honestly (README upside-only rule applies — the table goes in docs, the README gets
one line only if the number earns it).
**Gate:** user says go. **Effort:** one unattended evening + $5.

### M6 · Distribution round 2 — ghcr images + npm CLI
**Why:** standing decision ("next production round we should have ghcr/npm"). Independent of
the benchmark line; makes `auralis start` work on a machine that never built the repo.
**Deliverables:** CI-published ghcr image, `npx auralis` (or global npm) wrapping the compose
lifecycle, README quickstart updated.
**Gate:** a clean machine (or clean user account) goes zero-to-daemon with two commands.
**Effort:** ~1 day. **Risk:** none technical; registry auth plumbing only.

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
| Semantic embedder re-A/B (preference class, n=4) | preference matters for the P4 target, OR production shows real paraphrase misses. Honesty: the "trigram stays" decision was made on pre-truncation-fix data (stale evidence) — but re-opening requires a full A/B on the fixed harness, not vibes |
| MMR / diversity re-ranking | sibling crowding actually observed in recall top-3 (M0 watch item) |
| Context budget for recall injection | injected context exceeds ~10KB in real sessions |
| LongMemEval-M (1.5M tokens) | after the P4 `S` number is published and worth extending |
| Cross-machine claim TTL/lease, hetero runtimes | unchanged — see `roadmap.md` (platform axis) |

## Phase exit criteria

1. A public per-ability LongMemEval table exists, produced by the official judge.
2. Any future retrieval change can be evaluated in one command with a known noise bar.
3. The production brain has survived ≥2 weeks of dogfooding, with at least one sleep-report
   review done and the MMR question answered with data (yes it's needed / no it isn't).
