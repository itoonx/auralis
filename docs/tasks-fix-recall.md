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
> 6. ~~**R4 regression mitigation**~~ ✅ **FIXED (2026-07-10): union, not replace.** The proposed "gate expansion
>    to counting/multi-session types" was **REFUTED** — the loser (dd2973ad) and all 4 winners are the SAME
>    `multi-session` type, and a counting-pattern gate would trade **6 doc-coverage wins for 2 losses**
>    (net-negative; verify-reality caught it pre-build). Real mechanism, ground-truthed against the two bench
>    runs at DOC granularity (session-`some` over-counted — the entity lane kept a non-answer chunk so
>    session-coverage stayed 2/2 and hid it): feeding `question + terms` as ONE query REPLACED the ranking and
>    EVICTED a has_answer chunk the raw query already had — dd2973ad gold-doc BASE 2/2 → replace 1/2 → reader
>    said "I don't know" (baseline had answered "2 AM" correctly). Fix: run raw + expanded separately and
>    UNION (raw-48 base always kept, expansion-only docs appended, reader cap 48→96) → expansion can only ADD
>    evidence. Verified on the REAL edited harness (`LME_DUMP`, all 90): dd2973ad chunkHit/evidAll/goldStrShown
>    all TRUE (recovered); aggregate **evidAllDeep 82/90 ≥ replace 80 ≥ baseline 73** (monotonic, no
>    regression). Reader QA re-run (predicted ~85/90) PENDING — costs the Claude Code CLI reader.
>    File: `src/run-longmemeval.ts`.

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

## WAVE 2 — R1 controlled baseline (the thesis test: does the memory layer beat full-context?) 🔒run-longmemeval.ts

> **2026-07-10 — DISPATCH-READY, feasibility measured.** R1 is the one number that validates the whole
> project: literature says memory-augmented **loses** to full-context (our own official = 53.4%); until R1 we
> don't know if our memory beats naive dump-everything. **NOT blocked on credit** — the reader is the same
> Claude Code CLI subagent that already scored subset90 85/90; only the *official gpt-4o judge* needs OpenAI,
> and the internal 3-way delta doesn't use it (rule 11: same reader+judge across all three arms is what
> matters, not which judge). **Feasibility (measured on subset90):** haystacks are ~118–128k tok; **all 90
> fit a Claude 200k reader (<180k) with NO truncation** — so our full-context is *cleaner* than the published
> GPT-4o number (128k fits only 10/90 → they truncate 80). **The one real cost:** the full-context arm feeds
> ~122k tok × 90 ≈ **11M input tok** on the CLI reader (memory/grep arms ~20k/q, 5–6× cheaper) → **pilot
> first, don't run 90×3 blind.**

Three arms, ONE instrument (same reader prompt template + same 6-type judge + same goldPrecheck), same
subset90 so it's directly comparable to memory's 85/90:

- **R1-0 · Feasibility** ✅ **DONE (2026-07-10)** — token-size probe: all 90 fit 200k, no truncation needed.
- **R1-1 · full-context mode** ✅ **BUILT (2026-07-10)** — `LME_MODE=fullcontext`: skip the oracle entirely;
  render EVERY haystack turn in chronological order with the same `[said DATE]` tags the memory arm uses, into
  the same reader prompt. Files: `src/run-longmemeval.ts` (early branch in runOne + shared `composeAnswer`).
