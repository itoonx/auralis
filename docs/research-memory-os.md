# Research: oracle-lite vs the "Memory Operating System" — gaps, strengths, upgrades

Date: 2026-07-07 · Inputs: two parallel research sweeps (system landscape 2025–26; techniques
deep-dive with formulas) + a code-level inventory of oracle-lite. Full agent reports are the
source; this doc is the decision layer: what we have, what the field has, what to build, what to skip.

> **Status (2026-07-07, post-implementation): U1–U4 shipped and measured.**
> U1+U2 `8274ea8` · U3 `296aeaf` · U4 `73db755` · A/B ranking bench `f3fd542` (plain 25% → full 75%
> precision@1, guardrail held) · live validation: real workers cited 4 findings unprompted.
> **Deviations from the plan, forced by measurement:**
> - trust boost weight is **0.05**, not 0.2 — the bench's guardrail proved 0.2 let trust override a genuine
>   relevance win (RRF is rank-only: it can't tell a near-tie from a real gap, so a strong multiplier flips
>   both). Trust's real teeth are in forgetting (`strength()`), exactly as §U2 hinted.
> - a **stopword filter** was added to FTS query sanitization — the bench exposed that query stopwords let
>   every doc match and boosts amplified noise.
> - retros are recorded every run but **pinned only on a hard lesson** (measured failure fixed, or
>   self-repairs) — no-lesson "repeat structure" retros fade via U4 instead of accumulating (utility audit).
> - anti-poisoning guards (critic rejects infra errors; rejected results never captured; dead runs write no
>   retro) added after a real dead run stored "Credit balance is too low" as a finding — the field's gap #1
>   (MINJA) reproduced by an outage, no attacker needed.
> **U6 shipped (2026-07-07):** bi-temporal columns (`valid_at`/`invalid_at` + provenance), `POST
> /api/invalidate` (world-changed, distinct from supersede = we-were-wrong), and `search?as_of=T` with
> VALID-time semantics (truth-at-T; superseded docs never qualify; belief-time deliberately deferred).
> Ranking sinks invalidated docs exactly like superseded ones — in NOW mode only; in as_of mode nothing
> sinks, because everything returned WAS true at T. Integration-tested (30s→60s timeout scenario: now,
> before-the-change, after-the-change) with both benches unregressed.
> **U5 + U7 shipped (2026-07-07) — the plan is complete (U1–U7).** U7: atomic `VACUUM INTO` snapshot
> (keep 5) before any automated mass-mutation, + `POST /api/snapshot`. U5 splits by capability: the
> SERVER half (`POST /api/sleep`, nightly) snapshots then runs the mechanical dedup pass (same-entity,
> cos ≥ 0.92 → supersede older/lower-trust, counters carried, pinned never loses) and returns the
> ambiguous band (0.75–0.92) as candidates; the HOST half (`pnpm sleep`) judges each pair with Claude —
> contradictory → the newer fact **invalidates** the older (the automatic writer of `invalid_at`, as
> planned), duplicate → supersede, unparseable → never act. Promotion (episodic→semantic summaries) is
> deliberately served by the existing `pnpm distill` instead of a new pass — the literature's strongest
> negative result (summarization destroys retrievable detail) argues against more summarizing machinery.
> Known limit, stated honestly: with the builtin trigram embedder a single-value contradiction can look
> ≥0.92-identical and get deduped (right outcome — old value sinks — but labelled supersede, not
> invalidate); real sentence embeddings (`AURALIS_SEMANTIC=1`) sharpen the band.
> Proven live: snapshot file created → AuthGuard near-dup superseded mechanically → CacheLayer 10min→30min
> pair judged "contradictory" and invalidated with the reason recorded. 89 tests green.

---

## 1. Where oracle-lite stands today (from code, not memory)

