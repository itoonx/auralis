# auralis — Milestone #1: "Shared brain proven" ✅

A **mozaik** agent society whose shared memory is a persistent, append-only, auditable **brain**
instead of a disposable per-run memory. Point it at **any** codebase: two real Claude Code workers
analyse related aspects of it, share what they learn through the brain, and skip re-exploring what a
teammate already covered.

Example run (two workers analysing related aspects of a real codebase):

```
baseline: A=11 B=8 explored, cross-worker redundant = 1   (both re-read the shared core)
shared  : A=9  B=5 explored, cross-worker redundant = 0   (B skipped the shared core; reused A's findings)
redundancy reduction: 100%   ·   cross-worker reuse: yes  ·   total exploration 19 -> 14
```

## Project-agnostic
Nothing is hardcoded to a project. The target repo and the two worker questions come from the
environment (`AURALIS_PROJECT_DIR`, `AURALIS_TASK_A`, `AURALIS_TASK_B`), so the same harness runs
against any codebase.

## The shared brain is ours (`oracle-lite`)
`oracle-lite/server.ts` is a minimal, API-compatible brain — Bun + `bun:sqlite` FTS5, append-only.
The FTS write is synchronous, so a `learn` is immediately visible to a following `search`
(read-after-write). The `MemoryAdapter` interface keeps the brain swappable.

## Layout
- `oracle-lite/server.ts` — the shared brain: `POST /api/learn`, `GET /api/search`, `GET /health`
- `src/memory.ts` — `MemoryAdapter` + `OracleAdapter` + `NullMemoryAdapter` (baseline control)
- `src/runner.ts` — `ClaudeCodeRunner` (drives Claude Code via the Agent SDK; no API key) + `StubRunner`
- `src/participants.ts` — `Worker`, `Auditor` (mozaik bus + observer), `MemoryLibrarian`, `conductRun`
- `src/metrics.ts` — the redundancy measure
- `src/run.ts` — the live harness (auto-starts the brain; runs shared vs. baseline)

## Run it
```bash
pnpm test    # 4/4 — deterministic coordination proof + live read-after-write (auto-boots oracle-lite)

AURALIS_PROJECT_DIR=/path/to/any/repo pnpm dev   # live experiment over your chosen codebase
```
Prereqs: Node 20+, pnpm, Bun >= 1.2, Claude Code logged in (no API key needed). Config via `.env`
(see `.env.example`).

## Note
Two workers that partition a task cleanly share only a small core, so the baseline overlap can be
small; the reduction and reuse are directional. Choosing a task with more inherent overlap, run
several times, gives a more robust percentage — that hardening is Milestone #2+.