- **R1-2 · grep mode** ✅ **BUILT (2026-07-10)** — `LME_MODE=grep`: lexical top-96 turns by question-word
  overlap over RAW turns — no chunking/edges/RRF/entity/expansion (isolates "does the memory LAYER beat dumb
  keyword match?"). Same reader. Files: `src/run-longmemeval.ts`.
- **R1-3 CORRECTION (2026-07-10, same day — verify-reality caught it while measuring the token budget):**
  ⚠️ **The "full-context" arm below is INVALID and its token-benefit headline is RETRACTED.** Measuring actual
  per-query token consumption (from the reader-agent transcripts) revealed the full-context reader NEVER
  ingested the 125k haystack: the excerpts were delivered via a **Read tool that caps large files** (a 4,661-line
  / 519KB file returns "197 chars, specify a range" on the first Read), so the agent fell back to **Bash grep +
  offset-Read** — 0/60 full-context agents saw >60k of context (avg 33.5k actual). So "full-context" was really
  *agentic file-search*, not full-context. Consequences: (a) the **81/90 full-context accuracy is mislabeled**
  (it's agentic-grep, not true full-context — true full-context accuracy is UNMEASURED); (b) the **"memory is
  12.9× cheaper / Pareto-superior / 13.4× more efficient" claims are RETRACTED** — they paired memory's real
  in-context 9.1k against full-context's *file size* (117k), which the reader never actually consumed. What
  STANDS: **memory 84/90 is valid** (9.1k excerpts, small enough that Read didn't truncate → fully in-context).
  grep (52k) was ALSO partly truncated → also confounded. **Fix in progress: a full-ingestion reader (chunked
  parts, read-all) so every arm truly ingests its excerpts and token usage reflects true cost, then re-run.**
  The mistake was mine: I asserted token cost from *file size* (a HYPOTHESIS) instead of verifying *actual
  consumption* (rule 1: assert the outcome, not the call) — the 6th silent failure of the project.

- **R1-3 RE-MEASURED with TRUE full-context (2026-07-10) — full-ingestion reader (excerpts split into 500-line
  parts, reader reads EVERY part, no grep; verified: 15/15 agents ingested >100k of real context, avg 214k incl.
  cache).** On the 15 multi-session questions: **memory 13/15 = TRUE full-context 13/15 (TIE)** — they trade one
  win each (memory wins 0a995998 counting where true-full miscounts even with everything; true-full wins
  c4a1ceb8 where memory's retrieval dropped the "lemon" evidence; both miss 6d550036, gold=2 ambiguous). The
  grep-based "full-context" scored 12/15 — its losses (e.g. gpt4_d84a3211 bike-$: grep-full $65 WRONG vs
  true-full $185 CORRECT) show the earlier "memory beats full-context by 4" was largely a **grep-truncation
  artifact**, now retracted. **CORRECTED token benefit (verified actual consumption, not file size): memory
  matches true full-context accuracy at ~13-14× fewer tokens (9.1k vs ~125k).** The honest thesis: the memory
  layer is a **token optimization that PRESERVES accuracy** (≈ full-context) at ~1/13 the cost — not "higher
  accuracy AND cheaper". STILL OPEN: preference wins (0edc2aef, 75832dbd) not yet re-tested with true full
  ingestion (may also flip). Artifacts: `scratchpad/r1pilot/ans_fulltrue/`, `r1_fulltrue_wf.js`.

- **R1-3 · three-way delta report** ⚠️ **SUPERSEDED BY THE CORRECTION ABOVE — full-context invalid.** FULL 90×3 (2026-07-10, uniform 90-agent judge panel).
  **memory 84/90 (93.3%) · full-context 81/90 (90.0%) · grep 54/90 (60.0%).** memory ≥ full-context on **89/90**
  questions (mem-wins-4, full-wins-1). **BENEFIT (the token-optimization headline):** measured token cost —
  memory **9.1k** tok/q, full-context **117.6k** (12.9×), grep 52.4k (5.7×). memory is **Pareto-superior**:
  +3.3pp accuracy AND 12.9× fewer tokens → **13.4× more correct answers per token**; higher accuracy at **7.8%**
  of full-context's token cost. The memory layer IS a token optimization (117k→9k, −92%, accuracy UP). memory's
  4 wins are all lost-in-the-middle on multi-session/preference (full has the info, drowns in 122k); its 1 loss
  (c4a1ceb8) is an honest retrieval miss full-context's completeness caught. 5 all-3-wrong (3 temporal
  date-arithmetic + 1 un-retrievable "Target" + 1 ambiguous count) are shared by full-context → residual is
  reader/temporal, NOT the memory layer. Self-judge (not official gpt-4o) → relative deltas valid, absolute not
  comparable to 53.4%. Artifacts: `scratchpad/r1pilot/RESULT90.md`, `verdicts90.json`. **THESIS HOLDS — memory
  beats full-context, against the literature.** Next: token optimization WITHIN the 9k memory budget.

**Execution order (cost-guarded):** R1-1 + R1-2 build (cheap, ~1 worker, share the harness → serialize) →
**PILOT: 6 Qs (1/type) or the 15 multi-session across all 3 arms** → read the DIRECTION → only then decide
whether the full 90×3 (esp. the 11M-tok full-context arm) is worth tightening the number. *R1-1/2/3 all touch
the harness → serialize, or split modes into `src/lme-modes.ts` first.*

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
