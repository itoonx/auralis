# auralis — a coordinated agent society with a shared brain

Multiple **Claude Code workers** analyse a codebase as a society: a **Planner** decomposes one goal
into a small dependency graph of subtasks, a **Conductor** walks it, each worker's findings land in a
persistent shared **brain**, and later workers reuse them instead of re-exploring what a teammate
already covered. A reactive **Sentry** flags overlapping work live on the bus.

Built on **mozaik** (the coordination substrate); the brain is our own **oracle-lite** (Bun +
bun:sqlite FTS5, append-only). Works against **any** codebase — target repo, goal, and tasks all come
from the environment.

## Milestones
- **#1 Shared brain proven** — two workers share knowledge through the brain, beating a
  no-shared-memory baseline on redundant work.
- **#2 Coordinated society** — a Planner-decomposed DAG + reactive coordination. Example live run
  (3-task fleet, shared brain vs. baseline):
  ```
  baseline: fleet-redundant = 17, sentry overlap warnings = 17
  shared  : fleet-redundant = 8,  sentry overlap warnings = 8, reuses = 2
  redundancy reduction: 52.9%   ·   cross-task reuse: 2
  ```

## Pieces
- `oracle-lite/server.ts` — shared brain: `POST /api/learn`, `GET /api/search`, `GET /health` (synchronous FTS -> read-after-write)
- `src/dag.ts` — dependency-graph levels + cycle detection
- `src/planner.ts` — decomposes a goal into a DAG (tolerant JSON parse, degrades gracefully)
- `src/participants.ts` — `Worker`, `Auditor` + reactive `Sentry`, `MemoryLibrarian`
- `src/conductor.ts` — `coordinate`: walk the DAG, pull-before / push-after the brain
- `src/runner.ts` — `ClaudeCodeRunner` (Agent SDK, no API key) + `StubRunner`
- `src/metrics.ts` — pairwise + fleet redundancy measures
- `src/run.ts` — the live fleet harness (auto-boots the brain)

## Run
```bash
pnpm test                                    # deterministic proof (11 tests) + live read-after-write
AURALIS_PROJECT_DIR=/path/to/repo pnpm dev   # live fleet over your codebase
```
Prereqs: Node 20+, pnpm, Bun >= 1.2, Claude Code logged in (no API key). Config via `.env` (see `.env.example`).

## Note
Reduction depends on task overlap and how compliantly agents reuse injected findings; the
deterministic tests prove the mechanism, the live numbers are directional.
