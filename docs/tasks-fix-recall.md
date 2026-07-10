# Task breakdown — Fix Recall (dispatch-ready)

> ⚠️ **2026-07-10 (session 2): the waves below are SUPERSEDED** — they were derived from the retracted
> string-proxy diagnosis. L1 (answer-path eviction), L2 (coverage/truncation/counting), and L3 (FTS
> 8-token-cap + porter root cause) are DONE on branch `fix-recall` (55→79/90 same-instrument). See
> `prd-fix-recall.md` SESSION-2 UPDATE. **NEXT QUEUE (in order):**
> 1. ~~**LanceDB batch-add fix**~~ ✅ **DONE** — embed queue (serialized batch worker + `/api/embed-settle` +
>    counters). Reproduced A/B/C, re-measured: 800→73 fragments, 0 concurrent drops, semantic burst completes
>    (117ms, 100% real, 0 timeout). Test `test/embed-queue.test.ts`. See PRD "LanceDB bug: FIXED".
> 2. ~~**C1/C2 secret cleanup + ingress scrub**~~ ✅ **DONE (2026-07-10)** — C1: purged the leaked OpenAI key
>    from the prod brain — 2 `docs` + 2 `docs_fts` rows, and (found only by raw-byte scan) **3 `events.human`
>    prompt logs** the memory note had missed; DELETE/redact + VACUUM, raw byte-grep 6→0, integrity ok, 226→224
>    docs, no collateral loss. C2: `scrub()` in `hooks/session-capture.mjs` redacts sk-*/ghp_*/AKIA*/AIza*/
>    xox*/Bearer/PEM at ingress (applied to prompt + assistant text, before learn/event/recall). Test in
>    `test/session-capture.test.ts` (synthetic keys). Prod brain is gitignored (never committed).
> 3. ~~**R3-lite exhaustive retrieval**~~ ❌ **REFUTED (2026-07-10)** — probed gold-session/chunk recall at
>    k=48,100,200,400,800 on the 7 counting losses: **dead flat, 0/7 flipped**. The missing evidence is rank-∞
>    (the counting question shares no words with "Tamiya Spitfire"/"Tiger tank"), NOT rank-49+. Raising the
>    limit / exhaustive floor moves nothing. (Verify-reality saved a no-op build — see PRD.)
> 4. ~~**R4 query expansion**~~ ✅ **VERIFIED +3 (2026-07-10): subset90 81/90 (90.0%) → 84/90 (93.3%)** on the
>    SAME instrument. Blind LLM expansion (instance-vocabulary from the question ONLY, no data: "doctors"→
>    "dermatologist ENT cardiologist…") recovered retrieval coverage gold-doc 8/21→17/21, gold-session
>    17/18→18/18; harness evidAllDeep 73/90→80/90. Score flips matched the per-item prediction: WON model-kits,
>    bike-$, doctors, cocktail-pref; LOST 1 (dd2973ad — expansion noise pushed a gold session out of top-48).
>    Harness path: `LME_EXPAND_FILE` (question_id→terms), widens the RETRIEVAL query only; reader sees the real
>    question. **Production expansion needs a live LLM (deferred, same credit block as the reader).** Note:
>    semantic-embedder upside stays small — misses are lexical-counting, not paraphrase → BGE-M3 stays parked.
> 5. **Merge `fix-recall` → main** DONE. Controlled baseline (R1) still blocked on paid LLM / credit.

