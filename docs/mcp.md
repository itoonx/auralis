# Use auralis from Claude Code (MCP) & session capture

auralis ships an **MCP server** so you can call the fleet from your normal Claude Code CLI. Add it to your
`.mcp.json`:

```json
{ "mcpServers": { "auralis": { "command": "pnpm", "args": ["-C", "/path/to/auralis", "mcp"] } } }
```

Your session then gets two tools:

- **`analyze`** `(goal, dir?, project?)` — a society analyses a codebase and answers, sharing one brain.
- **`build`** `(goal, dir, accept?)` — a society builds a small program into `dir`, then verifies it.

The tool call boots the brain and runs a real fleet, which drives its own Claude workers via the Agent SDK
(reusing your login) — so it's Claude calling auralis calling Claude, and it works: proven on a live run
from a real `claude` CLI (`analyze` returned a real answer in 49s). Long calls stay alive: the tools stream
the live timeline plus a heartbeat as MCP **progress notifications**, so a client that resets its timeout on
progress won't cut them off — a build survived a 60s base timeout in testing, no `MCP_TOOL_TIMEOUT` needed.
The `build` tool also **reworks** on acceptance failure (same closed loop as the CLI). Caveats: a build runs
several minutes and its workers bill your account; oracle-lite uses port 47778.

### Session capture — your Claude Code session feeds the same brain

`hooks/session-capture.mjs` (registered in `.claude/settings.json`) captures the **interactive session
itself** into oracle-lite, and injects repo memory back into every prompt. It coexists with ambient memory
tools like Cognee — different lane: Cognee is global session memory; this is the *repo's engineering
brain*, the same one the fleet uses. So what you tell Claude Code becomes recallable by fleet workers, and
fleet findings surface back in your session — bidirectional, which a standalone memory plugin can't do.

What makes it different is the **ingress**: every event is classified into the right lane *at write time*,
deterministically, with **no LLM in the write path** (free, searchable the same instant — no ingestion queue):

| Session event | Lane | Trust | Fate |
|---|---|---|---|
| Substantive prompt (≥80 chars) | knowledge (`learn`) | **1.0** (human) | unpinned — fades if never used |
| Trivial prompt / slash / `!shell` | timeline only / dropped | — | never pollutes recall |
| Assistant conclusion (≥120 chars) | knowledge (`learn`) | 0.5 (agent) | credibility earned via `cite` |
| `Write`/`Edit` | timeline trace only | — | observability, **never knowledge** |
| Commits, reads, other tools | **dropped** | — | git already records them |

Recall runs *before* capture (a prompt is never echoed back at itself), shows each hit's id, and teaches
`cite` at the point of use — so session memories join the same usage-ranking and forgetting lifecycle as
everything else. Fail-silent: a dead oracle never breaks your session.
