// `pnpm brainstorm "<topic>"` (and the /brainstorm command / MCP tool) — spin up a multi-model panel,
// converge, synthesize, and LEARN the brief into the shared brain so every future session/worker recalls it.
// Panel = config runners.brainstorm (or AURALIS_BRAINSTORM_PANEL="gpt:gpt-5.5,glm:glm-4-plus,claude").
// Brainstorming is TOOL-LESS (thinking, not exploring) — so each panelist is a plain text-out runner.
import "./load-env"; // oracle secrets (.env.oracle) → the LEARN step authenticates to the live brain
// Billing keys (OPENAI_API_KEY, GLM_API_KEY…) live in .env, which tsx/Node does NOT auto-load — do it here
// so a `/brainstorm` panel authenticates out of the box. Shell env wins (loadEnvFile won't clobber it).
try { process.loadEnvFile(new URL("../.env", import.meta.url)); } catch { /* no .env — key-less panelists error clearly */ }
// The Claude panelist runs on the Claude Code CLI login (the user's setup), NOT a stray ANTHROPIC_API_KEY —
// which is often a separate API account that may be out of credits. Drop it so the Agent SDK falls back to
// the CLI login. Opt back into the API key with AURALIS_BRAINSTORM_ANTHROPIC_API=1 (headless/CI, no CLI login).
if (process.env.AURALIS_BRAINSTORM_ANTHROPIC_API !== "1") delete process.env.ANTHROPIC_API_KEY;
import { brainstorm, type Panelist } from "./brainstorm";
import { preflightPanel } from "./brainstorm-preflight";
import { parseSpec, keyFor, PRESETS, loadConfig, type RunnerSpec } from "./runners";
import { ApiRunner } from "./runner";
import { OracleAdapter } from "./memory";
import { makeEmitter } from "./narrate";

const PROJECT = process.env.AURALIS_PROJECT ?? "default";

// A tool-less panelist from a spec: claude → the Agent SDK (no key), else an OpenAI-compatible chat call.
function panelist(spec: RunnerSpec): Panelist {
  const name = spec.model ? `${spec.vendor}:${spec.model}` : spec.vendor;
  if (spec.vendor === "claude") {
    // ClaudeCodeRunner is tool-driven; for pure thinking we use a minimal Agent SDK text call via ApiRunner's
    // sibling path is overkill — reuse ApiRunner pointed at Anthropic-compatible? No: keep it simple, the
    // Claude panelist runs through the Agent SDK query with no tools. Lazy-import to avoid SDK cost in tests.
    return {
      name,
      run: async (prompt) => {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        let out = "";
        for await (const m of query({ prompt, options: { maxTurns: 1, allowedTools: [] } as any })) {
          const msg: any = m;
          if (msg.type === "result" && msg.subtype === "success") out = String(msg.result ?? "");
        }
        return out.trim();
      },
    };
  }
  const preset = PRESETS[spec.vendor];
  const key = keyFor(spec);
  if (!key.ok) throw new Error(`brainstorm panelist "${name}" needs one of: ${key.missing?.join(" / ")} (set it in .env / shell)`);
  const runner = new ApiRunner({ url: `${preset.baseURL.replace(/\/$/, "")}/chat/completions`, model: spec.model ?? preset.defaultModel, key: key.keyEnv ? process.env[key.keyEnv] : undefined });
  return { name, run: async (prompt) => (await runner.run(prompt)).result };
}

// Liveness/credit probe for preflight: Claude uses the CLI login (no pay-per-call balance risk), so it's
// assumed live and any auth issue surfaces in round 0. A paid provider must have a key AND answer a tiny
// call — a 429 "out of credits" / 401 throws HERE, before the real brainstorm spends anything.
async function liveProbe(spec: RunnerSpec): Promise<void> {
  if (spec.vendor === "claude") return;
  const key = keyFor(spec);
  if (!key.ok) throw new Error(`no key (${key.missing?.join(" / ")})`);
  await panelist(spec).run("Reply with the single word: ok"); // ponytail: no max_tokens yet — the terse prompt keeps it cheap
}

function panelSpecs(): { panel: RunnerSpec[]; synth: RunnerSpec } {
  const cfg = loadConfig();
  const rawPanel = (process.env.AURALIS_BRAINSTORM_PANEL?.split(",").map((s) => s.trim()).filter(Boolean)) ?? cfg.runners?.brainstorm ?? ["claude"];
  const panel = rawPanel.map(parseSpec);
  const synth = parseSpec(process.env.AURALIS_BRAINSTORM_SYNTH ?? cfg.brainstorm?.synthesizer ?? rawPanel[0]);
  return { panel, synth };
}

