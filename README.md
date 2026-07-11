# auralis

[![CI](https://github.com/itoonx/Auralis/actions/workflows/ci.yml/badge.svg)](https://github.com/itoonx/Auralis/actions/workflows/ci.yml)
[![site](https://github.com/itoonx/Auralis/actions/workflows/site.yml/badge.svg)](https://github.com/itoonx/Auralis/actions/workflows/site.yml)

**🌐 [itoonx.github.io/Auralis](https://itoonx.github.io/Auralis/)** — the landing page: what auralis
does, the measured proof, and a replay of a real fleet run.

**The coordination layer for fleets of AI coding agents — a shared, persistent brain and real-time
coordination that make many agents work as one team instead of many amnesiacs.**

Point auralis at a repository and a *society* of agents **analyses** it together; point it at an empty
folder and they **build** one — the same coordination either way. Your own Claude Code sessions feed the
same brain, and what the fleet learns surfaces back in your prompts.

> **The bet:** when you run *many* agents on one codebase, the model isn't the bottleneck — the shared
> state is. (Our own timing proves it: the LLM call is 99.9% of wall-clock; the platform adds ~0.05%.)

## Install — one line, everything in Docker

```bash
curl -fsSL https://raw.githubusercontent.com/itoonx/Auralis/main/install.sh | bash
```

The script fetches the repo (→ `~/auralis`), generates auth secrets, builds and starts the stack, and
embeds the brain — idempotent, re-run any time. The host needs a running Docker daemon and nothing else.

You get a **production stack**, not a demo:

| | |
|---|---|
| **studio** · http://localhost:47780 | live dashboard — activity timeline, runs, graph, search |
| **brain API** · http://localhost:47778 | 127.0.0.1-only, bearer/JWT auth on by default (`.env.oracle`) |
| **semantic recall** | BGE-M3 embeddings + optional cross-encoder rerank, as a managed sidecar |
| **durability** | bind-mounted SQLite brain · WAL-safe daily backups · `restart: unless-stopped` |
| **observability** | every degradation is a counter (`embed_fallbacks`, `rerank_fail`), never silent |

Day-2 operations are one CLI — `node bin/auralis.mjs` (`status` · `logs` · `backup` · `sidecar` ·
`reembed` · `doctor`): **[docs/production.md](docs/production.md)**. Full walkthrough incl. wiring your
Claude Code CLI into the brain: **[docs/getting-started.md](docs/getting-started.md)**.

## What it gives you

| | In one line | Deep dive |
|---|---|---|
| **A living memory** | not storage — a full lifecycle: recall by meaning (BGE-M3 + rerank) + knowledge graph, ranking by *earned* trust and citations, **time-travel recall** (`as_of` — what was true *then*), graceful forgetting, and a **sleep job** that tidies contradictions while you're away | [platform](docs/platform.md#1--the-shared-brain-oracle-lite) · [research](docs/research-memory-os.md) |
| **Coordination** | agents plan, share live mid-task, and are *prevented* — not advised — from duplicating or clobbering work | [platform](docs/platform.md#2--coordination-the-society) |
| **Build mode** | the fleet writes real programs — one file per worker, interfaces agreed via the brain, verified by an independent harness, reworked on failure | [platform](docs/platform.md#build-mode--the-fleet-writes-code) |
| **Session memory, both ways** | your Claude Code session feeds the same brain the fleet uses — what you say becomes recallable by workers, what the fleet learns surfaces back in your prompts, and every exchange lands on a replayable timeline | [mcp](docs/mcp.md) |
| **Runtime-agnostic** | policy lives in the middle layer; swap Claude for any model/agent without touching coordination | [platform](docs/platform.md#3--runtime-agnostic-any-model-any-agent) |
| **Observability** | every step of every run — plans, tool calls, verdicts, reworks — timed, narrated, and replayable in a live dashboard (studio) | [platform](docs/platform.md#4--observability-find-the-real-bottleneck) |

Every capability above was **measured on live runs, not asserted** — a few headlines:
redundant work **−53%** · duplicate work *prevented*, not advised (`prevented-dupes=4`) · real multi-file
programs built and verified first-try (REST API, expression evaluator) · ranking A/B: plain **25% → 75%**
precision@1 · paraphrase recall: lexical **~0% → 88%** (BGE-M3) **→ 96%** with reranking · asked "what was
the timeout *in March*?" and got March's answer (`as_of`) · the sleep job caught a real 10min→30min
contradiction, judged it, and retired the stale fact **with the reason recorded** · the brain **defends
its own memory** (bad writes rejected at the gate, degradations counted — never silent). Full results:
**[docs/proven.md](docs/proven.md)**.

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
   │  Bun + SQLite FTS5 · LanceDB vectors · bearer/JWT auth    │
   │  persistent · append-only (no delete)                    │
   │  semantic recall · distillation · graph · claim registry  │
   └───────────┬───────────────────────────────────────────────┘
               │ /embed · /rerank (fail-open, counted)
   ┌───────────▼──────────────────────────────┐
   │  bge sidecar · BGE-M3 + cross-encoder     │  Docker service, or host/MPS via launchd
   └───────────────────────────────────────────┘
```

Left arrow = **memory** (what agents know) · right arrow = **policy** (who's doing what). Both central,
so every process, model, and machine shares them.

## Use it

**From Claude Code** — three integrations, all optional ([getting-started §4](docs/getting-started.md#4--use-it-from-claude-code-cli)):
working *inside* this repo needs zero setup (recall + capture just work); a `~/.claude/hooks` symlink
extends capture to every repo you work on; and the MCP server gives any session `analyze`/`build` tools.

**Run the fleet directly:**

```bash
AURALIS_PROJECT=myrepo AURALIS_PROJECT_DIR=/path/to/repo pnpm analyze "how does auth work?"

AURALIS_MODE=build AURALIS_ACCEPT=restapi AURALIS_PROJECT_DIR=./my-app \
AURALIS_GOAL="a todo REST API over Node's http: store.js, router.js, server.js" pnpm dev
```

Watch either in the studio: live timeline (▸ ✓ ⇄ ↻), run scorecards, the graph.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | **the full walkthrough** — install, auth, semantic recall, wiring your Claude Code CLI in, troubleshooting |
| [docs/production.md](docs/production.md) | operating the stack — CLI, two-plane auth (`.env.oracle`), semantic sidecar shapes, backups, alarms |
| [docs/platform.md](docs/platform.md) | why a platform, the four pillars in depth, build mode |
| [docs/proven.md](docs/proven.md) | every claim, measured on live runs |
| [docs/mcp.md](docs/mcp.md) | MCP tools from Claude Code · session capture (ingress design) |
| [docs/reference.md](docs/reference.md) | all commands, configuration variables, project layout |
| [docs/roadmap.md](docs/roadmap.md) | where it's headed, ordered by measured leverage |
| [docs/research-memory-os.md](docs/research-memory-os.md) | the memory research behind ranking/forgetting (U1–U7) |

---

Built with [mozaik](https://github.com/jigjoy-ai/mozaik) and Claude Code.