Companion to `prd-fix-recall.md` (the why). This is the what/who — each task has a deliverable, the files it
OWNS (so parallel workers don't clash), what it depends on, and its acceptance gate.

**Two hot files gate parallelism:** `oracle-lite/server.ts` and `src/run-longmemeval.ts` are each touched by
several tasks. Tasks that share a hot file must either serialize or run in worktrees and merge (auralis build
mode). The waves below are grouped so same-file tasks don't run concurrently.

Legend: 🔒 = owns a hot file (conflict risk) · ⚡ = isolated files (safe to parallelize) · ▶ depends-on

---

## WAVE 1 — R0 fix the instrument (SERIAL spine; must land before any recall number counts)

- **R0-1 · Debug why `AURALIS_SEMANTIC` doesn't embed** ✅ **DONE (ebe6146)**
  Root cause found: `embed()` silently falls back to the builtin char-trigram vector PER CALL when the
  sidecar hiccups, and `vectorAdd` disabled vectors for the WHOLE run on one LanceDB error — so a "semantic"
  run filled the d384 table with fake lexical vectors and searched like FTS, with zero signal. Under load it's
  worse: `learn` **awaits** the embed (server.ts:433), so a slow sidecar under concurrent ingest backs up and
  times out — the silent fallback hid it as a fast plausible number. (5th silent failure of the session.)

- **R0-2 · Observability guard** ✅ **DONE (ebe6146)** — count real-semantic vs builtin-fallback embeds,
  expose in `/api/stats`; the harness reads it after ingest and SCREAMS if <50% were real. vectorAdd skips a
  failed doc instead of disabling the whole run. A "semantic" number can no longer silently be trigram.
  *Remaining strict-abort (`ORACLE_SEMANTIC_STRICT` → exit) is optional polish.*

- **R2a-embed-queue · Make semantic actually engage at scale** 🔒server.ts ⚠️ **the real blocker, promoted from R2a**
  The instrument is honest now, but semantic still can't COMPLETE a benchmark run: `await vectorAdd` blocks
  learn on a slow single-process MiniLM sidecar → timeouts; fire-and-forget → concurrent LanceDB writes crash
  the oracle. Fix = an **embed QUEUE**: learn returns immediately (doc+FTS already searchable), a background
  worker batches sidecar `/embed` calls and **serializes** LanceDB writes; the harness settles/drains the
  queue before searching (read-after-write for vectors). Files: `oracle-lite/server.ts`, maybe
  `src/embed-sidecar.ts` (batch endpoint). Accept: a pooled-100 semantic probe COMPLETES with
  `[semantic] >90% real` and recall that **differs** from trigram. **This is now the prereq for R2b/R4 to matter.**

- **R0-3 · Recall probe: test + document as the ruler** ⚡ ▶R0-1
  Probe already built (`LME_PROBE_K`). Add one hermetic test (gold@k monotonic, abstention skipped); document
  in `prd-fix-recall.md` / README that recall changes are probe-first.
  Files: `test/lme-probe.test.ts` (new), docs. Accept: test green; probe is the documented recall gate.

*Wave 1 is ~one worker's sequential job (R0-1→R0-2 share server.ts + harness). R0-3 can run alongside.*

## WAVE 2 — R1 controlled baseline (SERIAL after R0; the honest metric) 🔒run-longmemeval.ts

- **R1-1 · full-context mode** — `LME_MODE=fullcontext`: feed all haystack turns to the reader, no retrieval.
  Files: `src/run-longmemeval.ts`. Accept: reproduces ~60–64 (GPT-4o) — matches the published full-context.
- **R1-2 · grep mode** — `LME_MODE=grep`: lexical top-k over raw turns, no memory layer.
  Files: `src/run-longmemeval.ts`. Accept: emits a grep baseline number.
- **R1-3 · three-way delta report** — one command prints memory vs full-context vs grep (same reader+judge).
  Files: `src/run-controlled.ts` (new) or a report block. ▶R1-1,R1-2. Accept: reproduces memory 53 < full-context 60–64.

*R1-1/2/3 all touch the harness → serialize (one worker) or split modes into a `src/lme-modes.ts` module first.*

## WAVE 3 — recall fixes (PARALLEL after R0+R1, if split across files; worktree the server.ts overlaps)

- **R2a · Stronger embedder** ⚡embed-sidecar.ts — swap MiniLM-L6 for a larger local ST model or a hosted
  embedding API (`text-embedding-3`), model/dim configurable. Files: `src/embed-sidecar.ts`, `.env.example`.
  Accept: sidecar serves the new model; standalone paraphrase test ("homegrown"↔"basil") separates >> 1.6%.
- **R2b · Vector-weighted hybrid fusion** ⚡rank.ts — the vector lane must not be drowned by FTS; weight it or
  union a dedicated semantic top-k before RRF. Files: `oracle-lite/rank.ts`. ▶R0. Accept: on the probe (post-R0),
  preference recall@12 rises from 0 with NO regression on user/knowledge-update.
- **R3 · Aggregation + temporal retrieval** 🔒server.ts+harness — (a) `mode=all` exhaustive route (every match
  above a floor); (b) real NL entity/event multi-query (fix `extractEntities` for NL, or use R4). Files:
  `oracle-lite/server.ts` (route), `src/run-longmemeval.ts`, `src/triplets.ts`. ▶R0. Accept: multi-session +
  temporal recall@12 rise; latency bounded. *Conflicts with R2b on server-side + R1/R4 on harness → worktree.*
- **R4 · Query expansion** ⚡query-expand.ts — cheap LLM (reuse `ApiRunner`) rewrites each question into
  synonym/entity/event queries, unioned before search. Files: `src/query-expand.ts` (new), one hook in
  `src/run-longmemeval.ts`. ▶R0. Accept: recall lift on preference/temporal beyond R2/R3 alone.

*Parallel-safe set: R2a (embed-sidecar) ∥ R2b (rank.ts) ∥ R4 (new module). R3 shares server.ts+harness → its own worktree.*

## WAVE 4 — measure + secondary (after Wave 3)

- **R5 · Re-measure** — R1 controlled delta + official 500-Q number with the winning config. Accept: memory > full-context.
- **R6 · Answer-model attribution** ⚡ — Claude-answer + official judge, and/or GPT-4o-answer w/ a tuned prompt. Accept: the −17 gap attributed.

## CARRIED-OVER (independent of recall — dispatch anytime)

- **C1 · Secret cleanup** ⚡ (do soon) — stop daemon → delete leaked-key docs from docs/docs_fts/edges → restart. See memory `auralis-secret-leak-followup`.
- **C2 · Ingress secret-scrub** ⚡session-capture.mjs — redact sk-*/ghp_*/tokens before learn (+ a test).
- **C3 · Lifecycle managed scheduling** ⚡ — wire `pnpm lifecycle` into the `auralis` CLI / a process manager.
- **C4 · Durability single-instance lock** 🔒server.ts — file/port lock before opening the brain.

## Parallel dispatch cheat-sheet

```
now:        R0-1 → R0-2  (server.ts+harness, one lane)      ∥  R0-3 ⚡  ∥  C1/C2/C3 ⚡ (independent)
after R0:   R1-1→R1-2→R1-3 (harness, one lane)
after R1:   R2a ⚡ ∥ R2b ⚡ ∥ R4 ⚡   (disjoint files — true parallel)   ;   R3 (worktree: shares server.ts+harness)
after W3:   R5 → R6
```
Rule: never run two 🔒-same-file tasks concurrently without a worktree. The ⚡ tasks are the real parallel wins.
