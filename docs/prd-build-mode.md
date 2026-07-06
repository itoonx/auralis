# PRD — Build Mode: from analysing code to writing it

**Status:** proposed · **Pillar:** the analyze→build leap · **Test project:** rock-paper-scissors (RPS)
**Rule for this whole effort:** every claim is measured on a REAL run. The objective truth is binary —
*does the built game run and play correctly?* No seeded demos, no n=1 hand-waving.

## 1. The pivot

Today auralis coordinates agents that **read and analyse** a codebase. This makes them **write** one —
a small, verifiable program — with the same coordination guarantees. RPS is the test bed: small enough to
build in one fleet run, decomposable into disjoint files, and **objectively verifiable** (rock beats
scissors, etc. either holds or it doesn't).

## 2. Goals / non-goals

**Goals**
- The fleet produces a **working** RPS game (runs, plays correctly) on a real run.
- Parallel workers write **without clobbering** — coordination by construction, not merge.
- Everything is **measured from real execution**: a pass/fail acceptance check auralis owns, plus coordination
  and reliability metrics.

**Non-goals (v1)**
- No worktree-per-worker + merge. We avoid conflicts by construction (§4), we don't resolve them after.
- No giving workers a shell. **Workers write; auralis verifies.** (§6 — this is a safety decision, not just scope.)
- No network / package installs during a build. RPS is plain Node, zero dependencies.
- Not a general "build any app" claim — RPS proves the mechanism; scaling the task class is later.

## 3. Test project — RPS decomposition

Plain Node JS (no toolchain to flake). File-disjoint tasks so same-level workers never touch the same file:

```
T1  game.js       pure logic: beats(a,b), play(a,b) -> 'win'|'lose'|'tie', validate input   [level 0]
T2  cli.js        CLI loop + random opponent, requires ./game.js                             [level 1]
T3  game.test.js  asserts the logic (rock>scissors>paper>rock, ties, bad input)              [level 1]
```

T2 and T3 are the same level, **different files → written concurrently** = the claim-on-write proof. Both
depend on T1 and reuse its published **contract** (§5.3) = the shared brain proven on a build task.

> Watch-out (§7 #14): RPS decomposes *so* cleanly that coordination value is modest. The measurement (§8)
> therefore includes a no-coordination arm and one deliberately shared file, or the demo under-sells itself.

## 4. Core decision — write coordination

**claim-on-write + disjoint tasks**, not worktree isolation. Reuses the proven middle-layer claim registry;
the only change is *which tool the gate guards, and what a block means*:

| mode | claim gate guards | a block means |
|------|-------------------|---------------|
| analyse (today) | `Read` | "teammate already covered this — reuse their finding" (dedup) |
| build (new) | `Edit` / `Write` / `MultiEdit` | "teammate owns this file — do NOT write it" (anti-clobber) |

`Read` is **never** blocked in build mode — T2 must read T1's `game.js`. Ordering across files is the DAG's
job (T2 depends on T1, so T1 is done first); disjointness within a level is the claim's job.

## 5. What we build (each reuses an existing seam)

1. **Write mode flag** (`AURALIS_MODE=build`): workers get `Edit`/`Write` added to `allowedTools`
   (`runner.ts` already sets `permissionMode: "acceptEdits"`). **No `Bash` for workers** (§6).
2. **claim-on-write**: extend the `PreToolUse` matcher from `Read` to `Edit|Write|MultiEdit` in build mode;
   `resolveClaim` is unchanged. Deny message: "teammate owns this file."
3. **Contract publishing**: T1 publishes its module interface to the brain as a first-class **contract**
   finding (`exports play(a,b): 'win'|'lose'|'tie'`). T2/T3 pull it instead of guessing — the real
   coordination value in build is a **shared contract**, not avoided re-reads.
4. **Build planner prompt**: the Planner decomposes a build goal into **file-disjoint** tasks, names the
   owned file per task, and puts any genuinely shared file (package.json, a constants file) under a **single
   owner** or a final assemble task.
5. **Acceptance harness** (auralis-owned, independent): a fixed check that runs the produced game with known
   inputs and asserts known outputs. Separate from T3's worker-written tests, so a worker can't "pass" by
   writing `assert(true)`. This is the objective truth.
6. **Build workspace manager**: builds happen in a fresh, isolated, `git init`-ed scratch dir
   (`.auralis-build/rps/`, gitignored), reset between bench runs so diffs/metrics are clean and nothing
   touches the auralis repo.

## 6. Safety — workers write, auralis verifies

Running LLM-generated code is arbitrary-code-execution. v1 keeps blast radius small:

- **No shell for workers.** They only `Edit`/`Write` files. All execution (the acceptance harness) is run by
  auralis, not the worker — one controlled place to sandbox.
- **Path confinement.** Every write must resolve inside the workspace dir; a `Write` with an absolute or
  `../` path that escapes is denied (a second `PreToolUse` check).
- **Execution guardrails.** The acceptance harness runs the game as a subprocess with a hard **timeout**
  (kills infinite loops), inherits **no network** by convention, and runs cwd-confined to the workspace.
- **Honest limit:** this is confinement, not a true sandbox. A container/VM sandbox is the real answer and is
  out of v1 scope — noted, not hidden.

## 7. Edge cases & mitigations (the part to get right before coding)

| # | edge case | mitigation |
|---|-----------|-----------|
| 1 | Two tasks both need to write a **shared file** (package.json, constants) | Planner marks shared files **single-owner**, or a final assemble task; claim-on-write blocks the second writer anyway (fails loud, not silent) |
| 2 | Claiming a **new file that doesn't exist yet** | claim is on the path string, not the inode — first writer claims, works for create + edit alike |
| 3 | A worker must **read a file a teammate is still writing** (hidden intra-level dep) | DAG dependency forces ordering; the Planner must emit truly independent same-level tasks — validated by the acceptance harness catching integration breaks |
| 4 | Worker runs a **destructive/hanging shell command** | workers have **no Bash** in v1 (§6); execution is auralis-only, timed |
| 5 | Worker writes **outside the workspace** (abs / `../` path) | path-confinement `PreToolUse` check denies escapes (§6) |
| 6 | Build **pollutes the auralis repo** | dedicated `.auralis-build/` workspace, gitignored, reset per run |
| 7 | Generated code **hangs** the verify | subprocess hard timeout kills it → recorded as fail, run continues |
| 8 | Worker writes **trivially-passing tests** (`assert(true)`) | auralis's **independent** acceptance harness is the truth, not T3 |
| 9 | **Partial success** — game.js works, cli.js broken | per-file/per-task verify + one overall integration verdict; report both |
| 10 | **Non-determinism** — the AI opponent is random | acceptance checks the **deterministic core** (`play`/`beats`) with fixed inputs, never the random loop |
| 11 | **Self-repair needs to edit another task's file** | on repair, the retrying worker may re-claim the failing file (owner reassigned to it); cross-file repair is a follow-up, flagged if it happens |
| 12 | **Cold brain** on a single build — little to reuse | value is the **contract** (T1→T2/T3), not avoided reads; measure that, not analyze-style redundancy |
| 13 | T2/T3 **guess T1's interface wrong** → integration break | contract publishing (§5.3) makes the interface explicit in the brain; integration verify catches misses |
| 14 | RPS is **too easy to decompose** → coordination looks pointless | measurement (§8) runs a **no-claim arm** (show clobbers appear) and includes one shared file (show the block fires) |
| 15 | Each build **costs real tokens/time** | bench K=3–5, not 20; report cost/time honestly as part of the result |
| 16 | Units pass but **integration fails** (cli misuses game) | acceptance runs the **whole game end-to-end**, not just units |
| 17 | Worker **declares done without writing** (analyses instead of builds) | Critic grades build tasks on "the owned file exists and the acceptance check improves", not on answer text |

## 8. Measurement (real runs only)

**Primary — objective:** the acceptance harness returns **PASS/FAIL** for the whole game (correct RPS
outcomes + input validation + cli runs end-to-end). This is the headline. Nothing else matters if it's FAIL.

**Coordination:** write-redundant (did two workers write one file — should be 0), prevented-dupes
(claim-on-write blocks), contract-reuses (did T2/T3 pull T1's contract), timing, turns, self-repairs.

**A/B to make coordination legible (per §7 #14):**
- *coordinated* arm: claim-on-write ON.
- *free-for-all* arm: claim OFF → expect write-collisions / a broken/overwritten file on the shared-file case.
The delta is the coordination value, shown not asserted.

**Reliability:** build K=3–5 times → **success rate** (how often a working game comes out) + mean time/cost.

## 9. Phases (each ends in a real run)

| phase | build | real-run gate |
|-------|-------|---------------|
| 0 · baseline | point today's auralis at an empty dir, goal "build RPS" | observe: does it write anything or just analyse? (honest start) |
| 1 · write mode | mode flag, Edit/Write tools, claim-on-write, path confinement | fleet writes real files; prevented-dupes on write > 0 |
| 2 · verify loop | acceptance harness + Critic on build + self-repair | acceptance PASS/FAIL captured; failing tasks retried |
| 3 · contract | contract publishing + build planner prompt | T2/T3 pull T1's contract; integration passes |
| 4 · measure | A/B (claim on/off) + bench K runs | success rate, coordination delta, timing — real numbers |
| 5 · harden | only what the runs prove necessary (model routing / security / TTL) | measured before built |

## 10. Open questions

- **Assemble step:** is a final integration task needed, or is the acceptance harness enough? Start with
  harness-only; add an assemble task if integration fails repeatedly.
- **Bench cost ceiling:** K runs × real LLM. Cap K and report cost; don't silently burn budget.
- **Task class beyond RPS:** RPS proves the mechanism. A second, slightly harder project (e.g. a TODO CLI
  with persistence) is the next validation — out of this PRD.