| Capability | Today | Notes |
|---|---|---|
| Store | `docs(id, content, concepts, project, source, created_at, tier, superseded_*)` | append-only, no delete route |
| Retrieval | FTS5 + LanceDB hybrid: `0.5·(1/(1+bm25)) + 0.5·cosine`, ×0.3 superseded | score scales are incompatible — naive fusion |
| Graph | `edges` triplets (normalized entity keys) + graph-expand in recall | benchmarked (M3) |
| Episodic | `events` timeline, DAG-linked, append-only | dashboard replay |
| Coordination | `/api/claim` registry, **enforced** via PreToolUse deny | cross-process, per-run scoped |
| Provenance | `source` per doc; supersede chain with reason | source **unused in ranking** |
| Reflection | ⟲ RETRO records from run signals; recalled into planner | recall proven; behaviour-change not yet |
| Consolidation | `pnpm distill` (raw→distilled tier) | manual |
| Trust / usage / decay / TTL | — | none |
| Governance | — | no auth (single-user) |

## 2. The landscape in one paragraph

Mem0 = LLM extract + ADD/UPDATE/DELETE, efficiency not accuracy (full-context beats it on LOCOMO).
Letta = agent-edited memory blocks + **sleep-time compute** (proven ~5× compute ↓ on proxy tasks).
Zep/Graphiti = temporal KG, **bi-temporal** (`valid_at`/`invalid_at`), hybrid cosine+BM25+graph with
RRF — best retrieval + provenance story, never forgets (monotonic growth). LangMem = best docs,
thinnest product. MemOS/MemoryOS = academic OS-metaphor systems, self-benchmarked. Memoria
(MatrixOrigin, 2026) = "git for memory" (branch/merge/rollback) — novel primitive, zero independent
evidence. Benchmarks are in a validity crisis (Mem0 vs Zep: same system, same benchmark, 58% vs 75%
depending on who runs it). **Retrieval is mostly solved; judgment (believing, revising, forgetting) is not.**

## 3. Our strengths — validated against the field's 9 open gaps

The landscape sweep's "what nobody does well yet" list maps directly onto what auralis already has:

