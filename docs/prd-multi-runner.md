# PRD — Multi-model AgentRunner: Claude · GPT · GLM in one fleet

Date: 2026-07-12 · Status: plan approved-pending · Basis: the `AgentRunner` seam (`src/runner.ts:21`)
already isolates the runtime; `ApiRunner` (`runner.ts:123`) already proves the OpenAI-compatible path
for tool-less work. This phase builds the **tool-loop** version and makes the fleet heterogeneous —
the roadmap's "heterogeneous runtimes" + the groundwork for "model/turn routing" (its highest-leverage item).

## North star (the user's picture)

> "Use multi-agent with any mix of models, and let them **brainstorm**: e.g. Claude Fable 5 writes the
> plan, a GPT-5.5 critic tears it apart, and a Claude reviewer hunts bugs in the result."

Decomposed, that is three capabilities, in dependency order:
1. **Any model behind any role** — Phase 1 below (M0–M4: one ToolLoopRunner + presets + mixed fleets).
2. **Model-per-ROLE, not just per-worker** — Planner / Critic / Reviewer each pick their own runner (M5).
3. **Brainstorm loops** — roles *converse* (propose → critique → revise) before and after execution (M6).

**mozaik verified (2026-07-12, `@mozaik-ai/core` d.ts):** the hunch is right — mozaik designed for this
and auralis uses only a fraction of it. Available today, unused: **typed bus channels**
(`deliverModelMessage` / `deliverReasoning` / `deliverFunctionCall(-Output)` with per-type `onExternal*`
callbacks — we only use the plain string `deliverMessage`); **selective listening** (`Participant.listens`
— a role subscribes to specific participant *classes*: exactly role-to-role conversation); a **shared,
rehydratable `ModelContext`**; and a whole **multi-vendor inference layer** (`Endpoint` + mapper +
`InferenceParams` + `TokenUsage`, `ModelName` union already spanning gpt-5.x / claude-4.x / gemini /
deepseek). GLM isn't in the union, but `Endpoint` is an interface — custom endpoints plug in.

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

## Phase 2 — the society brainstorms (M5–M8)

### M5 · Model-per-role (~1 day) — **SHIPPED 2026-07-13**

> **Status:** both roles live, both gated against real models, both OPT-IN (no config ⇒ the free
> defaults; silence never means "silently spend"). Critic gate: a real GPT critic rejected a fluent
> non-answer with the exact gap named while accepting the concrete one. Reviewer gate: a real Claude
> reviewer (explore tools) read a planted file and caught the summary's lie ("divide() guards b=0" —
> it didn't). Both fail OPEN on provider outage, named in the verdict/note, never silent. Still open:
> the full three-vendor studio-replay scenario below (needs a live build run).

The seams already exist; this milestone just gives each one a runner knob:
- **LLM Critic** — `coordinate()` already takes an injectable `critic` (`conductor.ts:32`); today's
  default is heuristic. Add `LlmCritic` backed by any `AgentRunner` (the tool-less `ApiRunner` suffices —
  a **GPT critic is nearly free** once M2 lands). The heuristic stays as a pre-filter (infra-error/empty
  checks are cheaper than a model call); the LLM grades substance: "does this actually answer the task?
  what's missing?" Its reason feeds the existing self-repair loop verbatim.
- **Reviewer** — a NEW role, distinct from the Critic: after a task (or a whole build) passes, the
  Reviewer hunts *defects* (bugs, contract violations, unhandled edges) rather than grading completeness.
  In build mode it runs before acceptance and its findings feed the rework prompt; its verdicts land on
  the timeline like every other event.
- Env: `AURALIS_PLANNER_RUNNER` · `AURALIS_CRITIC_RUNNER` · `AURALIS_REVIEWER_RUNNER` ·
  `AURALIS_RUNNER(_SYNTHESIS)` — each `claude|gpt|glm|api-compat[:model]`, defaulting to the worker runner.
**Gate:** the user's exact scenario runs: Fable plans → GPT critic grades → Claude reviewer bug-hunts a
build output — three vendors in one run, visible per-role in the studio replay.

### M6 · `/brainstorm` — the multi-model idea panel (~1.5–2 days) — **SHIPPED 2026-07-13**
**The user-facing centerpiece:** a slash command that spins up a panel of models to think together and
doesn't stop until the outcome is *learned*.

