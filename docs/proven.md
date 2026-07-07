# Proven on live runs

Every claim below was measured on real Claude Code runs (over auralis's own codebase), not asserted. The
numbers are real but **directional** — each is from a single non-deterministic run.

| What | Result |
|---|---|
| **Agents share instead of repeat** | redundant re-reads → **0**; files opened 19 → 14 |
| **They coordinate as a team** | 3-task run, redundant work fell **53%** (17 → 8) |
| **Memory outlives the session** | separate process recalled prior findings, opened **1** file where a cold run opened **9** |
| **Works on any codebase** | pointed at Express (one env var, no code change) — still cut redundant work ~two-thirds |
| **Real-time sharing** | live pushes 6, teammate pulled & hit 4/6, redundant reads 4 → **0** |
| **Deterministic dedup** | 3-worker parallel run, **prevented-dupes = 4**, read-redundant = 0 |
| **Prod mode is ~2× faster** | skip the A/B baseline arm: 398s → 219s (~45%) |
| **Coordination overhead is negligible** | `oracle.claim` mean **2.4ms** vs `worker.run` = 99.9% of wall |
| **The brain refines & connects** | distillation collapsed two sign-in notes into one vetted finding; graph recall pulled a `SessionToken` finding into a *login* query via a shared `auth/session.ts` node (recall 1 → 2) |
| **Build mode is reliable** | built a working rock-paper-scissors game **3/3** runs (acceptance PASS each; baseline analyse-mode wrote **0** files) |
| **Claim prevents clobbers** | two workers forced onto one file — claim ON: **prevented-clobbers=1**, collisions=0; claim OFF: **collisions=1** |
| **Build mode generalises** | pointed at a *different* project it built a working TODO CLI (add/list/done/rm + persistence) — acceptance PASS, no code change |
| **Real multi-file projects** | built a 3-file REST API (store/router/server, interfaces agreed via the brain, reuses=2) and an expression-evaluator CLI (lexer→parser→cli) — both first-try PASS, verified independently incl. a server-restart persistence check |
| **Closed loop recovers from real failure** | goal forced attempt #1 to FAIL acceptance ("in-memory only" vs a persistence check) → rework read the fail lines → attempt #2 PASS |
| **Ranking boosts earn their place** | A/B bench: plain relevance **25%** → full ranker **75%** precision@1; guardrail held (trust may not override relevance). The bench caught 2 real bugs before shipping |
| **Workers credit what helped** | real analyze run: **cites=4 unprompted** — the synthesis worker cited the 3 level-1 findings it built on; cited docs measurably rank up |
| **Memory is poison-guarded** | a dead run (API credit $0) tried to store "Credit balance is too low" as a finding claiming files were covered — critic rejected it, nothing was captured, no retro written |
| **Temporal recall answers "when"** | timeout changed 30s→60s on June 1st: NOW ranks 60s first; `as_of` March returns only 30s; `as_of` July returns only 60s |
| **The sleep job judges for real** | live loop: a near-duplicate pair superseded mechanically; a genuine 10min→30min contradiction classified by the LLM and the stale fact invalidated with the reason recorded — after an atomic pre-mutation snapshot |
| **Workers self-narrate completely** | a replayed run shows plan → every tool step → findings → acceptance verdicts → reworks → summary, with no silent gaps |
| **Session capture is pollution-proof** | fleet-worker prompts and harness payloads stand down from the hooks; a worker prompt that briefly landed as a trust-1.0 memory is what proved the guard necessary |

## Honest notes

- **The live numbers are directional.** Each headline figure is from a single non-deterministic run — real,
  but they'll vary with how much the tasks overlap and how faithfully the agents reuse what they're handed.
  `pnpm bench` turns any one of them into a mean ± spread; the deterministic tests (50, in CI) pin down the
  *mechanisms*, not the magnitudes.
- **The heuristic paths are shallow by design.** Distillation clustering, graph extraction, and the Critic
  each ship a free deterministic heuristic and an optional Claude Code path (`*_LLM=1`) for real quality.
  The heuristics keep everything offline-safe and CI-green; reach for the LLM path when the output matters.
- **Build mode is proven small, not scaled.** The fleet builds working programs (rock-paper-scissors 3/3, a
  TODO CLI) and an objective harness PASS/FAILs them — but on small, cleanly-decomposable projects with
  disjoint files, over a handful of runs. Overlapping-file edits/merges and a true execution sandbox (v1 is
  confinement, not a sandbox) are still ahead — see [roadmap.md](roadmap.md).
