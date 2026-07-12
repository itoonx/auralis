# PRD — Multi-model AgentRunner: Claude · GPT · GLM in one fleet

Date: 2026-07-12 · Status: plan approved-pending · Basis: the `AgentRunner` seam (`src/runner.ts:21`)
already isolates the runtime; `ApiRunner` (`runner.ts:123`) already proves the OpenAI-compatible path
for tool-less work. This phase builds the **tool-loop** version and makes the fleet heterogeneous —
the roadmap's "heterogeneous runtimes" + the groundwork for "model/turn routing" (its highest-leverage item).

## The key insight — one new runner covers GPT *and* GLM (and more)

GPT (api.openai.com) and GLM (open.bigmodel.cn `/api/paas/v4`) both speak **OpenAI-compatible chat
completions with function calling**. So we do NOT build a runner per vendor:

```
AgentRunner (the seam — unchanged)
├── ClaudeCodeRunner   (exists — Agent SDK, reuses Claude login)
├── ToolLoopRunner     (NEW — one OpenAI-compatible agentic loop)
│     preset gpt   → api.openai.com        + OPENAI_API_KEY
│     preset glm   → open.bigmodel.cn/v4   + GLM_API_KEY
│     generic      → any baseURL/model/key  (DeepSeek, Qwen, local Ollama — free CI runner)
├── ApiRunner          (exists — tool-less lifecycle jobs)
└── StubRunner         (exists — deterministic tests)
```

**Prompts stay untouched.** Worker prompts hardcode tool names (`mcp__oracle__search`, `Read`…) —
OpenAI's function-name charset allows all of them, so `ToolLoopRunner` exposes the *identical names*
and `participants.ts` never changes.

**Claim enforcement gets *simpler*, not harder.** ClaudeCodeRunner needs a `PreToolUse` hook because the
SDK owns the loop. In `ToolLoopRunner` *we* own the loop — the claim check and workspace confinement are
plain code in the tool dispatcher, same semantics (deny → explain → the denied target never counts as
explored). Coordination stays central in the brain (`adapter.claim`), so **cross-runtime dedup works by
construction** — a GLM worker and a Claude worker cannot clobber each other. That is pillar 3 made real.

## The contract every runner must honour (extracted from ClaudeCodeRunner)

1. `run(prompt) → { result, explored[] }`; `explored` tracks Read/Grep/Glob (+Write/Edit in build mode)
   with `targetOf` semantics (`file_path` / `pattern`).
2. Claim gate: guarded tool on an owned target → **denied**, the model gets the redirect message
   ("teammate owns it — search their finding"), the target lands in `denied` and is filtered from `explored`.
3. Build mode: writes confined to the workspace (no absolute/`..` escape); analyse mode read-only.
4. Brain tools available under the same names: `mcp__oracle__{search,learn,decide,note,cite}`.
5. `onStep(tool, target)` fires for **every** tool call (live narration + timeline traces).
6. Turn budget respected; early stop → `"(worker stopped early: …)"` with explored kept.
7. Infra failures surface as text the Critic can reject (never fake success).

## Milestones

### M0 · Conformance suite — the contract as tests (~½ day)
**Deliverables:** `test/runner-contract.test.ts` + `test/fake-openai.ts` — an in-process fake
OpenAI-compatible server that replays *scripted* tool-call responses (no network, no keys, CI-green).
The suite asserts items 1–7 above; run it against a mock loop first.
**Gate:** suite exists and is the single source of truth for "what a runner is".
**Why first:** GLM/GPT quality differences must show up as *failing named assertions*, not vibes.

### M1 · `ToolLoopRunner` (~1–1.5 days) — `src/runner-toolloop.ts`
The OpenAI-compatible agentic loop:
- messages = [system(prompt)] → while `tool_calls` and turns < max: dispatch natively, append results.
- Native tools: `Read`/`Glob` (fs), `Grep` (ripgrep when present, JS scan fallback), `Write`/`Edit`
  (build mode only), oracle tools via the existing HTTP adapter (auth comes from `.env.oracle` as today).
