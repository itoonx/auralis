# auralis

[![CI](https://github.com/itoonx/Auralis/actions/workflows/ci.yml/badge.svg)](https://github.com/itoonx/Auralis/actions/workflows/ci.yml)

**The coordination layer for fleets of AI coding agents — a shared, persistent brain and real-time
coordination that make many agents work as one team instead of many amnesiacs.**

Point auralis at a repository and a *society* of agents **analyses** it together; point it at an empty
folder and they **build** one — the same coordination either way.

> **The bet:** when you run *many* agents on one codebase, the model isn't the bottleneck — the shared
> state is. (Our own timing proves it: the LLM call is 99.9% of wall-clock; the platform adds ~0.05%.)

## What it gives you

| | In one line | Deep dive |
|---|---|---|
| **Shared brain** | persistent, append-only memory with semantic recall, a knowledge graph, trust-tiered ranking, and forgetting-without-deleting | [platform](docs/platform.md#1--the-shared-brain-oracle-lite) |
| **Coordination** | agents plan, share live mid-task, and are *prevented* — not advised — from duplicating or clobbering work | [platform](docs/platform.md#2--coordination-the-society) |
| **Build mode** | the fleet writes real programs — one file per worker, interfaces agreed via the brain, verified by an independent harness, reworked on failure | [platform](docs/platform.md#build-mode--the-fleet-writes-code) |
| **Runtime-agnostic** | policy lives in the middle layer; swap Claude for any model/agent without touching coordination | [platform](docs/platform.md#3--runtime-agnostic-any-model-any-agent) |
| **Observability** | every span timed, every run leaves a "why" trail, a live dashboard (studio) | [platform](docs/platform.md#4--observability-find-the-real-bottleneck) |

Every capability above was **measured on live runs, not asserted** — a few headlines:
redundant work **−53%** · dedup enforced (`prevented-dupes=4`) · built real multi-file programs first-try
(REST API, expression evaluator) · ranking A/B: plain **25% → 75%** precision@1 · memory poisoning by a
dead run caught and rejected. Full table + caveats: **[docs/proven.md](docs/proven.md)**.

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

Left arrow = **memory** (what agents know) · right arrow = **policy** (who's doing what). Both central,
so every process, model, and machine shares them.

## Getting started

**Prerequisites:** Node 20+ · pnpm · Bun ≥ 1.2 · Docker (daemon stack only) · **Claude Code logged in**.
⚠️ If `ANTHROPIC_API_KEY` is set, workers bill *that key* instead of your subscription — `unset` it to use the login.

```bash
git clone <this repo> && cd auralis
pnpm install && pnpm test
```

**1 · Start the platform** *(daemon — survives terminal close; skip if no Docker: every command boots a temporary brain itself)*

```bash
node bin/auralis.mjs start        # studio → http://localhost:47780 · brain API → :47778
```

**2 · Analyse any repo**

```bash
AURALIS_PROJECT=myrepo AURALIS_PROJECT_DIR=/path/to/repo pnpm analyze "how does auth work?"
```

**3 · Build a small program** *(workers own one file each; auralis verifies, reworks on FAIL)*

```bash
AURALIS_MODE=build AURALIS_ACCEPT=restapi AURALIS_PROJECT_DIR=./my-app \
AURALIS_GOAL="a todo REST API over Node's http: store.js, router.js, server.js" pnpm dev
```

**4 · Or drive it from Claude Code** — add the MCP server and your session gets `analyze`/`build` tools;
inside this repo your session is also captured into the same brain: **[docs/mcp.md](docs/mcp.md)**

**5 · Watch it work** — open the studio during a run: live timeline (▸ ✓ ⇄ ↻), run scorecards, the graph.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/platform.md](docs/platform.md) | why a platform, the four pillars in depth, build mode |
| [docs/proven.md](docs/proven.md) | every measured claim + honest caveats |
| [docs/mcp.md](docs/mcp.md) | MCP tools from Claude Code · session capture (ingress design) |
| [docs/production.md](docs/production.md) | Docker Compose stack, `auralis` CLI, ORACLE_TOKEN |
| [docs/reference.md](docs/reference.md) | all commands, configuration variables, project layout |
| [docs/roadmap.md](docs/roadmap.md) | where it's headed, ordered by measured leverage |
| [docs/research-memory-os.md](docs/research-memory-os.md) | the memory research behind ranking/forgetting (U1–U7) |

---

Built with [mozaik](https://github.com/jigjoy-ai/mozaik) and Claude Code.