> **Status:** shipped and proven live (`claude + gpt`; `glm` when its Zhipu balance is topped up).
> Delivered beyond spec: **preflight** (a paid provider with no key/credit is excluded before round 0,
> loudly, and the run aborts if none survive), **panel resilience** (one dead provider drops without
> killing the round — counted, never silent), and the Claude panelist runs on the **Claude Code CLI
> login** by default. Still open: the `brainstorm` MCP tool (slash command works today), and the cost
> guard (deferred to a `max_tokens` cap + truncation flag). The panel is the *simultaneous* engine — M8
> evolves it into an adversarial one.

**Observability (designed by the claude+gpt panel, wired 2026-07-13).** Principle: record **state
changes, not the transcript firehose** — a model that never moves emits nothing; silence is the signal.

- **Events (SHIPPED):** every run binds `narrate.ts` → the shared timeline, so the studio replays a
  brainstorm like any fleet run. Emitted: `prompt` (topic) · `phase` (round boundaries) · `finding`
  (per-panelist idea/vote) · `dropped` (preflight exclusions + mid-run provider failures) · `flip`
  (**the spine** — who changed their vote, at which round, derived from the round board) · `note`
  (trust badge) · `answer` (convergence + synthesis head). Best-effort by construction: a dead oracle
  can't slow or break a debate.
- **Trust badge (SHIPPED, v1 heuristic):** one indicator from flip *timing*, not flip count —
  **earned** (flipped under challenge, then settled) / **groupthink?** (converged with zero flips —
  agreement never challenged) / **unstable** (still flipping in the final round) / **solo**. Known v1
  limit, observed on the first live run: a *reworded* vote counts as a flip ("Spaces, 2 per indent" →
  "Spaces (2), enforced by Prettier" scored unstable) — vote normalization is wording-sensitive.
  Calibration belongs to the chart milestone; thresholds stay tunable, not constants.
- **Primary UI (LATER, studio milestone): position-flow line chart** — X = rounds, Y = stance, one line
  per model; lines meeting = convergence, a jump = a flip, a flat line = a holdout; each turn-node
  clicks open to the actual argument text (the transcript is demoted to drill-down, not lost). Rejected
  as the front door: transcript (*is* the noise), swimlanes (activity, not positions), argument graph
  (expert hairball — keep as an expert drill-down later), scoreboard (outcome without process).
  Open risk to solve before building: the Y-axis assumes stance reduces to a comparable label — have
  the synthesizer emit a **normalized stance label per model per round** (fixes the badge's rewording
  false-flips too); when stance can't be reduced, fall back to transcript rather than draw a false line.
- **Not tracked yet:** per-call token/cost attribution (ApiRunner discards `usage`) — one per-run cost
  rollup line lands with the cost guard.

**Shortcut that reorders the plan:** brainstorming is **tool-less** (thinking, not exploring files) —
so the engine needs only `ApiRunner` (exists) + the Claude runner, NOT the M1 ToolLoopRunner. M6 can
land right after M2's config parsing, in parallel with M1.

**Surface:**
- `.claude/commands/brainstorm.md` → `/brainstorm <topic>` inside any Claude Code session in the repo
  (runs `pnpm brainstorm "<topic>"`), and a `brainstorm` MCP tool on the existing server for everywhere else.
- Panel comes from the config (see *Config surface* above): e.g. fable-5 + gpt-5.5 + glm-4-plus.

**The loop (bounded, structured, recorded):**
```
round 0   each panelist proposes INDEPENDENTLY (no cross-talk — diversity first)
round k   each panelist sees the whole board → structured output:
          { idea_revision, critiques: [{of, point}], borrowed: [], vote }
converge  stop when the vote is stable across 2 rounds, OR nothing substantive
          changed (delta ≈ 0), OR K rounds (default 3) — whichever first
synthesize a designated strong model merges: best idea · why it won · what each
          model contributed · rejected alternatives with reasons · open risks
LEARN     the brief lands in the brain (oracle learn, decision-record style,
          project-scoped) — "จนกว่าจะได้เรียนรู้": recallable by every future
          session and fleet worker; the full debate lands on the timeline
```
Every round is a timeline event → the studio replays the argument. Cost guard: per-round token cap +
a printed running cost; the loop refuses to start if a panelist's key is missing (doctor-style check).

**Gate:** `/brainstorm "should X use approach A or B?"` with a 3-vendor panel produces a synthesis that
names each model's contribution, and the brief is recallable in a fresh session. Then the anti-theatre
A/B (same as plan-review below): panel-of-3 vs single-strong-model on 5 real design questions — the
panel must win on substance (a human picks blind) often enough to pay for itself.