async function main() {
  const topic = process.argv.slice(2).join(" ").trim();
  if (!topic) { console.error('usage: pnpm brainstorm "<topic or design question>"'); process.exit(1); }
  const rounds = Number(process.env.AURALIS_BRAINSTORM_ROUNDS ?? loadConfig().brainstorm?.rounds ?? 3);
  const { panel, synth } = panelSpecs();

  // Preflight — a paid provider with no key or no balance must not start work, and must not fail silently.
  console.error(`🔎 preflight — each paid provider needs a key + balance before we start:`);
  const pf = await preflightPanel(panel, synth, liveProbe, (l) => console.error(l));
  if (!pf.panel.length || !pf.synth) {
    console.error(`\n✗ no usable panelists — every provider failed preflight (keys / credits). Nothing to brainstorm.`);
    process.exit(1);
  }
  if (pf.excluded.length) console.error(`⚠ running without: ${pf.excluded.map((e) => e.name).join(", ")} — fix keys/credits to include them`);
  console.error(`🧠 brainstorm: ${pf.panel.map((s) => s.model ?? s.vendor).join(" · ")} → synth ${pf.synth.model ?? pf.synth.vendor} · ≤${rounds} rounds\n`);

  // Timeline wiring — the studio replays a brainstorm like any fleet run. Best-effort by construction
  // (makeEmitter swallows a dead oracle), so observability can never block or slow the debate.
  const brain = new OracleAdapter();
  const runId = `brainstorm-${Date.now().toString(36)}`;
  const emit = makeEmitter({ adapter: brain, runId, project: PROJECT });
  emit("prompt", "user", topic);
  pf.excluded.forEach((e) => emit("dropped", e.name, `${e.name} excluded at preflight — ${e.reason}`));

  const result = await brainstorm(topic, pf.panel.map(panelist), panelist(pf.synth), {
    rounds,
    onEvent: (kind, name, human) => {
      console.error(kind === "dropped" ? `  ⚠ ${human}` : `  ${human}`);
      emit(kind, name, human);
    },
  });

  // position.delta — who flipped their vote, at which round (the chart's spine, per the observability
  // design). Derived from result.rounds after the fact: no engine change, order preserved.
  const norm = (v: string) => v.toLowerCase().replace(/\s+/g, " ").trim();
  let flips = 0, lastRoundFlips = 0;
  for (let r = 1; r < result.rounds.length; r++) {
    for (const e of result.rounds[r]) {
      const prev = result.rounds[r - 1].find((p) => p.name === e.name);
      if (prev && e.vote && prev.vote && norm(prev.vote) !== norm(e.vote)) {
        flips++;
        if (r === result.rounds.length - 1) lastRoundFlips++;
        emit("flip", e.name, `${e.name} flipped (round ${r + 1}): "${prev.vote.slice(0, 60)}" → "${e.vote.slice(0, 60)}"`);
      }
    }
  }

  // Trust badge — flip TIMING, not count (earned = flipped under challenge then settled; groupthink =
  // agreement that was never challenged; unstable = still churning at the cap).
  // ponytail: v1 heuristic, thresholds calibrate on real runs — the chart milestone owns tuning.
  const badge =
    pf.panel.length < 2 ? "solo (single panelist — no cross-examination)"
    : result.converged === "max-rounds" && lastRoundFlips > 0 ? "unstable — still flipping in the final round; debate never closed"
    : flips === 0 ? "groupthink? — converged with zero flips; agreement was never challenged"
    : "earned — flipped under challenge, then settled";
  emit("note", "trust", `trust: ${badge} (${flips} flip${flips === 1 ? "" : "s"}, ${result.converged}, ${result.roundsUsed} rounds)`);
  emit("answer", "synthesizer", `${result.converged} in ${result.roundsUsed} round(s) — ${result.synthesis.slice(0, 200)}`);
  console.error(`\n🎖 trust: ${badge}`);

  console.log(`\n${"═".repeat(70)}\n🧠 SYNTHESIS (${result.converged}, ${result.roundsUsed} round${result.roundsUsed > 1 ? "s" : ""})\n${"═".repeat(70)}\n${result.synthesis}\n`);
  if (result.dropped.length) console.error(`⚠ dropped (no contribution): ${result.dropped.join(", ")} — check their keys/credits`);

  // LEARN — "จนกว่าจะได้เรียนรู้": the brief becomes a recallable decision-style memory, project-scoped.
  if (process.env.AURALIS_BRAINSTORM_NO_LEARN !== "1") {
    try {
      const contributors = (result.rounds.at(-1) ?? []).map((e) => e.name); // who actually spoke, not who was configured
      const pattern =
        `Brainstorm decision — ${topic}\n` +
        `Panel: ${contributors.join(", ")}${result.dropped.length ? ` (dropped: ${result.dropped.join(", ")})` : ""} (${result.converged} in ${result.roundsUsed} rounds)\n` +
        `Best answer & rationale:\n${result.synthesis}`;
      const { id } = await brain.learn(pattern, { project: PROJECT, concepts: ["brainstorm", "decision"], source: "auralis:brainstorm", pinned: true });
      console.error(`✓ learned into the brain (${id}) — recallable in every future session`);
    } catch (e) { console.error(`⚠ brainstorm not saved (oracle unreachable): ${String(e).slice(0, 120)}`); }
  }
}

main().catch((e) => { console.error(`✗ ${(e as Error).message}`); process.exit(1); });
