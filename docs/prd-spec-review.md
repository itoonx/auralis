# PRD — Spec-driven tasks + an objective review gate

**Status:** proposed · **Motivation:** external feedback (a "baro"-style pipeline: plan → stories → tasks,
a spec per unit, and a reviewer at every step that sends failing work back).
**Rule (unchanged):** every claim is measured on a REAL run.

## 1. The feedback, mapped to what we already have

| the feedback wants | auralis today | the gap |
|---|---|---|
| a **spec** per unit + validate the output against it | acceptance harness (`pnpm accept`) — independent, objective | the spec is **hand-authored per project**, not attached to a task; only end-of-run, not per task |
| a **reviewer at every step**, reject → rework | `Critic` + self-repair (reject → retry, `maxRetries`) | the Critic is **shallow** (empty / too-short / stopped-early) — it doesn't check "does this meet the spec" |
| **plan → stories → tasks** | plan → tasks (a DAG) | no stories layer |

So the reject→rework loop and end-validation **already exist**. This PRD makes them **spec-driven and
per-step**, not new machinery.

## 2. Adopt / upgrade / defer

- **ADOPT — a spec per task.** The Planner emits, with each task, an **acceptance check** authored *before*
  any worker runs. Attaching the spec to the task makes validation general (not hand-coded per project).
- **UPGRADE — the review gate.** After a task's worker finishes, run **its** acceptance check; on failure,
  rework with the failure as concrete feedback, and **block dependents until it passes** (or retries run out).
  This is the existing self-repair loop with an objective check swapped in for the shallow heuristic.
- **DEFER — the stories layer.** On small builds (RPS passed 3/3 with none) stories add ceremony, not
  measurable value. Keep plan → tasks; add an optional story grouping only when a goal is big enough to need
  story-level acceptance and parallel boundaries (§10). *ponytail: don't pay for ceremony until it earns its keep.*

## 3. Core idea — the Planner writes the check, the worker writes the code, the reviewer runs it

The strongest, most auralis-native form of "reviewer at every step":

1. **Plan time** — for each task the Planner produces *(a)* what to build and *(b)* a small, runnable
   **acceptance check** the output must pass (e.g. `require('./game.js').play('rock','scissors') === 'win'`).
2. **Build time** — the worker writes the file. It never sees or edits the check.
3. **Review time** — the Conductor runs the check in a sandboxed subprocess. **Pass** → dependents proceed.
   **Fail** → the failure text becomes the rework feedback; retry up to `maxRetries`; still failing → mark
   the task failed, surface it, and continue (fail-forward, not deadlock).

This is TDD's separation of concerns applied to a fleet: the *test* is authored independently of the
*implementation*, so a worker can't pass by grading its own homework.

## 4. Design (reuse every existing seam)

- **Spec on the task** (`src/dag.ts`): `DagNode` gains `acceptance?: { run: string; expect?: "exit0" | string }`
  — `run` is a `node -e` / shell snippet executed in the workspace; `expect` is exit-0 (default) or a stdout
  regex. Optional: a task with no check (pure analysis) skips the gate.
- **Planner** (`src/planner.ts`): the build-planner prompt also emits the `acceptance` snippet per task.
- **Reviewer** (`src/conductor.ts`): replace/augment the `Critic` — after `worker.run`, if the node has an
  `acceptance`, run it (reusing the subprocess runner from `src/accept.ts`); the verdict drives the existing
  self-repair loop. No acceptance → fall back to the current heuristic Critic (or an LLM review for prose).
- **Check runner** (`src/accept.ts`): factor its "run a snippet in the workspace with a timeout" into a
  reusable function the Conductor calls per task; the end-of-run `pnpm accept` stays as the whole-program
  gate on top.

## 5. The auralis edge over an LLM reviewer

- **Objective, not opinion.** A baro-style reviewer is an LLM judging prose — subjective and gameable. Ours
  *runs the code against a check*. Review becomes "measured, not asserted", same ethos as the rest of auralis.
