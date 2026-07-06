# Roadmap

Where the platform is headed. Ordered by leverage (timing tells us which knob actually moves the needle).

- **Memory-OS upgrades** — U1–U4 are **shipped and measured** (RRF+trust ranking, citation feedback,
  forgetting-as-ranking — see `docs/research-memory-os.md`). Remaining: **U5** nightly consolidation
  ("sleep job": dedup ≥0.92, same-entity contradiction pass — *dedup, not summarize*), **U6** bi-temporal
  (`superseded` = we were wrong vs `invalidated` = the world changed), **U7** safety snapshot
  (`VACUUM INTO`) before destructive ops. Deliberately waiting for real usage data to accumulate first —
  the sleep job needs citation counters and trust to pick supersede winners.
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
