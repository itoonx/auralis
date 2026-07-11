# Getting started — install auralis and use it from Claude Code

Zero → running stack → your Claude Code CLI wired into the shared brain. (Ops depth:
[production.md](production.md) · MCP/capture internals: [mcp.md](mcp.md) · every command: [reference.md](reference.md))

## 0 · Prerequisites (the only manual part)

| Need | Why | Check |
|---|---|---|
| Node 20+ · pnpm | host-side CLI, hooks, sidecars | `node -v` · `pnpm -v` |
| Bun ≥ 1.2 | oracle-lite runs on Bun | `bun -v` |
| Docker daemon (OrbStack recommended on macOS) | the production stack (brain + studio) | `docker ps` |
| sqlite3 CLI | WAL-safe backups | `sqlite3 --version` |
| **Claude Code, logged in** | fleet workers and MCP tools reuse your login — no API key | `claude --version` |
| *(optional)* Python 3.10+ | semantic recall sidecar (BGE-M3) — without it the brain still works, lexical-only | `python3 --version` |

## 1 · One command

```bash
git clone https://github.com/itoonx/Auralis && cd Auralis
node bin/auralis.mjs setup             # or: setup --no-semantic
```

`setup` does everything below by itself, prints each step, and **fails early with a clear list** if a
prerequisite is missing. It is **idempotent** — re-run it any time; every step skips what already exists:

1. checks the prerequisites above
2. `pnpm install`
3. generates auth secrets into `.env.oracle` (gitignored)
4. *(if python3)* installs the BGE-M3 sidecar into a venv + autostarts it via launchd
5. starts the stack (builds the dashboard on first run, waits for healthy)
6. schedules the daily 04:00 WAL-safe backup
7. embeds your brain semantically (first run downloads ~4.6GB of model weights; if that's still
   going, setup hands off — run `node bin/auralis.mjs reembed` when `auralis sidecar` shows ✅)

You now have:
- **studio** (dashboard) → http://localhost:47780
- **brain API** → http://localhost:47778 (127.0.0.1 only, bearer-token auth on)
- data in `.auralis-out/` (bind mount — survives rebuilds and `auralis stop`)

Tip: alias it — `alias auralis="node $(pwd)/bin/auralis.mjs"`. Then `auralis status` / `logs` / `stop` /
`doctor` (readiness checklist) work like any daemon CLI.

