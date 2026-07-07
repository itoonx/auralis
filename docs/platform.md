# The platform — why, and the four pillars

> Deep dive. The overview lives in the [README](../README.md).

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

**Memory has a lifecycle, not just storage (Ranking v2).** Retrieval fuses the keyword and vector lists
with **RRF** (rank-only, so incompatible score scales never mix), then bounded boosts nudge the order —
never gate it: `final = RRF × (1 + 0.2·recency + 0.1·usage + 0.05·trust) × (superseded ? 0.3 : 1)`.
*Trust* is a prior by source (a ⟲ retro derived from a measured acceptance run is born 0.85; an ordinary
worker finding 0.5 — defaults low, credibility is earned). *Usage* counts only **citations**: workers call
a `cite` tool when a recalled finding materially helped, never raw retrievals — so ranking can't
self-reinforce its own winners. And the brain **forgets without deleting**: strength
(`trust × (1+log(1+uses)) × 2^(−days/half-life)`) decays unless reinforced by use; below the floor a doc is
*archived* — hidden from default search, still reachable with `include_archived=1`. Decisions, hard-lesson
retros, and human-stated facts are **pinned forever**. After each run oracle also writes itself a
**retrospective** from the run's measured signals and recalls it before the next similar goal.
All of it is measured, not asserted: `pnpm bench-rank` is an A/B bench (full ranker vs plain relevance)
whose corpus deliberately fools pure keyword search — and whose guardrail fails any ranker that lets
trust override relevance.

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

Proven on real runs ([proven.md](proven.md)): built a rock-paper-scissors game **3/3** times, and — pointed at a *different*
project — a working TODO CLI, each passing an independent acceptance check.

