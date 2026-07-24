# PRD — Gate-first generated verifier: an objective check per build, not 4 canned specs

Date: 2026-07-24 · Status: prototype built + measured (`src/gate.ts`, scratchpad/gate-experiment.mts);
milestones below not started · Basis: adopted from disler/fusion-harness `/auto-validate` (memory
`fusion-harness-adopt`). Build on the existing acceptance seam (`src/accept.ts runAcceptance`,
`src/build.ts buildWithRework`), not a new mechanism.

## The problem, measured

Auralis build mode verifies work against **4 hardcoded specs** (`src/accept.ts`: rps/todo/restapi/calc). Any
other build request gets only the LLM critic — and the critic grades the worker's **prose report**
(`src/critic-llm.ts` GRADE reads `result` text), never the files. Measured 2026-07-24 (real gpt-5.6-sol
critic vs a generated gate, 4 fizzbuzz builds, known truth): **gate wrong 0/4, critic wrong 1/4.** The gate's
edge is **structural, not intelligence** — a strong code-reading critic tied the gate on code-visible bugs,
but on `report-lies` (report claims correct code, disk has the bug) the critic passed it 3/3 while the gate
executed the disk and caught it. In production the worker reports a *summary*, not code
(`src/participants.ts` build prompt), so report≠reality is the **common** case → the gate is the only thing
that verifies the real artifact. It is also the objective verifier the autonomous path needs
(`[[souls-agent-team-design]]` / memory).

## Non-goals

- **Not replacing the LLM critic** — analyze-mode tasks have no executable artifact and still need it. The
  gate is for BUILD tasks (something you can run/inspect).
- **Not a new runner/config mechanism** — reuse `resolveRunnerSpec` (architect writes the gate) and the
  existing build/rework loop.
- **Not the autonomous loop itself** — that's M7 / the S4 bridge, gated last.

## What already exists (prototype, tested)

`src/gate.ts`: `generateGate(request, cwd, run)` (architect writes a Node gate script), `runGate(script, ws)`
→ `{pass, malformed, passLines, failLines}`, `gateInvalidReason(script)` (syntax + baseline-must-go-red).
Self-check + typecheck pass. NOT wired into build.ts. Two reliability facts the measurement surfaced: a
generated gate can **crash** (undefined var / leaked prose) and gate-gen can hit an **SDK turn-cap throw** —
both must be handled (M2).

## Milestones — each ships a real, runnable test

| # | Milestone | Real test (the gate on the milestone itself) |
|---|---|---|
| **M1** | **Land the module + unit tests.** `test/gate.test.ts`: baseline-red, malformed-crash detection, PASS/FAIL parse, `gateInvalidReason`. Commit `src/gate.ts`. | `pnpm test` green incl. new gate tests |
| **M2** | **Reliable gate generation.** Move the experiment's validate+retry into `generateValidGate(request, cwd, run, {tries})` in gate.ts: generate → `gateInvalidReason` → retry on invalid/throw; fix the architect turn-cap (bump gate-gen `maxTurns`, or a dedicated gate runner spec). | measure valid-on-attempt over ≥10 varied tasks; report the rate |
| **M3** | **Wire into build mode (opt-in).** `buildWithRework` (`src/build.ts:26,35,68`) takes an optional `gate` alongside `accept`: if set, generate the gate BEFORE the build, assert baseline-red, run it after each attempt instead of/alongside `runAcceptance`. MCP `build` tool + `run.ts` expose it. Fall back to the 4 fixed specs. | one **real end-to-end fleet build** on a non-canned task, gate gen→red→build→green |
| **M4** | **Structured FAIL → rework feedback.** `src/conductor.ts:104` today feeds a soft "reviewer rejected (reason)". In gated build mode, feed the gate's `failLines` verbatim (expected/found/at/fix). | a build that fails round 1 fixes the RIGHT thing round 2, fewer rounds than the soft-feedback baseline |
| **M5** | **Triage + one gate self-repair** (fusion's guard). After K fails, a diagnostician reads real state (not the worker's claims); if the gate itself is defective it repairs it ONCE (old kept, re-run free, checks never weakened). | a deliberately over-strict gate → triage repairs → loop ends green without weakening a real check |
| **M6** | **Gate-vs-critic benchmark** (mean±spread, the bench discipline from `docs/roadmap.md`). Generalise the experiment: N tasks × {correct, planted-defect, report-lies} → false-accept rate (gate vs critic), gate-gen reliability, cost/build. | `pnpm bench-gate` produces a distribution, not n=1 |
| **M7** | **(stretch) S4-bridge: scoped autonomous build-with-gate.** Now that green is objective, an unattended loop can safely stop. Budget + no-progress killer + human checkpoint (per `[[souls-agent-team-design]]`), on ONE real recurring task. | point at a real small task, run unattended with a token budget; measure delegated-success + cost vs doing it by hand |

## Task breakdown (M1–M3 — the "run it full-scale" core)

- **M1** · add `test/gate.test.ts` (4 cases above, deterministic, no LLM) · commit gate.ts + tests.
- **M2** · extract `generateValidGate` (retry on `gateInvalidReason` or throw, cap N, log attempts) · fix
  gate-gen turn budget (the claude text runner throws "max turns (1)" on long gates — give gate-gen its own
  spec/turns) · a tiny reliability probe over a fixed task list.
- **M3** · extend `FleetCfg`/build opts with `gate?: {request}` · in `buildWithRework`: generate+validate
  gate before the loop, `runGate` after each attempt, merge with/replace `runAcceptance` · thread through
  `src/run.ts` and `src/mcp-server.ts` build tool (new optional `gate` arg) · **the real end-to-end run.**

## Risks (measured or named)

| Risk | Mitigation |
|---|---|
| Generated gate crashes / leaks prose (SEEN in v1) | `gateInvalidReason` (syntax + baseline-red) + retry; never trust an unvalidated gate |
| Gate-gen hits the model turn-cap (SEEN once) | retry-on-throw + a dedicated gate-gen turn budget (M2) |
| A gate too STRICT fails correct work | baseline-red proves it can fail; M5 triage repairs a defective gate ONCE, forbidden to weaken real checks |
| A gate too WEAK passes wrong work | baseline MUST fail red (a gate green on an empty project is rejected) |
| Only helps BUILD tasks | scope: analyze mode keeps the LLM critic; the gate is opt-in per build |
| Extra architect call per build | same cost shape as the planner; only on gated builds |

## Open questions

1. **Gate language:** Node (matches auralis, done) vs fusion's PEP723 uv-python (auralis has python via the
   bge-sidecar). Node keeps it dependency-free; revisit only if a task needs python-only checks.
2. **Replace or augment the 4 fixed specs?** Keep them as fast deterministic fallbacks, or regenerate a gate
   even for rps/todo? Decide at M3 — leaning keep-as-fallback (they're proven + free).
3. **Does M4's structured feedback help enough to measure?** M6's bench should A/B soft-vs-structured feedback
   on rework rounds before committing M4 as default.
4. **M7 autonomy scope** — which real recurring task, whose budget, what checkpoint cadence. Decide when M1–M6
   are green (don't front-run the verifier the autonomous loop depends on).
