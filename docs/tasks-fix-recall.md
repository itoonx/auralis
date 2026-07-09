# Task breakdown — Fix Recall (dispatch-ready)

Companion to `prd-fix-recall.md` (the why). This is the what/who — each task has a deliverable, the files it
OWNS (so parallel workers don't clash), what it depends on, and its acceptance gate.

**Two hot files gate parallelism:** `oracle-lite/server.ts` and `src/run-longmemeval.ts` are each touched by
several tasks. Tasks that share a hot file must either serialize or run in worktrees and merge (auralis build
mode). The waves below are grouped so same-file tasks don't run concurrently.

Legend: 🔒 = owns a hot file (conflict risk) · ⚡ = isolated files (safe to parallelize) · ▶ depends-on

---

## WAVE 1 — R0 fix the instrument (SERIAL spine; must land before any recall number counts)

- **R0-1 · Debug why `AURALIS_SEMANTIC` doesn't embed in the harness** 🔒server.ts
  Reproduce: semantic probe == trigram + 28s wall = corpus never embedded. Find the break (sidecar spawn
  timing in the harness / oracle best-effort embed silently failing / ingest not calling the sidecar).
  Files: `oracle-lite/server.ts` (embed path 257–335), `src/run-longmemeval.ts` (sidecar spawn 217–225).
  Accept: a semantic probe writes real 384-d vectors (lancedb doc count > 0) and its recall **differs** from trigram.

- **R0-2 · Embed-or-fail-loud guard** 🔒server.ts ▶R0-1
  When `ORACLE_EMBED_URL` is set but the sidecar/embedding fails, do NOT silently fall to builtin — loud
  error + refuse under a strict flag (`ORACLE_SEMANTIC_STRICT`). Harness: after ingest, assert
  `/api/stats` shows embedder=semantic + vectors>0 when `AURALIS_SEMANTIC=1`, else abort.
  Files: `oracle-lite/server.ts`, `src/run-longmemeval.ts`. Accept: a broken sidecar aborts the run, never
  produces a silent trigram-in-disguise number.

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
