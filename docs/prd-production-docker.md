# PRD — Production usage: Docker Compose stack + `auralis` CLI (Supabase-style)

Date: 2026-07-07 · Status: proposed
Ask: wrap everything in Docker/Compose, daemonized, with an `auralis` CLI (`start`/`stop`) — the
Supabase developer experience: one command brings the whole stack up in the background, one takes it down.

## The one honest constraint that shapes everything

**The fleet's compute cannot live in Docker (v1).** Workers are Claude Agent SDK subprocesses that need
(a) your Claude login/keychain, (b) the *target repo's* filesystem, and (c) to spawn `claude` processes.
Baking auth into an image is worse security than the problem it solves.

So we split exactly like Supabase does — **infra in containers, your compute on the host**:
Supabase = db + studio in Docker, your app runs wherever. auralis = **brain + studio in Docker**,
the fleet/MCP runs host-side pointed at the containerized brain (`ORACLE_API_URL`). Everything the
platform *persists* becomes a daemon; everything that *bills your account* stays visibly yours.

## Services (docker-compose.yml)

| service | image | port (127.0.0.1 only) | role | daemon policy |
|---|---|---|---|---|
| `oracle` | `oven/bun` + repo | `47778` | the brain (SQLite + FTS5 + LanceDB), all APIs | `restart: unless-stopped`, healthcheck `/health` |
| `studio` | nginx-alpine | `47780→80` | dashboard **production build** (vite build → static) + `/api` proxy → oracle | `restart: unless-stopped` |
| `embedder` | node | internal | sentence-transformers sidecar (`AURALIS_SEMANTIC`) | **profile: `semantic`** (opt-in) |
| `tunnel` | cloudflared | — | public URL for studio | **profile: `share`** (opt-in, explicit) |

**Volumes:** bind-mount `./.auralis-out` into `oracle` — the brain (`brain.sqlite`, `lancedb-*`) survives
restarts/rebuilds, and the host-side fleet's `timing.jsonl` stays readable by the dashboard's Timing tab.
No named volumes: the data dir stays visible, greppable, and backupable (`VACUUM INTO` — U7 lands here).

**Production hardening in the same move (currently missing):**
- Oracle binds `0.0.0.0` today with **no auth** → compose publishes ports on **127.0.0.1 only**, and
  oracle gains an optional `ORACLE_TOKEN` (bearer check on every route except `/health`; off when unset —
  dev unchanged). This retires the deferred "oracle-lite auth" item at its natural moment.
- `ORACLE_ALLOW_RESET` stays **unset** in compose (no reset route in production).
- Session-capture hook + fleet keep working unchanged — they already speak `ORACLE_API_URL`.

## `auralis` CLI (`bin/auralis.mjs`, zero deps, `package.json bin`)

Thin, boring wrapper over `docker compose` — the Supabase pattern, not a new daemon manager:

```
auralis start [--semantic] [--share]   # compose up -d (+profiles) → wait for healthy → print status
auralis stop                           # compose down (data survives — volume is a bind mount)
auralis status                         # per-service state + health + brain stats (docs/edges/projects)
auralis logs [service] [-f]            # compose logs
auralis restart [service]
auralis doctor                         # docker present? ports free? brain reachable? token set?
```

`start` ends by printing exactly what Supabase prints: URLs (studio, oracle API), data dir, and how the
host-side fleet/MCP should point at it (`ORACLE_API_URL=http://localhost:47778`).

## What deliberately stays OUT (v1 — YAGNI with reasons)

- **Fleet/MCP in a container** — auth + repo-mount + nested `claude` spawning; revisit only if a real
  headless/CI use case appears (then: API-key-billed worker image, explicit opt-in).
- **Postgres/Redis/queues** — measured: oracle ops are 0.0% of wall. SQLite stays the system of record.
- **Multi-node / k8s** — single-machine daemon is the actual ask; the claim registry's TTL/lease item
  stays deferred until a real multi-machine fleet exists.

## Phases — each ships with its measurement (the house rule)

| phase | deliverable | proof before merge |
|---|---|---|
| **P1** | `Dockerfile.oracle`, dashboard prod build + nginx, `docker-compose.yml`, ORACLE_TOKEN | `docker compose up -d` → healthy < 30s; **learn → `docker compose restart` → search still finds it** (persistence); token: 401 without / 200 with; studio serves + `/api` proxies |
| **P2** | `auralis` CLI | `auralis start` → healthy stack + correct URLs; `stop` → down, data intact; `status`/`doctor` truthful against a broken port on purpose |
| **P3** | host fleet ↔ container brain | `ORACLE_API_URL=… pnpm dev` real run against the containerized brain — coordination stats normal; `bench-rank`/`bench-graph` pass pointed at the container |
| **P4** | profiles (`semantic`, `share`) + docs | embedder health + a semantic query; tunnel URL reachable; README "Production" section |

Est. effort: P1 ~half day · P2 ~2h · P3 measurement-only · P4 ~1h.

## Open questions (answer before P1)

1. **Image distribution** — build-from-repo only (v1, simplest), or also push `ghcr.io/…/auralis-oracle`?
2. **`auralis` global install** — `pnpm link`/`npm i -g` from the repo (v1), or publish to npm later?
3. Default studio port `47780` ok? (5173 stays for dev vite.)
