# Production — Docker Compose + the `auralis` CLI

Supabase-style: the **infra** (brain + dashboard) runs as Docker daemons; the **fleet/MCP compute stays on
your host** (it needs your Claude login and the target repo's filesystem) pointed at the containerized brain.

```bash
node bin/auralis.mjs start     # oracle (:47778) + studio (:47780) as daemons — survive terminal close
node bin/auralis.mjs status    # services + health + brain stats
node bin/auralis.mjs stop      # down; the brain survives (bind mount ./.auralis-out)
node bin/auralis.mjs doctor    # environment checks
node bin/auralis.mjs start --share   # + a public cloudflared tunnel for the studio (explicit opt-in)
```

Ports bind to **127.0.0.1 only**. Set `ORACLE_TOKEN` to require a bearer on every API call (the adapter,
session-capture hook, and CLI all send it automatically; `/health` stays open). Unset = local default.
The oracle image is lean (bun + LanceDB only — no Agent SDK); the studio image is nginx serving the
dashboard's production build with a same-origin `/api` proxy. `restart: unless-stopped` keeps both alive
across reboots of Docker. Host fleet against the containerized brain: `ORACLE_API_URL=http://localhost:47778`.

Design rationale and phase-by-phase proofs: [prd-production-docker.md](prd-production-docker.md).
