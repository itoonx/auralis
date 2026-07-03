// Milestone #3: prove the brain persists ACROSS independent sessions. Seed the brain in one process,
// then run a related task in a SEPARATE process against the same on-disk brain — it recalls the seed
// findings and explores fewer targets than a cold session with no prior knowledge.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { oracleReachable } from "./memory";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const MAX_TURNS = String(process.env.AURALIS_MAX_TURNS ?? 10);
const BRAIN_DB = process.env.AURALIS_BRAIN_DB ?? ".auralis-out/persist-brain.sqlite";

const GOAL_SEED =
  "Analyze the shared core modules of this codebase (src/memory.ts, src/participants.ts, src/conductor.ts): what each does and how they connect. Be concise.";
const GOAL_RELATED =
  "Analyze how this codebase's live harness (src/run.ts) drives the shared core modules end to end. Be concise.";

async function ensurePersistentBrain(): Promise<() => void> {
  const child = spawn("bun", ["run", "oracle-lite/server.ts"], {
    env: { ...process.env, ORACLE_RESET: "1", ORACLE_DB: BRAIN_DB }, // clean once, then persist across sessions
    stdio: "inherit",
  });
  for (let i = 0; i < 60; i++) {
    if (await oracleReachable()) return () => { try { child.kill(); } catch { /* noop */ } };
    await new Promise((r) => setTimeout(r, 200));
  }
  try { child.kill(); } catch { /* noop */ }
  throw new Error("persistent brain failed to start on :47778 (is the port free?)");
}

function runSession(label: string, goal: string, cold: boolean) {
  const out = `${OUT}/session-${label}.json`;
  const r = spawnSync("pnpm", ["exec", "tsx", "src/session.ts"], {
    env: {
      ...process.env,
      AURALIS_SESSION_LABEL: label,
      AURALIS_GOAL: goal,
      AURALIS_METRICS_OUT: out,
      AURALIS_PROJECT_DIR: PROJECT_DIR,
      AURALIS_MAX_TURNS: MAX_TURNS,
      AURALIS_COLD: cold ? "1" : "0",
    },
    stdio: "inherit",
  });
  if (r.status !== 0) throw new Error(`session ${label} failed (exit ${r.status})`);
  return JSON.parse(readFileSync(out, "utf8")) as { crossSessionRecall: number; explored: number };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`target project: ${PROJECT_DIR}`);
  const stop = await ensurePersistentBrain();
  try {
    console.log("▶ session 1 (seed) — separate process, writes to the persistent brain…");
    runSession("seed", GOAL_SEED, false);
    console.log("▶ session 2 (warm) — SEPARATE process, same on-disk brain, related goal…");
    const warm = runSession("warm", GOAL_RELATED, false);
    console.log("▶ session 3 (cold baseline) — separate process, NO shared brain…");
    const cold = runSession("cold", GOAL_RELATED, true);

    console.log("\n─── auralis milestone #3 (cross-session persistence) ───");
    console.log(`warm: cross-session recall=${warm.crossSessionRecall}, explored=${warm.explored}`);
    console.log(`cold: cross-session recall=${cold.crossSessionRecall}, explored=${cold.explored}`);
    const pass = warm.crossSessionRecall >= 1 && warm.explored < cold.explored;
    console.log(
      pass
        ? `\n✅ milestone #3 met: a fresh, separate-process session recalled ${warm.crossSessionRecall} finding(s) from an earlier session and explored ${cold.explored - warm.explored} fewer target(s) than cold`
        : `\n⚠️  not met this run — see ${OUT}`,
    );
    process.exitCode = pass ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