- **Independence preserved.** The check is authored at plan time and frozen; the worker can't see or modify
  it. Contrast with a worker writing its own tests (`assert(true)` passes).
- **Cheap.** A check is a subprocess (ms), not a `worker.run` (~50s). The expensive part is the *rework*
  (re-running a worker), so retries are capped.

## 6. Guardrail — review must not become the bottleneck

Timing proves `worker.run` is 99.9% of wall. So:
- The gate is **deterministic-first**: run the code/check (free). Escalate to an **LLM review only** when a
  criterion isn't machine-checkable (prose, "reads clearly"), and flag those as subjective.
- **Cap rework.** `maxRetries` already bounds it; a failing task fails forward with its check output, it does
  not spin. "Reviewer at every step" must not mean "an LLM call at every step."

## 7. Edge cases & mitigations

| # | edge case | mitigation |
|---|-----------|-----------|
| 1 | Planner writes a **wrong/too-strict check** → the worker can never pass | cap retries → fail-forward + surface the check for a human; the end-of-run `pnpm accept` still validates the whole program |
| 2 | A check **needs files from other tasks** (cli check needs game.js) | the DAG orders it (cli reviewed after game); the check runs in the workspace with deps present |
| 3 | **Non-code criterion** ("readme is clear") | LLM review fallback, flagged subjective — not counted as an objective pass |
| 4 | **Loose check** passes bad code | the whole-program `pnpm accept` is the backstop; per-task checks are the first net, not the only one |
| 5 | Dependency keeps failing → **DAG stalls** | fail-forward: mark failed, run independent branches anyway, report which task blocked what |
| 6 | Pure **analysis task** (no runnable output) | `acceptance` optional; falls back to the heuristic/LLM Critic as today |
| 7 | Review **cost blows up** | deterministic checks only (subprocess); LLM review gated to non-code criteria; retries capped (§6) |
| 8 | Planner **omits the check** for a task that needs one | worker still builds; the whole-program gate catches it end-to-end — degraded, not broken |

## 8. Measurement (real runs only)

- **RPS already passes 3/3**, so per-task review shows **no gain there** — that's the honest baseline.
- Measure on a **harder build** where an early task can plausibly be wrong (e.g. a task with a subtle
  contract). Compare **review-gate ON vs OFF**: expect the gate to catch a bad early file *before* dependents
  build on it, turning a cascade failure into one caught+reworked task. Metrics: acceptance PASS-rate,
  tasks-reworked, cascade failures avoided, extra wall from rework.

## 9. Phases (each ends in a real run)

| phase | build | real-run gate |
|-------|-------|---------------|
| 1 · spec on task | `DagNode.acceptance`; Planner emits a check per build task | tasks carry runnable checks |
| 2 · review gate | Conductor runs each task's check → drives self-repair; fail-forward | a deliberately-wrong early task is caught + reworked, not cascaded |
| 3 · measure | review ON vs OFF on a harder build; bench | rework/cascade numbers, honest |
| 4 · stories (optional) | Planner groups tasks into stories for a big goal only | only if a goal is big enough to need it |

## 10. Stories — deferred sketch

For a large goal the Planner would emit `plan → stories → tasks`: a story is a user-facing capability with
its own acceptance (all its tasks pass + an integration check). It buys clearer parallel boundaries and
capability-level PASS/FAIL. Skipped in v1 because RPS/TODO don't need it and it multiplies planning ceremony;
revisit when we build something with several independent capabilities.

## 11. Open questions

- **Check authoring quality:** can the Planner reliably write good checks? Measure the false-pass / false-fail
  rate on real runs before trusting the gate over the whole-program harness.
- **Analyze-mode review:** for read tasks the "check" is "does the finding address the question" — LLM-only,
  subjective. Worth it, or leave analyze on the heuristic Critic? Decide from a real analyze run.
