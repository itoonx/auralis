# Reference — commands, configuration, project layout

`pnpm run help` prints this live. Fleet/bench work runs via env vars + pnpm scripts; the **production
stack has its own CLI** — `node bin/auralis.mjs` (`setup` · `start` · `stop` · `status` · `logs` ·
`backup` · `sidecar` · `reembed` · `doctor`), documented in [production.md](production.md).

**Analyse & answer**
| Command | What it does |
|---|---|
| `pnpm analyze "<goal>"` | **the short path** — run the society once, then answer from graph-aware recall |
| `pnpm dev` | run the coordinated fleet over a repo (baseline vs shared brain) + a "why" trail |
| `AURALIS_MODE=build pnpm dev` | **build mode** — the fleet writes files into a workspace instead of analysing |
| `pnpm accept` | the independent acceptance harness — run the built program and PASS/FAIL it (`AURALIS_ACCEPT=rps\|todo\|restapi\|calc`) |

**Run the fleet**
| Command | What it does |
|---|---|
| `pnpm persist` | prove cross-session recall across separate processes |
| `pnpm bench` | run the experiment N times, report mean ± spread |
| `pnpm bench-graph` | measure how much recall the graph adds over flat search |
| `pnpm bench-rank` | A/B ranking bench — full ranker vs plain relevance on a decoy corpus (precision@1 / MRR, with a trust-vs-relevance guardrail) |

**The brain**
| Command | What it does |
|---|---|
| `pnpm recall "<q>"` | show what recall hands a worker: flat findings + the graph neighborhood |
| `pnpm build-graph` | build the knowledge graph from findings (entity/relationship edges) |
| `pnpm distill` | consolidate near-duplicate findings into vetted ones |
| `pnpm sleep` | the sleep job — snapshot (U7) → mechanical dedup of same-entity near-duplicates → an LLM judges the ambiguous pairs: contradiction → the newer fact *invalidates* the older (`AURALIS_SLEEP_LLM=0` to only report) |
| `pnpm decisions` | print the honest ADR log from the brain |
| `pnpm values` | demonstrate append-only + supersession (never deletes) |

**Services & dev**
| Command | What it does |
|---|---|
| `pnpm oracle` | run the brain sidecar (oracle-lite) on its own |
| `pnpm embed` | run the MiniLM embedding sidecar (bench/dev; production uses the BGE-M3 sidecar — see below) |
| `.auralis-out/venv-bge/bin/python src/bge-sidecar.py` | the production semantic sidecar: BGE-M3 dense+sparse `/embed` + bge-reranker-v2-m3 `/rerank` (managed by `auralis sidecar --install` or the `bge` compose service) |
| `pnpm test` | run the test suite |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm run help` | the usage guide |

## Configuration

Full list + defaults in `.env.example`. The ones that matter most:

**Workers & billing**

> Workers are Claude Agent SDK subprocesses. If `ANTHROPIC_API_KEY` is set in your shell they bill that
> key (pay-as-you-go) instead of your Claude Code subscription — `unset ANTHROPIC_API_KEY` to use the
> login. A depleted key fails workers with "Credit balance is too low"; `pnpm dev` prints which auth mode
> workers are using at startup.

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
| `AURALIS_BASELINE=1` | **re-measure mode** — also run the no-brain A/B baseline arm (~2× slower; **off by default** — the brain's value is already measured) |
| `AURALIS_QUIET=1` | silence the live step-by-step narration on stderr (MCP progress still flows) |

**Build mode**
| Variable | Effect |
|---|---|
| `AURALIS_MODE=build` | workers write files (`Edit`/`Write`, claim guards writes); default `analyze` is read-only |
| `AURALIS_CLAIM=0` | turn the claim gate off while keeping the brain — the free-for-all A/B arm |
| `AURALIS_ACCEPT` | the acceptance spec (`rps` \| `todo`); set it in build mode to **close the loop** — `pnpm dev` validates the output and reworks on FAIL |
| `AURALIS_BUILD_RETRIES` | extra fleet reworks when acceptance fails (default 1) |

**Production brain (oracle) — secrets live in `.env.oracle`, gitignored**
| Variable | Effect |
|---|---|
| `ORACLE_TOKEN` | static bearer required on every API call except `/health` (internal callers read the same file automatically) |
| `ORACLE_JWT_SECRET` | accept HS256 JWTs as an alternative credential — mint: `bun oracle-lite/jwt.ts sign --sub me --days 30` |
| `ORACLE_EMBED_URL` | semantic embedder endpoint (`http://bge:47783` in-Docker, or `http://host.docker.internal:47783` for the host/MPS sidecar); unset = built-in lexical embedder |
| `ORACLE_RERANK_URL` | cross-encoder endpoint; enables `search?rerank=1` (top-100 → rerank → top-k, fail-open, counted in `rerank_ok/rerank_fail`) |
| `POST /api/reembed` | rebuild the vector table for every existing doc (idempotent; `auralis reembed` wraps it) |

**Quality (heuristic vs LLM)**
| Variable | Effect |
|---|---|
| `AURALIS_SEMANTIC=1` | real sentence-embedding recall (starts the embed sidecar) |
| `ORACLE_GRAPH=0` | opt OUT of the automatic heuristic graph — the brain builds edges **on every learn** by default (incremental, idempotent, no LLM) |
| `search?as_of=<ISO>` | **temporal retrieval** — "what was TRUE at time T" (valid-time): returns docs whose validity interval covers T; superseded docs never qualify. `POST /api/invalidate {oldId, newId?, reason?, invalidAt?}` ends a fact's validity ("the world changed" — distinct from supersede = "we were wrong"); `learn` accepts `validAt` to back-date when a fact became true |
| `AURALIS_BUILD_GRAPH_LLM` | real predicates via Claude Code for the **batch refinement** (`pnpm build-graph` / `pnpm analyze`) — **on by default**; `=0` for the free heuristic |
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
| `src/embed.ts`, `src/embed-sidecar.ts` | MiniLM embeddings (bench/dev sidecar) |
| `src/bge-sidecar.py` | the production semantic sidecar — BGE-M3 dense+sparse `/embed`, bge-reranker-v2-m3 `/rerank` (host/MPS via launchd, or the `bge` compose service) |
| `oracle-lite/jwt.ts` | zero-dep HS256 JWT sign/verify for API auth (self-check: `bun oracle-lite/jwt.ts`) |
| `hooks/session-capture.mjs` | Claude Code session ↔ brain: recall injection + deterministic capture (global installs go via a `~/.claude/hooks` symlink — see getting-started §4b) |
| `bin/auralis.mjs`, `install.sh` | the production CLI · the curl-pipeable Docker-only installer |
| `src/distill.ts`, `src/run-distill.ts` | cluster near-duplicate findings → one vetted finding, supersede the raws |
| `src/graph.ts`, `run-build-graph.ts`, `run-recall.ts` | build the graph from findings; graph-expanded recall |
| `src/decision.ts`, `src/decisions.ts` | honest ADRs recorded into the brain — kept & superseded, never deleted |
| `src/accept.ts` | the independent acceptance harness — runs a built program in a sandboxed subprocess and asserts its contract (`pnpm accept`) |
| `src/run.ts` · `run-persist.ts` · `run-values.ts` · `bench.ts` | the live demos + the benchmark (build mode lives in `run.ts` + `runner.ts`) |
