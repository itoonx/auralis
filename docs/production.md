# Production — the Docker stack + the `auralis` CLI

Supabase-style: the **infra** (brain + dashboard + semantic sidecar) runs as Docker daemons; the
**fleet/MCP compute stays on your host** (it needs your Claude login and the target repo's filesystem)
pointed at the containerized brain (`ORACLE_API_URL=http://localhost:47778`).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/itoonx/Auralis/main/install.sh | bash
```

One line, Docker-only: fetches the repo (→ `~/auralis`), generates auth secrets, wires the semantic
service, builds and starts everything, embeds the brain. Idempotent. Walkthrough + Claude Code wiring:
[getting-started.md](getting-started.md). On Apple silicon, `node bin/auralis.mjs setup` instead puts the
semantic sidecar on the host under launchd for GPU (MPS) embedding — ~10× faster than the CPU container.

## Operate

```bash
node bin/auralis.mjs status    # services + health + brain stats (docs · edges · vectors)
node bin/auralis.mjs logs [svc] [-f]
node bin/auralis.mjs stop      # down; the brain survives (bind mount ./.auralis-out)
node bin/auralis.mjs backup    # WAL-safe snapshot now · backup --install = daily 04:00 (launchd)
node bin/auralis.mjs sidecar   # semantic sidecar health · sidecar --install = launchd KeepAlive (host path)
node bin/auralis.mjs reembed   # rebuild the vector table for every doc (after switching embedders)
node bin/auralis.mjs doctor    # readiness: docker, ports, token, sidecar, backups, reboot
node bin/auralis.mjs start --share   # + a public cloudflared tunnel for the studio (explicit opt-in)
```

## Security

- Ports bind to **127.0.0.1 only**; `restart: unless-stopped` keeps services alive across Docker restarts.
- **Auth is two-plane**, secrets in **`.env.oracle`** (gitignored — *never* `.env`: Bun auto-loads `.env`
  into every scratch oracle the tests spawn):
  - `ORACLE_TOKEN` — static bearer for internal callers (adapter, session hook, MCP, CLI all send it
    automatically by reading the same file);
  - `ORACLE_JWT_SECRET` — HS256 JWTs for external callers (`bun oracle-lite/jwt.ts sign --sub me --days 30`).
  - `/health` stays open; everything else 401s. The studio's nginx injects the token on the `/api` proxy
    hop server-side — the browser never sees a credential.
- Compose reads `.env.oracle` at **create** time — after editing it: `docker compose up -d --force-recreate oracle`.

## Semantic recall in production

The oracle's vector lane runs **BGE-M3** (dense, 1024-dim) through an embed/rerank sidecar, two shapes:

| Shape | How | When |
|---|---|---|
| **Docker service `bge`** (default via install.sh) | compose profile `semantic`; unpublished, reached as `http://bge:47783` on the compose network | zero host deps; CPU (~40-80ms/embed) |
| **Host process** (via `auralis setup` / `sidecar --install`) | launchd KeepAlive; oracle reaches it via `host.docker.internal:47783` | Apple silicon GPU — ~7ms/embed |

Cross-encoder reranking is opt-in per query (`/api/search?...&rerank=1`, ~0.5s): wide top-100 → rerank →
top-k. Both lanes **fail open** — a dead sidecar degrades the oracle to its built-in lexical embedder,
*counted, never silent*: watch `embed_fallbacks` and `rerank_fail` in `/api/stats`; a rising counter is
the alarm. Model weights (~4.6GB) cache in the `.auralis-out` bind mount, shared between both shapes.

## Images

Oracle: lean bun + LanceDB (no Agent SDK). Studio: multi-stage — the dashboard builds *inside* the image
(node stage discarded; final ~62MB nginx with a same-origin `/api` proxy). bge: python + CPU torch (~5.6GB,
profile-gated so lexical-only installs never pull it).

Design rationale and phase-by-phase proofs: [prd-production-docker.md](prd-production-docker.md).