**Sections 2–3 below explain what `setup` just did** — read them when you need to customise; skip
straight to [§4](#4--use-it-from-claude-code-cli) to wire in Claude Code.

## 2 · Auth — what setup configured (manual path)

Secrets live in **`.env.oracle`** (gitignored) — *not* `.env`: Bun auto-loads `.env` into every scratch
oracle the tests spawn, so prod secrets must stay out of it.

```bash
printf 'ORACLE_TOKEN=%s\n' "$(openssl rand -hex 32)"      >> .env.oracle
printf 'ORACLE_JWT_SECRET=%s\n' "$(openssl rand -hex 32)" >> .env.oracle
docker compose up -d --force-recreate oracle               # container reads .env.oracle at create time
```

- Internal callers (session hooks, MCP, CLI) authenticate automatically — they read the same `.env.oracle`.
- External/API callers send `Authorization: Bearer <ORACLE_TOKEN>`, **or** a short-lived JWT:
  ```bash
  ORACLE_JWT_SECRET=$(grep '^ORACLE_JWT_SECRET=' .env.oracle | cut -d= -f2-) \
    bun oracle-lite/jwt.ts sign --sub laptop --days 30
  ```
- `/health` stays open; everything else 401s without a credential. The studio keeps working — its nginx
  injects the token on the proxy hop server-side (the browser never sees it).

## 3 · Semantic recall — what setup configured (manual path)

Lexical recall misses paraphrases ("herbs I grow" never matches "fresh basil"). The semantic sidecar fixes
that — measured: paraphrase recall ~0% (lexical) → 88% (BGE-M3 dense) → 96% with the reranker.

```bash
# one-time: the model runtime (~2GB torch + ~4.6GB weights on first run)
python3 -m venv .auralis-out/venv-bge
.auralis-out/venv-bge/bin/pip install FlagEmbedding

# wire the oracle to it (host.docker.internal = the container reaching your host)
printf 'ORACLE_EMBED_URL=http://host.docker.internal:47783\nORACLE_RERANK_URL=http://host.docker.internal:47783\n' >> .env.oracle

# run it as a service (launchd: starts on login, restarts on crash)
node bin/auralis.mjs sidecar --install
node bin/auralis.mjs sidecar                    # health: model, dim=1024, sparse=true

# recreate the oracle and re-embed the existing brain once
docker compose up -d --force-recreate oracle
TOK=$(grep '^ORACLE_TOKEN=' .env.oracle | cut -d= -f2-)
curl -X POST -H "Authorization: Bearer $TOK" http://127.0.0.1:47778/api/reembed
```

Verify: `/api/stats` should show `"embedder":"semantic"` and `semantic_embeds` ≈ your doc count with
`embed_fallbacks` ≈ 0. If the sidecar ever dies, the oracle degrades gracefully to its built-in embedder —
a **rising `embed_fallbacks` counter is your alarm**, and launchd restarts the sidecar automatically.

Reranking is opt-in per query (`&rerank=1`, ~0.5s): wide top-100 → cross-encoder → top-k. Fail-open.

## 4 · Use it from Claude Code CLI

### 4a · Working *inside* this repo — zero setup

The repo ships its own wiring (`.claude/settings.json`). Open Claude Code anywhere under the repo and:

- **Recall**: every prompt is prefixed with the brain's most relevant memories
  (`[oracle-lite recall — this repo's brain]` block) — the same memories fleet workers get.
- **Capture**: substantive prompts (trust 1.0) and assistant conclusions (trust 0.5) are written back —
  deterministically classified at write time, no LLM in the path, searchable the same instant.
  Trivial prompts, file edits, commits are timeline-only or dropped (git already records them).
- Nothing to configure; a dead oracle never breaks your session (fail-silent by design).

### 4b · Capture from *other* repos — global install (symlink, not a direct path)

To feed the same brain from every project you work on, register the hook globally — **via a symlink**:

```bash
mkdir -p ~/.claude/hooks
ln -sf /path/to/Auralis/hooks/session-capture.mjs ~/.claude/hooks/auralis-session-capture.mjs
```

then in `~/.claude/settings.json` add to `UserPromptSubmit`, `Stop`, and `PostToolUse` hooks:

```json
{ "type": "command", "command": "node /Users/you/.claude/hooks/auralis-session-capture.mjs" }
```

> **Why the symlink matters:** the hook detects double-installs ("this repo already wires me — stand
> down") by checking whether it was invoked from inside the project. A global entry that points
> *directly* at the repo file defeats that check — both copies run and **every memory lands twice**
> (we shipped that bug to ourselves; the brain needed surgery). The symlink lives outside the repo,
> so the guard works: global stands down inside Auralis, runs everywhere else.

### 4c · Drive the fleet — MCP tools

Add to your project's `.mcp.json` (or `~/.claude/mcp.json` for everywhere):

```json
{ "mcpServers": { "auralis": { "command": "pnpm", "args": ["-C", "/path/to/Auralis", "mcp"] } } }
```

Your session gains two tools (details: [mcp.md](mcp.md)):
- **`analyze`** `(goal, dir?, project?)` — a fleet analyses a codebase and answers, sharing one brain.
- **`build`** `(goal, dir, accept?)` — a fleet writes a small program into `dir`, verifies it, reworks on FAIL.

Both stream live progress; builds take minutes and bill your Claude account (workers are real sessions).

### 4d · Everyday commands

```bash
node bin/auralis.mjs status       # services + brain stats (docs · edges · vectors)
node bin/auralis.mjs backup       # WAL-safe snapshot now (daily 04:00: backup --install)
node bin/auralis.mjs doctor       # readiness: docker, ports, token, sidecar, reboot, backups
node bin/auralis.mjs logs oracle  # any compose service
# query the brain directly (auth on):
TOK=$(grep '^ORACLE_TOKEN=' .env.oracle | cut -d= -f2-)
curl -H "Authorization: Bearer $TOK" "http://127.0.0.1:47778/api/search?q=how+does+auth+work&limit=5&project=auralis"
curl -H "Authorization: Bearer $TOK" "http://127.0.0.1:47778/api/search?q=...&rerank=1"   # + cross-encoder
```

## 5 · Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Every activity row appears **twice** in studio | hook registered globally *and* by the repo, global entry points straight at the repo file → re-point the global entry at the **symlink** (§4b) |
| API answers `401 unauthorized` | auth is on and the caller sent no/old token → send `Authorization: Bearer <ORACLE_TOKEN>`; internal callers need `.env.oracle` present |
| `embed_fallbacks` climbing in `/api/stats` | sidecar down/unreachable → `node bin/auralis.mjs sidecar`; launchd (`--install`) auto-restarts it |
| Studio loads but every panel is empty | oracle unreachable or token mismatch behind the proxy → `auralis status`, then `docker compose up -d --force-recreate studio` after `.env.oracle` changes |
| After editing `.env.oracle` nothing changed | compose reads env at **create** time → `docker compose up -d --force-recreate oracle` |
| After reboot recall feels dumber | sidecar wasn't installed as a service → `node bin/auralis.mjs sidecar --install`; check `auralis doctor` |
| Tests suddenly demand auth / 401 in benches | prod secrets leaked into the test env — keep them in `.env.oracle`, never `.env`, and never export them in your shell profile |
