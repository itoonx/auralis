# auralis

[![CI](https://github.com/itoonx/Auralis/actions/workflows/ci.yml/badge.svg)](https://github.com/itoonx/Auralis/actions/workflows/ci.yml)

**A team of AI agents that explore a codebase together — and remember what they learn.**

Point auralis at any repository and it spins up a small society of Claude Code agents to analyse it.
One agent breaks your question into subtasks, others investigate, and — the important part —
everything they discover is written to a shared memory that *persists*. The next agent, and even
tomorrow's session, builds on that memory instead of starting from a blank page.

Most multi-agent setups are amnesiacs: every run starts cold, agents re-read the same files, and
nothing carries over. auralis is built around the opposite idea — a persistent, auditable shared
brain — and the payoff is measurably less wasted work.

## The idea

When you run several AI agents on the same codebase, two things go wrong:

- **They redo each other's work.** Agent A reads the core modules; Agent B reads them all over again,
  because it has no idea A already did.
- **They forget everything.** Close the session and all that hard-won context is gone — tomorrow's
  run re-derives it from scratch.

auralis fixes both by giving the agents a **shared brain** (a small, persistent memory) plus enough
**coordination** that they hand findings to each other instead of stepping on each other's toes. And
because trust matters, the brain is **append-only and auditable**: nothing it learns is ever silently
deleted, and every run can explain *why* it produced what it did.

## How it works

auralis runs its agents as a **society** on the [mozaik](https://github.com/jigjoy-ai/mozaik) runtime —
participants that react to each other on a shared event bus, rather than following a fixed script.

- **Planner** turns your one-line goal into a small **dependency graph** of subtasks — a few exploration tasks feeding a final synthesis.
- **Conductor** walks that graph in order. Before each task it *pulls* relevant knowledge out of the
  brain; after each task it *pushes* the new findings back in.
- **Workers** are real Claude Code agents (via the Agent SDK — no API key, it reuses your existing
  login). What they read and search *is* their record of work.
- **MemoryLibrarian** is the bridge to the brain: it injects what's already known before a worker
  starts, and captures what it found afterwards.
- **Sentry** watches the bus and flags, live, when two workers wander into the same territory.
- **Critic** grades each answer and quietly retries the weak or cut-off ones, so a worker that hits its turn limit doesn't poison the shared brain with a half-finished note (self-repair).
- **Auditor** records everything, so any run leaves a readable "why did it do that?" trail.

The brain itself is **oracle-lite** — a tiny local service (Bun + SQLite full-text search). It's
persistent, append-only, and fast enough that a finding is searchable the instant it's written.

## The hard part isn't the model — it's the shared state

Run one agent and it's easy. Run a *fleet* and you've quietly built a small distributed system: a
dozen agents touching the same repo, and the whole thing lives or dies on the orchestration around
them, not on which model is doing the typing.

The classic trap is *accidental* shared state. Give each agent its own isolated worktree and you may
find it can no longer see the `node_modules` — or the context, or the findings — that a sibling just
produced. Isolation quietly removed the shared state everyone was leaning on, and it "worked on my
machine" right up until it didn't.

auralis takes the opposite stance: **shared state is explicit and persistent, never accidental.**
Every agent reaches the same brain over HTTP and gets the same answer — whether it's isolated, in a
separate process, or running tomorrow. Nothing important hides in a folder that isolation can silently
take away. And coordination is reactive: the Sentry calls out when two agents wander into the same
territory, and the Conductor hands each one what its predecessors already found.

*Scope, honestly:* today auralis coordinates agents that **read and analyse** a codebase. Parallel
**writing** — worktrees, clean merges, no lost work — is the adjacent problem it's built to grow into,
not one it claims to have solved yet.

## What it can do — proven on live runs

Every claim below was measured on real Claude Code runs (over auralis's own codebase), not asserted.

- **Agents share instead of repeat.** Two workers analysing related things used to both re-read the
  shared core; with the brain, the second one skips it. Redundant re-reads dropped to **zero**, and
  total files opened fell from 19 to 14.
- **They coordinate as a real team.** The Planner splits a goal into a dependency graph and workers
  run against it while the Sentry flags overlaps live. On a 3-task run, redundant work fell **53%**
  (17 → 8).
- **Memory outlives the session.** Seed the brain in one process, then open a *completely separate*
  process for a related task: it recalled the earlier findings and opened just **1 file** — where a
  cold run with no memory opened **9**.
- **Nothing is lost, and everything is explainable.** Outdated findings are *superseded* (flagged but
  still searchable), never deleted — there's no delete route at all — and every run writes a
  provenance trail of what each task recalled, explored, produced, and contributed.
- **It works on any codebase, out of the box.** Pointed at a completely different project (Express)
  with no code changes — just one environment variable — it still cut redundant work by two-thirds,
  and its memory built up from one task to the next.

## Architecture

```
             mozaik · one shared event bus (the society)
   ┌──────────────────────────────────────────────────────────┐
   │   Planner → Conductor → Worker ×N (Claude Code)           │
   │            MemoryLibrarian · Sentry · Auditor             │
   └──────────────────────────┬───────────────────────────────┘
                              │  learn · search · supersede (HTTP)
                       ┌──────▼───────┐
                       │  oracle-lite │   Bun + SQLite FTS5
                       │  the brain   │   persistent · append-only
                       └──────────────┘
```

## Getting started

You'll need **Node 20+**, **pnpm**, **Bun ≥ 1.2**, and **Claude Code** logged in (no API key required).

```bash
pnpm install
pnpm test        # fast offline proofs of the mechanics + a live memory check
```

Then point it at any repo:

```bash
# watch a team analyse a codebase and share findings, with a "why" trail
AURALIS_PROJECT_DIR=/path/to/your/repo pnpm dev

# prove the memory survives across separate processes
AURALIS_PROJECT_DIR=/path/to/your/repo pnpm persist

# see the append-only / supersession guarantees for yourself
pnpm values
```

Everything project-specific — the target repo, the goal, the tasks — comes from environment
variables, so auralis isn't tied to any one project. See `.env.example`.

## Tuning: sharing vs. speed

By default the fleet runs **sequentially** (`AURALIS_PARALLEL=1`), which maximises sharing — every task
sees everything its predecessors found. Set `AURALIS_PARALLEL=3` to run each dependency level's tasks
concurrently: faster, but tasks in the same level start together and can't reuse each other (only
findings from *earlier* levels carry over). It's a genuine speed-vs-sharing dial.

To measure the payoff robustly instead of eyeballing one noisy run, `pnpm bench` runs the experiment
several times over a fixed task set (resetting the brain between trials) and reports the spread:

```bash
AURALIS_TRIALS=3 AURALIS_TASKS=benchmarks/core.json AURALIS_PROJECT_DIR=/path/to/repo pnpm bench
# → redundancy reduction: mean 41.2% · min 33.3% · max 50.0% · sd 6.8
```

## Project layout

| Path | What it is |
|---|---|
| `oracle-lite/server.ts` | the shared brain — learn / search / supersede / stats (no delete route) |
| `src/planner.ts`, `src/dag.ts` | turn a goal into a dependency graph |
| `src/conductor.ts` | walk the graph (level-parallel), self-repair via a Critic, pull-before / push-after the brain |
| `src/participants.ts` | Worker, MemoryLibrarian, Sentry, Auditor |
| `src/runner.ts` | drive Claude Code (or a deterministic stub for tests) |
| `src/audit.ts` | turn a run's provenance into a plain-language "why" |
| `src/run.ts` · `run-persist.ts` · `run-values.ts` | the three live demos |

## Honest notes

The live numbers are real but **directional** — how much you save depends on how much the tasks
overlap and how faithfully the agents reuse what they're handed. The deterministic tests pin down the
*mechanisms*; the live runs show them working. Making the numbers robust across many runs is next.

---

Built with [mozaik](https://github.com/jigjoy-ai/mozaik) and Claude Code.
