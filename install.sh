#!/usr/bin/env bash
# auralis installer — Docker-only. The host needs docker (daemon running) and nothing else:
# the dashboard builds inside its image, and semantic recall runs as the `bge` compose service.
#   ./install.sh                # full install (semantic recall included)
#   ./install.sh --no-semantic  # lexical-only (smaller: skips the ~5GB torch image + 4.6GB weights)
# Idempotent: re-run any time; secrets and images are only created when missing.
# For the host-GPU (Apple silicon MPS) semantic path use `node bin/auralis.mjs setup` instead.
set -euo pipefail
cd "$(dirname "$0")"

SEMANTIC=1
for a in "$@"; do [ "$a" = "--no-semantic" ] && SEMANTIC=0; done

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ── 1 · prerequisites: docker only ──────────────────────────────────────────────────────────────────
say "① prerequisites"
command -v docker >/dev/null 2>&1 || fail "docker is required — install Docker Desktop or OrbStack, then re-run"
docker info >/dev/null 2>&1        || fail "docker daemon is not running — start it, then re-run"
docker compose version >/dev/null 2>&1 || fail "docker compose v2 is required"
echo "   ✅ docker + compose"

# ── 2 · auth secrets (.env.oracle, gitignored) ──────────────────────────────────────────────────────
say "② auth secrets"
rand_hex() { openssl rand -hex 32 2>/dev/null || od -vN32 -An -tx1 /dev/urandom | tr -d ' \n'; }
touch .env.oracle
for key in ORACLE_TOKEN ORACLE_JWT_SECRET; do
  if grep -q "^${key}=" .env.oracle; then echo "   ✅ ${key} (exists)"
  else echo "${key}=$(rand_hex)" >> .env.oracle; echo "   ✅ ${key} generated"; fi
done

# ── 3 · wire semantic recall to the in-Docker sidecar ───────────────────────────────────────────────
PROFILE=()
if [ "$SEMANTIC" = 1 ]; then
  say "③ semantic recall (bge service)"
  if grep -q "^ORACLE_EMBED_URL=" .env.oracle; then
    echo "   ✅ ORACLE_EMBED_URL already set ($(grep '^ORACLE_EMBED_URL=' .env.oracle | cut -d= -f2-)) — keeping it"
  else
    printf 'ORACLE_EMBED_URL=http://bge:47783\nORACLE_RERANK_URL=http://bge:47783\n' >> .env.oracle
    echo "   ✅ oracle → bge service URLs added"
  fi
  PROFILE=(--profile semantic)
else
  say "③ semantic recall — skipped (--no-semantic); the brain runs lexical-only"
fi

# ── 4 · build + start the stack ─────────────────────────────────────────────────────────────────────
say "④ stack (docker compose up --build — first build takes a few minutes$( [ "$SEMANTIC" = 1 ] && echo ', the bge image ~5GB' ))"
docker compose ${PROFILE[@]+"${PROFILE[@]}"} up -d --build

printf '· waiting for the brain'
BRAIN_UP=0
for _ in $(seq 1 60); do
  if curl -sf -m 2 http://127.0.0.1:47778/health >/dev/null 2>&1; then BRAIN_UP=1; break; fi
  printf '.'; sleep 2
done; echo
[ "$BRAIN_UP" = 1 ] || fail "oracle did not become healthy — docker compose logs oracle"
echo "   ✅ brain API      http://localhost:47778"
echo "   ✅ studio         http://localhost:47780"

# ── 5 · first-run semantic backfill (models ~4.6GB download inside the bge container) ───────────────
if [ "$SEMANTIC" = 1 ]; then
  say "⑤ embedding the brain (first run downloads model weights — this can take a while)"
  TOKEN=$(grep '^ORACLE_TOKEN=' .env.oracle | cut -d= -f2-)
  BGE_UP=0
  printf '· waiting for the bge model'
  for _ in $(seq 1 120); do # up to ~20 min for the first download
    STATUS=$(docker compose --profile semantic ps bge --format '{{.Health}}' 2>/dev/null || true)
    if [ "$STATUS" = "healthy" ]; then BGE_UP=1; break; fi
    printf '.'; sleep 10
  done; echo
  if [ "$BGE_UP" = 1 ]; then
    # the oracle probed the embedder at boot (likely before bge was ready) — restart it now that bge is up
    docker compose restart oracle >/dev/null 2>&1
    for _ in $(seq 1 30); do curl -sf -m 2 http://127.0.0.1:47778/health >/dev/null 2>&1 && break; sleep 1; done
    RES=$(curl -s -m 600 -X POST -H "Authorization: Bearer ${TOKEN}" http://127.0.0.1:47778/api/reembed || true)
    echo "   ✅ reembed: ${RES:-(brain empty — nothing to embed yet)}"
  else
    echo "   ⚠ bge is still downloading — later run:  docker compose restart oracle && node bin/auralis.mjs reembed"
  fi
fi

say "✓ auralis is running"
echo "   studio     http://localhost:47780"
echo "   brain API  http://localhost:47778   (Authorization: Bearer \$ORACLE_TOKEN from .env.oracle)"
echo "   next       wire your Claude Code CLI in → docs/getting-started.md §4"