**Plan review (pre-execution) reuses the same engine:** Planner proposes the DAG → the panel critiques
(`{verdict, risks[], missing[], changes[]}`) → Planner revises ≤ K rounds. Result debate (post-execution
challenge→defend→judge before capture) also reuses it. Transport: mozaik's typed channels + `listens`
(role-to-role without broadcasting noise) — the same bus we already run on.

### M7 → M0.5 · mozaik-native spike (timeboxed ~1 day) — **promoted to design-input, runs BEFORE M1**
Verified 2026-07-12: mozaik's `runInference` routes providers **by model name** (OpenAI / Anthropic /
Gemini / DeepSeek-via-`OPENAI_BASE_URL`) with credentials from env, and it ships `InferenceParams.tools`
+ `executeFunctionCall` — i.e. the function-calling plumbing M1 was going to hand-roll may already exist.
The spike answers, against the M0 conformance suite: (a) can ToolLoopRunner be built ON `runInference` +
`executeFunctionCall` instead of raw fetch (getting provider routing + TokenUsage for free)?
(b) does GLM work through the DeepSeek-style base-URL override, or does it need a custom `Endpoint`?
**Do not migrate on vibes** — whichever loop passes conformance cheaper wins.

### M8 · The dialectic — crystallize what survives, not what agrees (~2–3 days)

**North Star.** The system's output is **not "an answer"** — it is a *claim that carries the scars of
what attacked it* (**calibrated**), *written to the brain to be superseded later* (**persistent**), and
*used as the ground the next debate stands on* (**compounding**). The valuable part of a crystal is the
**scar record, not the conclusion.** Compounding is the moat stateless debate can't have: settled,
battle-tested premises accumulate, so the fleet gets *harder to fool over time*.

**Why "one spirit, everyone agrees" is the wrong target.** The whole reason to run N models is that
their errors are independent; optimizing for shared-spirit consensus throws that away (correlated bias,
groupthink). **Rule: share the WHAT (facts + goal, loaded from the brain via `mcp__oracle__search`),
never the HOW (method + answer).** Consensus that was never attacked is theatre.
`shared ground · adversarial path · crystallized end` — anchor on the same facts, argue independently,
crystallize only what survived.