- Dispatcher enforces claim + confinement (contract §2–3), records `explored`/`denied`, fires `onStep`.
- Config per instance `{ baseURL, model, apiKey, maxTurns }`; one retry with backoff on 429/5xx;
  provider error text returned as the result (Critic's `INFRA_ERROR` already matches rate-limit/quota).
**Gate:** M0 suite green against ToolLoopRunner-on-fake-server; live smoke (real GPT key, 1-task analyze
on this repo) produces a Critic-accepted answer with a non-empty `explored`.

### M2 · Presets + selection (~½ day)
- `makeWorkerRunner()` factory: `AURALIS_RUNNER=claude|gpt|glm|api-compat` (+
  `AURALIS_RUNNER_MODEL`, `AURALIS_RUNNER_BASE_URL`, `AURALIS_RUNNER_API_KEY`; presets fill defaults —
  gpt→`gpt-4o-mini`, glm→`glm-4-plus`). Runner keys live in `.env` (billing keys, like OPENAI_API_KEY
  today) — NOT `.env.oracle` (oracle secrets only).
- Wire into `fleet.ts` (workers) and `resolveTasks` (planner selectable via `AURALIS_PLANNER_RUNNER`,
  default = same as workers). `auralis doctor`: key-present check for the chosen runner.
**Gate:** `AURALIS_RUNNER=glm pnpm analyze "<goal>"` completes end-to-end on a real repo; the forced
two-workers-one-file smoke still shows `prevented-clobbers=1` (claims hold on the new runtime).

### M3 · Heterogeneous fleet (~1 day)
Different runners **in one run**. Start with the natural 2-tier split the DAG already gives us:
- `AURALIS_RUNNER` = exploration workers (cheap: glm/gpt-mini) ·
  `AURALIS_RUNNER_SYNTHESIS` = the synthesis task (strong: claude).
- Timeline records which runtime ran each task (`trace` events carry it) — the studio shows a mixed fleet.
**Gate:** a mixed run (glm exploration + claude synthesis) on a real repo: no coordination regression
(reuses/prevented ≥ single-runtime run), per-task runner visible in the replay.
**This is the doorway to model/turn routing** — the roadmap's highest-leverage item — but *routing
policy* (auto-pick by difficulty) stays out of scope until these static tiers are measured.

### M4 · Measure + tell the story (~½ day + run cost)
- `pnpm bench` arm per runner on a fixed `AURALIS_TASKS` set: Critic pass-rate, reuse, wall, $.
- Docs: platform §3 ("runtime-agnostic" → proven with three runtimes), README one line (upside-only
  rule — only if the numbers earn it), reference.md env table.
**Gate:** a table in proven.md with the three runtimes on the same task set.

## Risks — named, with mitigations

| Risk | Mitigation |
|---|---|
| GLM/GPT ignore the claim-deny redirect text | conformance asserts *behaviour after deny* (must not retry the same target); prompts already teach the fallback (`search` instead) |
| Tool-call quality varies by model (malformed args) | dispatcher validates args, returns a corrective tool-error message (the loop's version of a hook deny); Critic catches unusable finals |
| `Grep` parity (ripgrep vs JS fallback) | same `targetOf` semantics either way; conformance covers both paths |
| Context limits differ (8k GLM variants vs 128k) | injected context is already small (top-5 + graph); preset carries a `maxContextChars` clamp |
| Key/billing confusion | doctor check per preset; runner keys documented as `.env` (billing), never `.env.oracle` |
| Silent provider degradation | provider errors are returned as result text → Critic rejects → not captured (the poison-gate already built for this) |

## Out of scope (explicit)
Auto-routing by task difficulty (needs M3's tiers measured first) · Gemini/Aider runners (same seam,
add after ToolLoopRunner settles) · cross-machine claim TTL/lease (separate roadmap item) · streaming.

## Sequence

```
M0 ▶ M1 ▶ M2 ▶ M3 ▶ M4
      (M2 and the M1 live-smoke can interleave; M3 needs M2; M4 needs M3)
```
Total: ~3.5–4.5 days of work + one bench evening.
