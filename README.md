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

## How a run works — a real orchestrator, not just memory

```
your goal ─► Planner ─► dependency DAG ─► Workers ×N — concurrent, sharing the brain MID-task
                                                │ every task:
                    PULL memory ─► RUN ─► Critic gate ─► self-repair ─► PUSH only what passed
```

- Duplicated and clobbered work is **prevented** (claims blocked at the tool boundary) — not politely advised away
- Rejected answers **never reach the brain** — an outage can't poison tomorrow's recall
- Every plan, tool call, verdict, and rework lands on a **replayable timeline** with per-task provenance

Full flow: **[the task loop](docs/platform.md#the-task-loop--what-actually-happens-per-task)**.

## Every role, any model — and they argue on purpose

Pick the model per role in one config file: Claude plans, GPT grades every worker answer, Claude
hunts defects in what got built — multiple vendors in one run, all on the same replayable timeline.

```jsonc
// auralis.config.json
{ "runners": { "worker": "claude:claude-opus-4-8", "critic": "gpt:gpt-5.6-sol",
               "reviewer": "claude:claude-opus-4-8" } }
```

- **`/brainstorm`** — a multi-model panel proposes independently, critiques, and converges; the decision
  brief is **learned into the brain** with a trust badge (earned / groupthink? / unstable) computed from
  *when* positions flipped, not how loud anyone argued
- **Dialectic mode** — proposals are *attacked* by a non-author, defended, and ruled on by a third-party
  judge; what survives is stored **with its scar record** (which attacks it survived, what was conceded) —
  because a claim that was never challenged should never look settled
- A provider with no key or no credit is **excluded before round 0, loudly** — and one dead provider
  never kills the debate

## Benchmarks

**The memory layer vs the alternatives** — LongMemEval (90 questions, ~120k-token histories), controlled
A/B: same reader, same judge, only the memory layer varies:

| memory layer | answer accuracy | context per question |
|---|---|---|
| **auralis brain** | **93.3%** | **~9.6k tokens** |
| entire history in the context window | 90.0% | ~124k tokens — **12.9× more** |
| grep the history (top-96 lines) | 60.0% | ~9.6k tokens |

→ full-context quality at **a thirteenth of the tokens** — and it still works when the history
*outgrows* the context window, which is the point.

**Retrieval quality** — paraphrase-hard set (the query shares no words with the memory), recall@10:

| lexical search | + BGE-M3 semantic | + cross-encoder rerank |
|---|---|---|
| ~0% | 88% | **96%** |

**Ranking** — earned trust + citations vs plain relevance: precision@1 **25% → 75%**.

<sub>Controlled single-run measurements on our own instrument (internal judge, identical across arms) —
methodology, caveats, and every other number: [docs/proven.md](docs/proven.md). We don't quote
cross-system leaderboard comparisons; different readers/judges make them theatre.</sub>

## Measured, not asserted

More from live runs — full receipts in **[docs/proven.md](docs/proven.md)**:

- **−53% redundant work** across a 3-task fleet run; duplicate work *prevented* by design, not advised away
- **Time-travel recall** — ask "what was the timeout *in March*?" and get March's answer (`as_of`)
- Real multi-file programs **built and verified first-try** (REST API, expression evaluator), reworked automatically on failure
- A **sleep job** caught a real contradiction, judged it, and retired the stale fact — with the reason recorded
- Degradation is **counted, never silent** — a dead sidecar shows up as a counter, not as quietly worse recall

## What you get

- 🧠 **A living memory** — recall by meaning, a knowledge graph, earned trust, graceful forgetting
- 🎼 **An orchestrator** — Planner → DAG → Critic-gated concurrent workers, per-task provenance ([how](docs/platform.md#the-task-loop--what-actually-happens-per-task))
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
