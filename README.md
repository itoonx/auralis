# auralis

[![CI](https://github.com/itoonx/Auralis/actions/workflows/ci.yml/badge.svg)](https://github.com/itoonx/Auralis/actions/workflows/ci.yml)
[![site](https://github.com/itoonx/Auralis/actions/workflows/site.yml/badge.svg)](https://github.com/itoonx/Auralis/actions/workflows/site.yml)

**The coordination layer for fleets of AI coding agents.**
One shared, persistent brain + real-time coordination — many agents that work as **one team**, not many amnesiacs.

**🌐 [See it in action → itoonx.github.io/Auralis](https://itoonx.github.io/Auralis/)** — live replay of a real fleet run.

```bash
curl -fsSL https://raw.githubusercontent.com/itoonx/Auralis/main/install.sh | bash
```

One line. Docker only. You get the full production stack — live dashboard, authenticated brain API,
semantic recall, daily backups — running in about a minute.

## Why

When you run *many* agents on one codebase, the model isn't the bottleneck — **the shared state is**.
Agents re-read the same files, redo each other's work, overwrite each other's changes, and forget
everything between sessions. auralis fixes the state, not the model.

## Measured, not asserted

Every number below is from a live run — full receipts in **[docs/proven.md](docs/proven.md)**:

- **−53% redundant work** across a 3-task fleet run; duplicate work *prevented* by design, not advised away
- **Paraphrase recall ~0% → 96%** — BGE-M3 semantic recall + cross-encoder reranking
- **Ranking A/B: 25% → 75%** precision@1 — trust and citations that memories *earn*
- **Time-travel recall** — ask "what was the timeout *in March*?" and get March's answer (`as_of`)
- Real multi-file programs **built and verified first-try** (REST API, expression evaluator), reworked automatically on failure
- A **sleep job** caught a real contradiction, judged it, and retired the stale fact — with the reason recorded
- Degradation is **counted, never silent** — a dead sidecar shows up as a counter, not as quietly worse recall

## What you get

- 🧠 **A living memory** — recall by meaning, a knowledge graph, earned trust, graceful forgetting
- 🤝 **Real coordination** — claims that *prevent* duplicated or clobbered work across any number of agents
- 🔨 **Build mode** — the fleet writes real programs, verified by an independent harness
- 💬 **Claude Code, both ways** — your sessions feed the brain; fleet findings surface back in your prompts
- 📊 **Studio** — every plan, tool call, verdict, and rework on a live, replayable timeline
- 🔒 **Production-grade** — bearer/JWT auth, 127.0.0.1-only ports, WAL-safe daily backups, reboot-safe daemons

## Next steps

| | |
|---|---|
| Install + wire in your Claude Code CLI | **[docs/getting-started.md](docs/getting-started.md)** |
| Operate it in production | [docs/production.md](docs/production.md) |
| How it works (the four pillars) | [docs/platform.md](docs/platform.md) |
| Every claim, measured | [docs/proven.md](docs/proven.md) |
| All commands & config | [docs/reference.md](docs/reference.md) |
| Where it's headed | [docs/roadmap.md](docs/roadmap.md) |

---

Built with [mozaik](https://github.com/jigjoy-ai/mozaik) and Claude Code.
