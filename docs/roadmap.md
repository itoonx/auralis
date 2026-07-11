# Roadmap

Where the platform is headed. Ordered by leverage (timing tells us which knob actually moves the needle).

> **State (2026-07-12):** the semantic stack SHIPPED to production — BGE-M3 dense via the python
> bge-sidecar (launchd, KeepAlive) + opt-in cross-encoder rerank (`rerank=1`) + 2-plane API auth
> (JWT/token, `.env.oracle`). Ground-truth LME probe (subset50, 100% semantic engagement verified):
> evidence-chunk@48 88→93%, preference 33→67%, assistant@12 67→83%. **M4 aggregation is DROPPED**
> (premise refuted by the R3 probe; triggers to reopen recorded in `docs/prd-next-phase.md` §M4).
> Next gates: the answer-stage A/B when LLM credit returns (one evening — it is also M4's reopen
> test), and production mileage on the new stack. Prior notes: the P4 official number 53.4% predates
> this stack; `docs/prd-fix-recall.md` closed at 93.3% internal (subset90).

- **Memory-OS upgrades — complete (U1–U7), all shipped and measured** (`docs/research-memory-os.md`):
  RRF+trust ranking, citation feedback, forgetting-as-ranking, bi-temporal validity with `as_of` queries,
  the sleep job (snapshot → dedup → LLM contradiction judgment writing `invalid_at`), and atomic
  pre-mutation snapshots. Next on this axis: let real usage accumulate and watch the lifecycle work.
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