**The process — 5 stages, roles SEPARATED (or it collapses into a forum):**
```
propose   (parallel, independent — no cross-talk, anti-anchoring)
challenge (a NON-author attacks the single weakest point — told to REFUTE, must name a concrete
           failure scenario, default "refuted" if unsure)
defend    (the author rebuts or concedes)
judge     (a NON-author rules PROCEDURALLY: did the defense answer the attack? — NOT "which idea is best")
synthesize the survivor + graft the strengths of the sunk → LEARN (scar record, not just the verdict)
```
Winner = highest **survivability**, not most votes. **There is no vote.** (Survivability *alone* ≠ truth —
see **Correction** below, folded in from the M8-on-M8 panel test.) Invariant:
**author ≠ challenger ≠ judge** on the same proposal. Challenger = `critic` role, judge = `reviewer`
role — both already resolve per-model (M5's `AURALIS_CRITIC_RUNNER` / `AURALIS_REVIEWER_RUNNER`); make
the judge a **cross-family** referee of the *argument*, not a decider of *truth*.

**The 5 holes in the compounding loop, and their plugs** (compounding cuts both ways — a wrong crystal
poisons *every* future debate, so each plug is load-bearing):
| Hole | Plug |
|---|---|
| A wrong crystal poisons every future debate | Crystals are **provisional**: tag `margin` (settled vs tentative); reuse the brain's **`supersede`** so a contradicting crystal overrides *with provenance*, never a silent delete |
| A crystal without its scar record is just an answer | LEARN stores **attacks-survived + concessions + margin + who-challenged/judged**, not only the conclusion |
| Shared ground can't be wrong if it can't be challenged | One challenger **red-teams the PREMISE**, not a proposal: "what assumption in the task itself is false?" |
| Judge has substantive bias | Judge rules **procedurally** (was the defense responsive?); truth is decided by *what survives*, the judge only certifies the survival was legitimate |
| No attack landed | **Suspicious, not safe** — force a *steelman-the-opposite* pass before crystallizing; only then crystallize high-margin |

**Correction — survival ≠ truth** (folded in from the M8-on-M8 panel test, 2026-07-13 — running
`/brainstorm` claude+gpt on *this* design surfaced the flaw; kept as supersede-with-provenance, per the
design's own rule). The load-bearing hole is the **procedural judge**: ruling "was the defense
responsive?" rewards the most *fluent* rebuttal, not the correct one — so a scarred claim certifies
*debate quality, not correctness*, and compounding then weaponizes an articulate-but-wrong crystal
(margin/supersede are **reactive** — they fire only after a contradiction surfaces, which compounding
buries). Fix, **without installing a truth-oracle**:
- **Evidence-gated crystallization.** The **challenger** (not the author) defines a *falsifying test*. A
  claim becomes **settled** ground only if it PASSED that test; a claim that merely out-argued its
  challenge crystallizes as **provisional**, never settled. This breaks the "articulate = true" coupling
  at the moment of crystallization, before compounding can amplify it.
- **Give the provisional lane teeth.** "Cheap to reopen" must be *mechanics, not a label*: explicit
  reopen triggers + **margin decay by time/use** — or provisional crystals calcify into the very
  entrenchment we were fixing.
- **Guard the test too.** Challenger-defined tests can be gamed (impossible bar / strawman) → the judge
  also rules the *test* fair (procedurally); contested **evidence** just keeps the claim provisional
  rather than spawning a sub-dialectic (bounds the "prove the proof" regress).
- **Scope honesty.** Evidence-poor work — design taste, values, forecasts — has no falsifying test, so it
  stays **provisional by rule** (*this design doc included*). Evidence-gating sharpens convergent,
  testable claims; it does not manufacture certainty where none exists.

> Rejected head-on alternative (also from the panel): "make the judge rule on *substance/truth*." It
> reinstalls the single point of failure the three-role split exists to avoid — it relocates the oracle
> from author to judge instead of removing it. Evidence-gating keeps judging procedural but moves the
> truth-check to an **external, author-independent test**.

**Mechanics** (drilled per-topic by the claude+gpt panel, 2026-07-13 — crystals in the `m8-design`
project). All three converged, independently, on one rule that is now load-bearing for the whole design:
**no gate may rest on an in-the-moment judgment — every gate anchors to an external, pre-committed
signal** (an event log, a track record, a certified anchor — never "what the room thinks right now").

- **Provisional lane — evidence-contact signed margin (NO wall clock).** Each provisional crystal
  carries a signed margin `M` that moves **only on evidence-contact events**: a logged *contradiction*,
  a *downstream failure* (something built on it broke), or a *user flag*. `M` under the reopen line →
  reopens; confirmations ratchet it back. No event ⇒ no movement, ever — an untouched-but-correct
  crystal never rots; a repeatedly-contradicted one falls fast. *Anti-thrash:* hysteresis (reopen line
  below promote line), per-trigger cooldown, same-outcome ratchet. *Anti-calcification:* promotion to
  settled is **explicit, multi-source, logged** — never by neglect. (Rejected: time-based decay — the
  clock is the *engine* of both failure modes: too slow = calcify, too fast = thrash.) Known hole:
  an event that never gets logged is de-facto calcification — instrument the missed-event rate.
- **Test integrity — anchor-pair calibration.** Before a challenger's falsifying test may gate a claim,
  it must run against a **pre-agreed control pair**: a certified-true anchor and a certified-false one.
  Admitted only if it *passes the positive and fails the negative* — an impossible bar flunks the
  positive, a strawman clears the negative; one instrument kills both gamings. Threshold is
  **pre-registered before the challenger sees the claim**; anchors drawn **cut-and-choose** so they
  can't be tailored. The regress terminates at *ground truth*, not at another reviewer. (Rejected:
  adversarial meta-review — a reviewer of the test needs its own reviewer; it relocates the regress.)
  Known hole: **anchor governance is the new single point of failure** — anchors must bracket the
  claim's regime (same domain/difficulty), rotate so they can't be memorized, ≥2 pairs.
- Both build on machinery the brain already has: the event log / audit ledger feeds evidence-contact;
  settled past crystals with known outcomes are the anchor pool.

**Pilot-only (NOT committed): evidence-poor adoption by staking.** For claims with no falsifying test
(design taste, values, forecasts): an agent spends **scarce, calibration-scored credit** to stake a
crystal as ground for **one scoped decision** (expiry-bound charter, least-cost-reversible execution,
cheap-proxy tripwire that forces re-stake). Expiry defeats the dumping ground; paying with track-record
credit defeats winner-equals-most-fluent. **Why pilot-only:** the credit economy is a big build with a
circularity at its core — scoring "was right before" in a domain that *by definition* lacks ground truth
depends entirely on proxy quality (the panel labeled this HYPOTHESIS itself). Run it on a small set of
reversible design decisions, log every stake + tripwire outcome, and audit whether credit tracks
being-right **before** widening the lane.

**v1 implementation contract** (gap review by the opus-4.8 + gpt-5.6-sol panel, 2026-07-13 — what bites
DURING implementation; crystal in `m8-design`). v1 slices: engine with ALL crystals provisional (no
anchor pool exists yet) · reopen by user-flag only · staking not built. Three contracts before code:
1. **Schema first — it is the enforcement point, not just a shape.** Every stage reads/writes the
   crystal; pin it before engine code: `verdict` enum with safe default **`NOT_ANSWERED`** (machine-
   branchable), explicit attack/concession/margin fields, typed provenance edges (`supersedes`,
   `grounded_in`). A claim with no scar must be *representable only as* NOT_ANSWERED.
2. **The debate is a fault-tolerant state machine, not a happy path.** Per-stage timeouts; any dead/
   garbage challenger, defender, or judge lands the crystal in a terminal **`INCONCLUSIVE`** state
   (→ provisional) — never "survived a challenge it never received". Derangement (author ≠ challenger
   ≠ judge) is a **checkable precondition asserted at debate start**; an unsatisfiable pool aborts to
   inconclusive, never silently relaxes the invariant.
3. **Synthesis is provenance-constrained — structurally, not advisorily.** The synthesizer reads only
   from the schema and **hard-rejects** any claim whose verdict is NOT_ANSWERED / whose scar is
   incomplete (invariant with a test, not a warning) — an unchallenged claim can never be laundered
   into the brain looking settled. Every provisional write is logged so the user-flag-only reopen
   backlog stays visible.

**Two modes — this is where the forum idea lives (scoped to where it helps):**
- **`converge`** (default): the dialectic above → the best *defensible* answer. For decisions / design / bug-hunts.
- **`diverge`**: forum-style cross-talk, **no judge, no winner** → a ranked idea list. For naming / product-direction / ideation, where cross-pollination genuinely spawns hybrids.

**Reuse:** `src/dialectic.ts` (pure engine, scripted-runner tests, exactly like `brainstorm.ts`) +
`preflightPanel` + `runSafe` resilience + LEARN + config. Assignment = **derangement** (pure, testable —
nobody attacks or judges their own proposal).

**Gate (do NOT ship on vibes):** A/B — dialectic vs flat-panel vs single-strong-model on a real task set,
scored by a held-out judge or ground truth. If it doesn't beat the panel *on substance*, the panel is
already good enough — don't pay the complexity.

## Config surface — one place to say which model runs which layer

mozaik provides the *mechanism* (model is a per-call parameter); the *mapping* is ours:

```jsonc
// auralis.config.json (repo root, optional — every key has a default)
{
  "runners": {
    "planner":   "claude:fable-5",
    "worker":    "glm:glm-4-plus",
    "synthesis": "claude:fable-5",
    "critic":    "gpt:gpt-5.5",
    "reviewer":  "claude:fable-5",
    "brainstorm": ["claude:fable-5", "gpt:gpt-5.5", "glm:glm-4-plus"]
  },
  "brainstorm": { "rounds": 3, "synthesizer": "claude:fable-5" }
}
```
Format `vendor[:model]`; env always wins (`AURALIS_CRITIC_RUNNER=gpt:gpt-5.5` overrides the file);
billing keys stay in `.env` (`OPENAI_API_KEY`, `GLM_API_KEY`, …) — never `.env.oracle`.
`auralis doctor` validates: every configured vendor has its key present.

## Out of scope (explicit)
Auto-routing by task difficulty (needs M3's tiers measured first) · Gemini/Aider runners (same seam,
add after ToolLoopRunner settles) · cross-machine claim TTL/lease (separate roadmap item) · streaming ·
free-form unbounded agent chat (every conversation here is round-limited with a structured output — the
bus is for coordination, not vibes).

## Sequence (updated 2026-07-13 — M6 shipped, M8 dialectic added)

```
M0 conformance ▶ M0.5 mozaik spike ▶ M1 ToolLoopRunner ▶ M3 hetero fleet ▶ M4 bench
                        │
                        └▶ M2 config surface ▶ M6 /brainstorm ✓SHIPPED ▶ M8 dialectic
                                             ▶ M5 model-per-role ─────────────┘ (M8 needs critic+reviewer roles)
```
Fastest path to the user-visible win: **M0 → M2 → M6** — *done*: `/brainstorm` with a live `claude+gpt`
panel is in hand. Next value step is **M5 → M8**: give critic/reviewer their own models, then turn the
simultaneous panel into the adversarial dialectic (crystallize what survives, not what agrees).
