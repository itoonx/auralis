// `pnpm lifecycle` — the PRODUCTION TRIGGER for the LLM half of the memory lifecycle.
//
// The oracle daemon runs the heuristic half on its own 24h timer (dedup, graph edges, forgetting) — no LLM,
// so it fires in the container. The JUDGMENT half (contradiction → invalidation via `pnpm sleep`, and
// consolidation → distillation via `pnpm distill`) needs an LLM the daemon doesn't have. Nothing scheduled
// it, so on a dogfooded brain it was dormant: invalid_at=0, tier=raw everywhere (M0 review finding).
//
// This host-side loop closes that gap on the SAME cadence as the daemon's dedup. Run it unattended with a
// CHEAP runner pointed at the daemon — it never touches the interactive Claude window:
//   AURALIS_RUNNER=api  AURALIS_RUNNER_MODEL=gpt-4o-mini  OPENAI_API_KEY=...  pnpm lifecycle
// or a local model (free):
//   AURALIS_RUNNER=api  AURALIS_RUNNER_API_URL=http://localhost:11434/v1/chat/completions  AURALIS_RUNNER_MODEL=llama3.1  pnpm lifecycle
//
// env: AURALIS_LIFECYCLE_INTERVAL_MS (default 24h) · AURALIS_LIFECYCLE_ONCE=1 (one cycle then exit — for cron)
import { spawn } from "node:child_process";

const INTERVAL = Number(process.env.AURALIS_LIFECYCLE_INTERVAL_MS ?? 24 * 3600 * 1000);
// The whole point of this loop is the LLM lifecycle — turn both LLM passes on unless the caller opted out.
process.env.AURALIS_SLEEP_LLM ??= "1";
process.env.AURALIS_DISTILL_LLM ??= "1";

function runScript(script: string): Promise<number> {
  return new Promise((res) => {
    const child = spawn("pnpm", ["exec", "tsx", script], { stdio: "inherit", env: process.env });
    child.on("exit", (code) => res(code ?? 0));
    child.on("error", (e) => { console.error(`  ${script} failed to spawn:`, String(e).slice(0, 120)); res(1); });
  });
}

async function cycle(): Promise<void> {
  const runner = process.env.AURALIS_RUNNER === "api" ? `api:${process.env.AURALIS_RUNNER_MODEL ?? "gpt-4o-mini"}` : "claude(interactive)";
  console.log(`\n━━━ lifecycle cycle (runner=${runner}) ━━━`);
  await runScript("src/run-sleep.ts");   // contradiction → invalidation (+ dedup via the server half)
  await runScript("src/run-distill.ts"); // consolidation → distillation (tier promotion)
}

async function main() {
  if (process.env.AURALIS_RUNNER !== "api") {
    console.warn("⚠ AURALIS_RUNNER is not 'api' — this loop will use the INTERACTIVE Claude runner and can exhaust the session window.");
    console.warn("  For unattended production use set: AURALIS_RUNNER=api  AURALIS_RUNNER_MODEL=<cheap model>  (+ a key or a localhost URL).");
  }
  await cycle(); // run once immediately
  if (process.env.AURALIS_LIFECYCLE_ONCE === "1") return; // cron mode: one shot, let the scheduler repeat
  console.log(`\nlifecycle loop armed — next cycle in ${Math.round(INTERVAL / 3600000)}h`);
  setInterval(() => { cycle().catch((e) => console.error("lifecycle cycle error:", e)); }, INTERVAL);
}

main().catch((e) => { console.error(e); process.exit(1); });