1. **Enforced multi-agent coordination (their gap #5).** The field has *mechanisms without semantics*
   — shared blocks/namespaces/graphs but "no transactions, no conflict resolution between concurrent
   writers." Our claim registry + PreToolUse **deny** is exactly the missing semantics: deterministic
   first-wins ownership, measured (`prevented-clobbers=1`, `prevented-dupes=3`). **This is the moat — keep leading with it.**
2. **Objectively-grounded reflection (their gap #4's quality problem).** Everyone's reflection
   "generates text, not validated abstractions." Our ⟲ RETRO is templated **from measured run signals**
   (acceptance PASS/FAIL, reworks) — it cannot hallucinate a lesson. Same ethos as VerificAgent's
   verify-then-freeze.
3. **Measured, not asserted (their gap #7).** The field's evaluation regime collapsed into vendor
   methodology wars. We run an A/B baseline arm inside every fleet run and benchmarked the graph
   (M3) before defaulting it on. Keep this discipline; it is rarer than any feature.
4. **No LLM in the write path (their gap #8).** Mem0/Zep/Cognee pay LLM calls per write; our
   `learn()` stores worker findings directly — free writes. (The graph build is opt-in LLM.)
5. **Append-only + supersede is the right skeleton (their §5 consensus).** Zep invalidates rather than
   deletes; event-sourcing keeps the log primary. We already do this. And the research is explicit:
   **git branch/merge/rebase do NOT translate to memory** — beliefs have no merge semantics.
   Skipping Memoria-style branching is correct, not laziness.

## 4. Upgrades — ranked by value/cost (the techniques report compressed)

Everything below fits in ~10 SQLite columns + 3 formulas + 1 nightly job. Relevance stays dominant:
every new signal is a **multiplier that nudges, never a gate** (the one lesson Mem0 and Zep agree on).

### U1 · Ranking v2 — RRF fusion + boosts  *(highest value, ~1 day)*
Replace the incompatible-scale fusion with rank-only **Reciprocal Rank Fusion**:
```
RRF(d) = Σ_lists 1/(60 + rank_list(d))          # FTS list + vector list
final(d) = RRF(d) × (1 + 0.2·recency + 0.1·usage + 0.2·trust)
recency = 2^(−days_since_last_access/14) · usage = log(1+times_used)/log(1+max) · trust = §U2
```
Hybrid+proper fusion is worth 26–31% NDCG over dense-only in the literature. Needs columns:
`last_accessed_at`, `times_used` (touched on retrieval — MemoryBank reinforcement for free).

### U2 · Trust by source  *(high value, trivial)*
The `source` column exists and is ignored — the field's gap #1 (nobody ranks by credibility). Static priors:
```
human_stated 1.0 · derived_from_test (⟲ RETRO from acceptance) 0.85 · tool_observed 0.7
agent_inferred (worker finding) 0.5 · hearsay 0.3
trust = min(1, prior + 0.05·corroborations) − 0.1 if disputed
```
Our acceptance-derived retros are *naturally* tier-0.85 memories — objectively grounded. One column + one map.

### U3 · Usage feedback — close the utility loop  *(medium, small)*
Track whether recalled memories actually helped: `retrieved_count` (served), `used_count` (worker
**cites the memory id** — make citation part of the brain tool contract), and
`utility = (used+1)/(retrieved+2)` (Laplace-smoothed). Feeds U1's usage term; junk that keeps matching
but never helps fast-tracks to archive. Feedback touches **counters only, never content** (drift/contagion guard).

### U4 · Forgetting-as-ranking + archive  *(medium, small)*
No hard delete — compute strength at read time, archive below threshold:
```
strength = trust × (1+log(1+times_used)) × 2^(−days/h)   # h: raw 14d · distilled 90d
pinned (decisions, human-stated, retros) = exempt, forever
```
Nightly: `archived=1 WHERE strength<0.05 AND pinned=0`; default search excludes archived, deep-search includes.
The empirical case is real: unmanaged accumulation measurably *degrades* agents (experience-following studies).

### U5 · Nightly consolidation ("sleep job")  *(medium, needs care)*
One cron, no second agent: (a) dedup — same-entity pairs with cosine ≥0.92 → supersede older/lower-trust,
carry counters; (b) contradiction — same-entity pairs in the 0.75–0.92 band → one cheap LLM call →
supersede loser or mark `disputed`; (c) promote — ≥3 old episodic memories on one entity → one semantic
summary citing originals, originals archived. **Never summarize as dedup** — the literature's strongest
negative result (summaries destroy the details QA later needs; Hindsight replications).

### U6 · Bi-temporal distinction  *(low priority, cheap)*
Add `valid_at`/`invalid_at` + `op` columns: **superseded = we were wrong; invalidated = the world
changed**. Zep proved the model; we adopt the semantics without the graph rewrite. Do when U5's
contradiction pass needs somewhere to record "was true, then changed".

## 4b. Memoria deep-dive (source-level, cloned and read — 2026-07-07)

We cloned `matrixorigin/Memoria` and read the Rust core (`memoria/crates/*`). Two findings streams:

**Real and worth stealing:**
- **Production fusion formula** (`store.rs:5678-5713`): `0.3·vec + 0.2·keyword + 0.2·time + 0.3·confidence`,
  where confidence = per-tier decay (T1 Verified 365d → T4 Unverified 30d half-life). Then a
  **feedback multiplier**: `clamp(1 + w·(useful − 0.5·(irrelevant+outdated+wrong)), 0.5, 2.0)` with `w`
  auto-tuned per user into [0.05, 0.2]. Validates U1/U2/U3 — and refines them (see below).
- **`access_count` is deliberately EXCLUDED from ranking** — their comment: "repeated evaluation
  otherwise creates self-reinforcing winners." They rank on *explicit feedback* (useful/irrelevant/
  outdated/wrong), not raw retrieval counts. → refines our U3: weight **cited-and-helped**, not merely retrieved.
- **Confidence floor at retrieval** (`< 0.05` → hidden): retrieval-time forgetting with zero
  background jobs. → cheap addition to U4.
- **Auto safety-snapshot before every destructive op** (+ quota, keep 10): in SQLite this is one
  `VACUUM INTO` — atomic, which their MatrixOne rollback notably is *not* (DELETE+INSERT, two statements).
- **MCP tool ergonomics**: `dry_run` previews, conflict strategy `fail` by default, token-lean output.

**Advertised but dead (the anti-lesson):**
- "Self-governing contradiction detection" scans `association` edges — **no production code ever
  creates an edge** (edge-writing exists only in tests; backfill's edge creation is commented out).
  `conflicts_detected` is structurally always 0. Trust-tier promotion/demotion likewise operates only
  on node types created in `#[cfg(test)]`. The cognitive layer the README leads with is read-path
  formulas with no write path — **it runs and reports zeros**.
- Trust default is `T1 "Verified"` (0.95, slowest decay) for *unvetted* direct writes and raw chat
  fallback — "Verified" means nothing. Lesson: **trust defaults must be low**, promotion earned.
- Half-life math is internally inconsistent (missing ln2 in core+quarantine vs correct in graph
  retriever) — memories decay ~44% faster than documented. Two implementations, no test caught it.
- "Quarantine" is a hard `DELETE`, not isolation. Merge is copy-over ("not a full git-style
  reconcile" — their own comment), rollback is non-atomic, benchmarks are self-referential substring matching.

**What this means for us:** Memoria's own trajectory *proves our skeleton*: their real semantics
live in ~7 columns (`is_active` + `superseded_by` chains) with app-level set logic — i.e. what
oracle-lite already has. And our graph actually **writes** edges in production (proven
`graph.build=4` + `graph.expand=4` in the mechanism campaign) — we are ahead of them on the one
thing their README leads with. The deepest lesson is our own ethos reflected back: they shipped
formulas without wiring the write path and never measured, so the flagship features silently no-op.
**Wire the write path first; measure before claiming.**

**Upgrade refinements from this deep-dive:**
- U3: count `used_count` only on **citation** (agent names the memory id), never on retrieval —
  Memoria's anti-self-reinforcement argument is correct. Add their four-way feedback verbs later if needed.
- U4: add the **retrieval-time confidence floor** (hide strength < 0.05) — forgetting without a job.
- **U7 (new, tiny): safety snapshot** — `VACUUM INTO backups/pre-<op>-<ts>.db` before distill/sleep-job
  runs, keep last N. One line, atomic, better than Memoria's own rollback.

## 5. What NOT to build (YAGNI, with reasons)

- **Branch/merge/rebase of memories** — beliefs don't merge; the field's own research says these git
  concepts don't translate. Confirmed at source level: Memoria's merge is copy-over with an
  embedding-similarity trigger and branch-wins overwrite; their group mode *disables* merge entirely.
- **Write-time LLM importance scoring** (Generative Agents' 1–10) — static and noisy; usage+trust carry the signal.
- **Approval workflows / RBAC / multi-tenancy / data residency** — single-user tool; revisit only if oracle serves a team.
- **Multi-storage split** (Postgres+Redis+event bus+…) — bun:sqlite+LanceDB is orders of magnitude below its limits here.
- **Learned re-rankers / RL write policies** (Memory-R1) — research frontier; formula-based ranking first, measure, then decide.
- **Cross-encoder reranking** — optional polish after U1 proves out, not foundation.

## 6. Proposed sequence

1. **U1+U2 together** (columns + RRF + trust map) → measure recall quality before/after on the
   graph-recall bench (M3) — this is the "instrument validated first" step.
2. **U3** (citation contract in brain-mcp) → gives real usage data for U1's boost and U4's strength.
3. **U4** (archive job) after a few weeks of usage data exist.
4. **U5** (sleep job) last — it needs U2's trust to pick supersede winners and U3's counters to carry.
   U7's safety snapshot ships with it (one line, before every run).
5. U6 folded into U5's contradiction pass.

Each step ships with a before/after measurement — the same discipline that got us here.
