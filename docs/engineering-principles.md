# Engineering principles — non-negotiable

> Set 2026-07-10 after one session's dogfooding uncovered **5 silent failures** (brain corruption undetected
> for weeks, benchmark data leaking into the prod brain, the LLM lifecycle never firing in prod, `pnpm bench`
> able to wipe prod, and `AURALIS_SEMANTIC` silently running on trigram). Every one **passed its unit tests
> and its self-authored benchmark**, and every one was hidden by the system's own graceful degradation.
> This is our standing principle. Do not let it slide.

## VERIFY IN REALITY — the one rule

We are good at *building mechanisms* and *making them robust*. We were under-invested in *proving they
actually work in production and knowing when they don't*. Robustness (fail-silent, best-effort, graceful
fallback) is the **enemy of observability** — the same design that keeps the system running is what hid it
running WRONG. Hold both axes.

## The checklist — every feature/PR must pass it

1. **Assert the OUTCOME, not the call.** A test that proves `learn()` was called proves nothing. Assert the
   *ground truth*: the vector is in the index, `invalid_at` got written, the brain passes `integrity_check`,
   the edge exists. Mechanism-tested ≠ works-in-production.

2. **Every silent fallback emits a COUNTER, not just a log.** Graceful degradation is allowed *only if it is
   observable* — "fail-quiet-but-counted." If code can silently do the cheap/wrong thing (builtin instead of
   semantic, FTS instead of vector, skip instead of write), it must expose a count/ratio a caller can check.
   (The R0 `semantic_embeds / embed_fallbacks` stat is the template.)

3. **Verify the instrument before trusting the number.** Every measurement pipeline has a ruler that can lie
   — judge, reader/answer model, embedder engagement, retrieval mode. Check EACH one actually is what you
   think before you believe the result. Never conclude on a **proxy**: an env flag (`AURALIS_SEMANTIC=1`) is
   not behavior; a unit-test pass is not production; "a number was produced" is not "the number is valid."

4. **Dogfood and INSPECT, on a schedule.** A system you don't open and read in production is drifting
   silently. Reading the real brain (M0) is what cracked all 5 open. Make "look at the real thing" routine.

5. **Don't conclude fast on plausible evidence.** The embedder was declared "closed (trigram wins)" on a run
   nobody verified was actually semantic. Plausible + unverified = unknown. If a result would change a
   decision, verify its instrument first.

## How to use this

Every task in `tasks-fix-recall.md` (and beyond) must satisfy the checklist before it's "done". A recall
fix isn't done when the code compiles — it's done when a probe/assert proves the vectors populated and the
number moved for the reason you claim. Reviewers block on missing outcome-assertions and un-counted fallbacks.
