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
import { parseSpec, keyFor, PRESETS, loadConfig, type RunnerSpec } from "./runners";
import { ApiRunner } from "./runner";
import { OracleAdapter } from "./memory";

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
  console.error(`🧠 brainstorm: ${panel.map((s) => s.model ?? s.vendor).join(" · ")} → synth ${synth.model ?? synth.vendor} · ≤${rounds} rounds\n`);

  const result = await brainstorm(topic, panel.map(panelist), panelist(synth), {
    rounds,
    onEvent: (kind, _name, human) => console.error(kind === "dropped" ? `  ⚠ ${human}` : `  ${human}`),
  });

  console.log(`\n${"═".repeat(70)}\n🧠 SYNTHESIS (${result.converged}, ${result.roundsUsed} round${result.roundsUsed > 1 ? "s" : ""})\n${"═".repeat(70)}\n${result.synthesis}\n`);
  if (result.dropped.length) console.error(`⚠ dropped (no contribution): ${result.dropped.join(", ")} — check their keys/credits`);

  // LEARN — "จนกว่าจะได้เรียนรู้": the brief becomes a recallable decision-style memory, project-scoped.
  if (process.env.AURALIS_BRAINSTORM_NO_LEARN !== "1") {
    try {
      const brain = new OracleAdapter();
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
