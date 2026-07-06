# auralis

[![CI](https://github.com/itoonx/Auralis/actions/workflows/ci.yml/badge.svg)](https://github.com/itoonx/Auralis/actions/workflows/ci.yml)

**The coordination layer for fleets of AI coding agents — a shared, persistent brain and real-time
coordination that make many agents work as one team instead of many amnesiacs.**

Point auralis at a repository and a *society* of agents **analyses** it together; point it at an empty
folder and they **build** one — the same coordination either way. But the platform is the part **around**
the agents, not the agents themselves: a **shared brain** every agent reads and writes, **real-time
coordination** so they build on each other's work instead of colliding, and **runtime-agnostic seams** so
the same brain serves Claude today and any other model or agent runtime tomorrow.

> **The bet:** when you run *many* agents on one codebase, the model isn't the bottleneck — the shared
> state is. auralis is built around that bet. (Our own timing proves it: the LLM call is 99.9% of
> wall-clock; everything the platform adds is ~0.05%.)

---

## Contents

- [Why a platform, not just agents](#why-a-platform-not-just-agents)
- [The four pillars](#the-four-pillars)
  - [1 · The shared brain (oracle-lite)](#1--the-shared-brain-oracle-lite)
  - [2 · Coordination (the society)](#2--coordination-the-society)
  - [3 · Runtime-agnostic (any model, any agent)](#3--runtime-agnostic-any-model-any-agent)
  - [4 · Observability (find the real bottleneck)](#4--observability-find-the-real-bottleneck)
- [Build mode — the fleet writes code](#build-mode--the-fleet-writes-code)
- [Proven on live runs](#proven-on-live-runs)
- [Architecture](#architecture)
- [Getting started](#getting-started)
- [Command reference](#command-reference)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Roadmap](#roadmap)
- [Honest notes](#honest-notes)

---

## Why a platform, not just agents

Run one agent and it's easy. Run a *fleet* and you've quietly built a small distributed system — a dozen
agents touching the same repo — and it lives or dies on the orchestration around them, not on which model
is typing. Three things go wrong every time:

- **They redo each other's work.** Agent A reads the core modules; Agent B reads them all over again,
  because it has no idea A already did.
- **They forget everything.** Close the session and all that hard-won context is gone — tomorrow's run
  re-derives it from scratch.
- **Their notes don't connect.** Even when memory persists, two agents' findings about the *same* module
  sit as unrelated text blobs. Nothing joins them.

The classic trap is *accidental* shared state. Give each agent its own isolated worktree and it may no
longer see the `node_modules`, the context, or the findings a sibling just produced. Isolation quietly
removed the shared state everyone was leaning on — and it "worked on my machine" right up until it didn't.

auralis takes the opposite stance: **shared state is explicit, persistent, and never accidental.** Every
agent reaches the same brain over HTTP and gets the same answer — whether it's isolated, in a separate
process, on another machine, or running tomorrow. Coordination is reactive, not scripted: agents flag
overlaps live and hand each other what predecessors already found.

## The four pillars

| Pillar | What it gives you | Where it lives |
|---|---|---|
| **1 · Shared brain** | persistent, append-only, semantic memory + knowledge graph | `oracle-lite/`, `src/memory.ts` |
| **2 · Coordination** | a society that plans, shares live, and never double-works | `src/conductor.ts`, `src/participants.ts`, `src/fleet.ts` |
| **3 · Runtime-agnostic** | swap the model or the agent runtime without touching policy | `src/runner.ts`, `src/claim.ts`, adapters in `src/memory.ts` |
| **4 · Observability** | centralized timing + provenance to find the real bottleneck | `src/log.ts`, `src/audit.ts` |

---

### 1 · The shared brain (oracle-lite)

The brain is **oracle-lite** — a tiny local service (Bun + SQLite full-text search, plus an optional
**LanceDB** vector index merged into a hybrid ranking). It's persistent, append-only, and fast enough that
a finding is searchable the instant it's written — and it degrades gracefully to keyword-only if the vector
layer isn't available. On top of plain storage it does four things a flat memory can't:

**Recall by meaning, not keywords.** With `AURALIS_SEMANTIC=1` the vectors are real sentence embeddings
(all-MiniLM-L6-v2, via a small Node sidecar), so *"how do we authenticate users"* finds a note about
*"the sign-in flow validates credentials"* despite zero shared words. Without the sidecar it falls back to
a lightweight built-in embedder, so it always runs.

**Distillation — the brain gets sharper, not just bigger.** A persistent brain rots by accumulation.
`pnpm distill` is the janitor: it clusters findings that mean the same thing, synthesises each cluster into
one **vetted** finding, and **supersedes** the raws — never deleting them (superseded notes stay searchable
but rank below the vetted one).

**A knowledge graph — findings that connect.** `pnpm build-graph` reads each finding, extracts
entity/relationship triplets, and stores them as edges keyed by a normalized entity — so every finding that
mentions `auth/session.ts` links to the *same node*. Recall **uses** it: `injectFor` blends flat search with
a graph-neighborhood expansion, so a query pulls in findings *connected* to its topic even when they share
no keywords. *(The idea of graph-linked memory is informed by prior art like
[cognee](https://github.com/topoteretes/cognee); the implementation and naming here are auralis's own.)*

**Honest ADRs that live in the brain.** auralis records a decision *into* the shared brain (via a `decide`
tool), so the next agent that touches that area **searches and finds it** right when it's about to change
something. It keeps the road not taken (rejected alternatives, and why), and — because the brain is
append-only — a reversed decision is never deleted, only *superseded* ("reversed because …").

> **Guarantee:** the brain has **no delete route at all.** Everything is append-only and auditable;
> "removal" is always supersession. `pnpm values` demonstrates it.

---

### 2 · Coordination (the society)

auralis runs its agents as a **society** on the [mozaik](https://github.com/jigjoy-ai/mozaik) runtime —
participants that react to each other on a shared event bus, rather than following a fixed script.

- **Planner** turns your one-line goal into a small **dependency graph** of subtasks.
- **Conductor** walks that graph level by level. Before each task it *pulls* relevant knowledge from the
  brain; after each task it *pushes* new findings back. Independent tasks in a level can run concurrently.
- **Workers** are real coding agents (Claude Code via the Agent SDK — no API key, it reuses your login).
  What they read and search *is* their record of work; they can also call the brain directly as an MCP tool.
- **MemoryLibrarian** injects what's already known before a worker starts, and captures what it found after.
- **Sentry** watches the bus and flags, live, when two workers wander into the same territory.
- **Critic** grades each answer and quietly retries the weak or cut-off ones (self-repair), so a worker that
  hits its turn limit doesn't poison the brain with a half-finished note.
- **Auditor** records everything, so any run leaves a readable "why did it do that?" trail.

Two coordination mechanisms make the fleet act like a team, not a crowd:

**Real-time sharing (`AURALIS_WORKER_PULL`, on by default).** Workers don't just get a briefing at the
start — they read and write the brain **mid-task**. A worker that discovers something publishes it
immediately; a teammate later in the same level can pull it before finishing. Sharing is live, not
batched at level boundaries.

**Deterministic dedup (the claim registry).** Real-time advice isn't enough on its own — an LLM can ignore
it. So before a worker reads a file, it must **claim** it against the shared brain (`/api/claim`). If a
teammate already owns that file, the read is **blocked at the tool boundary** (a `PreToolUse` hook) and the
worker is redirected to reuse the finding. This is prevention, not a polite request — proven
`prevented-dupes=4` on a live 3-worker run.

---

### 3 · Runtime-agnostic (any model, any agent)

The platform is built so you can change *who does the thinking* without rewriting *how the team coordinates*.
Two seams make that real:

- **Swappable memory adapter** (`MemoryAdapter`): `OracleAdapter` talks to oracle-lite over HTTP;
  `NullMemoryAdapter` is the no-brain control. Anything that implements the interface is a valid brain.
- **Swappable agent runtime** (`AgentRunner`): `ClaudeCodeRunner` drives Claude Code; `StubRunner` is a
  deterministic test double. A GPT / Gemini / Aider runner is just another implementation.

The crucial design choice: **policy lives in the middle layer, mechanism lives per-runtime.** The claim
*decision* (`src/claim.ts`) is a pure, dependency-free function the oracle-lite server owns — so every
process, model, and agent runtime resolves ownership against the **same** registry and gets the same
answer. Only the *enforcement mechanism* is runtime-specific (Claude uses a `PreToolUse` hook; another
runtime uses whatever it has). Add a new agent = write a runner + its intercept; you never touch the shared
policy.

> This is what lets a heterogeneous fleet — Claude and GPT and Aider, across separate processes — dedup
> against one another instead of each keeping its own private notion of who's doing what.

---

### 4 · Observability (find the real bottleneck)

You can't optimise a fleet you can't see. auralis has a **centralized timing sink** (`src/log.ts`): every
meaningful span — `worker.run`, `brain.inject`, `brain.capture`, `oracle.search`, `oracle.claim`,
`graph.build`, `graph.expand` — is timed and rolled up into a grouped summary sorted by total time, printed
at the end of every run (`AURALIS_LOG_TIMING=1` also streams each span live to stderr; spans persist to
`.auralis-out/timing.jsonl`).

This is how we *know* the model is the bottleneck, not the brain: timing shows `worker.run` is **99.9%** of
wall-clock and `oracle.claim` averages **2.4ms**. It turns "which knob matters?" from an opinion into a
measurement — and it's what points the roadmap at model routing rather than shaving milliseconds off HTTP.

Alongside timing, every run writes a **provenance trail** (via the Auditor): what each task recalled,
explored, produced, and contributed. Nothing the fleet does is a black box.

---

## Build mode — the fleet writes code

The same coordination that keeps agents from re-reading a file keeps them from **clobbering** one. With
`AURALIS_MODE=build`, workers get `Edit`/`Write` and the fleet *builds* a program instead of only
describing it. Almost nothing new was needed — it's the analyse machinery with one idea flipped:

- **claim-on-write.** In analyse mode the claim gate guards `Read` (dedup); in build mode it guards
  `Write`/`Edit` (**anti-clobber**). The Planner hands each worker its own file; a write to a teammate's
  file is denied at the tool boundary. `Read` is never blocked — a worker must read what a teammate built.
- **Coordination = a shared contract.** The value in building isn't avoided re-reads, it's a shared
  interface: the worker that writes `game.js` publishes `play(a,b) -> 'win'|'lose'|'tie'` to the brain, and
  the CLI + test workers **pull** it instead of guessing.
- **Workers write, auralis verifies.** Workers get no shell; all execution happens in an **independent
  acceptance harness** (`pnpm accept`) that runs the built program in a sandboxed subprocess (timeout,
  cwd-confined) and asserts its contract from fixed inputs. A worker can't pass by writing `assert(true)` —
  the objective truth is auralis's, not the worker's.
- **Confined.** Every write resolves inside a throwaway workspace (`.auralis-build/…`, gitignored); a write
  escaping it is denied. This is confinement, not a true sandbox (a container/VM is the real answer, and
  out of scope for now).

Proven on real runs (§ below): built a rock-paper-scissors game **3/3** times, and — pointed at a *different*
project — a working TODO CLI, each passing an independent acceptance check.

---

## Proven on live runs

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

## Architecture

```
             mozaik · one shared event bus (the society)
   ┌──────────────────────────────────────────────────────────┐
   │   Planner → Conductor → Worker ×N (any agent runtime)     │
   │   MemoryLibrarian · Sentry · Critic · Auditor             │
   └───────────┬───────────────────────────────┬──────────────┘
    learn · search · relate (HTTP / MCP)        │  claim (HTTP) — deterministic dedup
   ┌───────────▼───────────────────────────────▼──────────────┐
   │  oracle-lite · the brain + the middle layer               │
   │  Bun + SQLite FTS5 · LanceDB vectors                      │
   │  persistent · append-only (no delete)                    │
   │  semantic recall · distillation · graph · claim registry  │
   └───────────────────────────────────────────────────────────┘
```

Two arrows into oracle-lite, on purpose: the left is **memory** (what agents know), the right is **policy**
(who's doing what). Both are central so every runtime shares them.

## Getting started

You'll need **Node 20+**, **pnpm**, **Bun ≥ 1.2**, and **Claude Code** logged in (no API key required).

```bash
pnpm install
pnpm test        # fast offline proofs of the mechanics + a live memory check
```

Then point it at any repo. The short path is one command:

```bash
# run the society once, build the graph, answer from graph-aware recall (quality on by default)
AURALIS_PROJECT=myrepo AURALIS_PROJECT_DIR=/path/to/repo pnpm analyze "how does auth work?"
```

Or step through the pieces:

```bash
AURALIS_PROJECT_DIR=/path/to/repo pnpm dev        # watch a team analyse a repo, with a "why" trail
AURALIS_PROJECT_DIR=/path/to/repo pnpm persist    # prove memory survives across separate processes
pnpm values                                        # see the append-only / supersession guarantees
```

Everything project-specific — the target repo, the goal, the tasks — comes from environment variables, so
auralis isn't tied to any one project. See [Configuration](#configuration) and `.env.example`.

## Command reference

`pnpm run help` prints this live. Everything runs via env vars + pnpm scripts (no unified CLI yet).

**Analyse & answer**
| Command | What it does |
|---|---|
| `pnpm analyze "<goal>"` | **the short path** — run the society once, then answer from graph-aware recall |
| `pnpm dev` | run the coordinated fleet over a repo (baseline vs shared brain) + a "why" trail |
| `AURALIS_MODE=build pnpm dev` | **build mode** — the fleet writes files into a workspace instead of analysing |
| `pnpm accept` | the independent acceptance harness — run the built program and PASS/FAIL it (`AURALIS_ACCEPT=rps\|todo`) |

**Run the fleet**
| Command | What it does |
|---|---|
| `pnpm persist` | prove cross-session recall across separate processes |
| `pnpm bench` | run the experiment N times, report mean ± spread |
| `pnpm bench-graph` | measure how much recall the graph adds over flat search |

**The brain**
| Command | What it does |
|---|---|
| `pnpm recall "<q>"` | show what recall hands a worker: flat findings + the graph neighborhood |
| `pnpm build-graph` | build the knowledge graph from findings (entity/relationship edges) |
| `pnpm distill` | consolidate near-duplicate findings into vetted ones |
| `pnpm decisions` | print the honest ADR log from the brain |
| `pnpm values` | demonstrate append-only + supersession (never deletes) |

**Services & dev**
| Command | What it does |
|---|---|
| `pnpm oracle` | run the brain sidecar (oracle-lite) on its own |
| `pnpm embed` | run the semantic embedding sidecar |
| `pnpm test` | run the test suite |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm run help` | the usage guide |

## Configuration

Full list + defaults in `.env.example`. The ones that matter most:

**Targeting**
| Variable | Effect |
|---|---|
| `AURALIS_PROJECT_DIR` | the repo to analyse (default: current dir) |
| `AURALIS_PROJECT` | brain namespace — recall is scoped to it; use one per repo |
| `AURALIS_GOAL` | the analysis goal for `pnpm dev` |
| `AURALIS_TASKS` | fixed task set (inline JSON or a file path) — keeps benchmark trials comparable |

**Coordination & speed**
| Variable | Effect |
|---|---|
| `AURALIS_WORKER_PULL` | workers read/write the brain live, mid-task (real-time sharing + claim dedup) — **on by default**; `=0` to opt out |
| `AURALIS_PARALLEL=3` | run each DAG level concurrently — faster, but same-level tasks can't reuse each other |
| `AURALIS_BASELINE=0` | **prod mode** — skip the A/B baseline arm, run only the shared brain (~2× faster) |

**Build mode**
| Variable | Effect |
|---|---|
| `AURALIS_MODE=build` | workers write files (`Edit`/`Write`, claim guards writes); default `analyze` is read-only |
| `AURALIS_CLAIM=0` | turn the claim gate off while keeping the brain — the free-for-all A/B arm |
| `AURALIS_ACCEPT` | which acceptance spec `pnpm accept` runs (`rps` \| `todo`) |

**Quality (heuristic vs LLM)**
| Variable | Effect |
|---|---|
| `AURALIS_SEMANTIC=1` | real sentence-embedding recall (starts the embed sidecar) |
| `AURALIS_BUILD_GRAPH` | build the graph on ingest during `pnpm dev` |
| `AURALIS_BUILD_GRAPH_LLM` | real predicates via Claude Code — **on by default**; `=0` for the free heuristic |
| `AURALIS_DISTILL_LLM=1` | distill with Claude Code for real merges (costs) |

**Observability**
| Variable | Effect |
|---|---|
| `AURALIS_LOG_TIMING=1` | stream each timing span to stderr; the TIMING summary prints either way |

## Project layout

| Path | What it is |
|---|---|
| `oracle-lite/server.ts` | the brain **and** the middle layer — hybrid FTS + LanceDB vectors, graph edges, learn / supersede / relate / stats (no delete), and the `/api/claim` registry |
| `src/claim.ts` | the pure claim decision (first worker wins) — dependency-free so the Bun server and any runtime share it |
| `src/planner.ts`, `src/dag.ts` | turn a goal into a dependency graph |
| `src/conductor.ts` | walk the graph (level-parallel), self-repair via a Critic, pull-before / push-after the brain |
| `src/fleet.ts` | wire up a fleet: start the brain, resolve tasks, run one arm, manage claim scope |
| `src/participants.ts` | Worker, MemoryLibrarian, Sentry, Auditor |
| `src/runner.ts`, `src/brain-mcp.ts` | drive Claude Code (or a deterministic stub); expose the brain as MCP tools; enforce claims at the tool boundary |
| `src/memory.ts` | the brain behind a swappable adapter (Oracle / Null) — memory **and** claim endpoints |
| `src/log.ts` | centralized timing sink — every span, one grouped summary |
| `src/embed.ts`, `src/embed-sidecar.ts` | real semantic embeddings (a sentence-transformer sidecar) |
| `src/distill.ts`, `src/run-distill.ts` | cluster near-duplicate findings → one vetted finding, supersede the raws |
| `src/graph.ts`, `run-build-graph.ts`, `run-recall.ts` | build the graph from findings; graph-expanded recall |
| `src/decision.ts`, `src/decisions.ts` | honest ADRs recorded into the brain — kept & superseded, never deleted |
| `src/accept.ts` | the independent acceptance harness — runs a built program in a sandboxed subprocess and asserts its contract (`pnpm accept`) |
| `src/run.ts` · `run-persist.ts` · `run-values.ts` · `bench.ts` | the live demos + the benchmark (build mode lives in `run.ts` + `runner.ts`) |

## Roadmap

Where the platform is headed. Ordered by leverage (timing tells us which knob actually moves the needle).

- **Model / turn routing** — *highest leverage.* Timing proves the LLM call is 99.9% of wall-clock, so the
  real cost lever is *which* model runs *which* task: a small/cheap model for the Planner and easy subtasks,
  Opus reserved for hard analysis, plus a per-task turn budget. This is the one change measurement says is
  worth it.
- **Parallel writing beyond disjoint files** — build mode (above) already coordinates *writing* when each
  worker owns a distinct file: the claim registry generalised from "who reads this file" to "who writes it",
  proven on real builds. The open part is **overlapping edits** to a shared file — worktrees + clean merges,
  or a finer-grained claim than whole-file. That, plus a real container/VM sandbox for executing generated
  code, is the next frontier.
- **Cross-machine fleets** — the claim policy already lives in the middle layer, so cross-process dedup
  works today. The remaining piece is a **TTL/lease** (so a worker that dies mid-run doesn't hold its claim
  forever) and true multi-machine namespacing. Deferred until a genuine multi-machine fleet exists.
- **Heterogeneous runtimes in one fleet** — the `AgentRunner` seam makes GPT / Gemini / Aider runners
  drop-in; the work is writing each runner and its per-runtime claim intercept. They already share one brain
  and one claim registry.
- **Trustworthy numbers** — replace the single-run (n=1) proofs above with `pnpm bench` mean ± spread.

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
  confinement, not a sandbox) are still ahead — see Roadmap.

---

Built with [mozaik](https://github.com/jigjoy-ai/mozaik) and Claude Code.
