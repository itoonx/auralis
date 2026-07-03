// Multi-trial benchmark: run the baseline-vs-shared fleet N times over a (preferably fixed) task set,
// resetting the brain between trials, and report the DISTRIBUTION of redundancy reduction — mean, min,
// max, stddev — instead of a single noisy number. Turns "directional" into "robust".
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { OracleAdapter, NullMemoryAdapter } from "./memory";
import { ensureOracle, resolveTasks, runFleet } from "./fleet";
import { fleetRedundantCount, reductionPct } from "./metrics";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const PROJECT = process.env.AURALIS_PROJECT ?? "bench";
const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 8);
const PLAN_TURNS = Number(process.env.AURALIS_PLAN_TURNS ?? 5);
const CONCURRENCY = Number(process.env.AURALIS_PARALLEL ?? 1);
const TRIALS = Math.max(1, Number(process.env.AURALIS_TRIALS ?? 1));
const GOAL =
  process.env.AURALIS_GOAL ??
  "Understand this codebase end-to-end: architecture, core modules, primary flow, and error handling.";

function stats(xs: number[]) {
  const n = xs.length || 1;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { mean, min: Math.min(...xs), max: Math.max(...xs), stddev: sd, n: xs.length };
}

async function main() {
  process.env.ORACLE_ALLOW_RESET = "1"; // let the sidecar wipe the brain between trials
  console.log(`bench: project=${PROJECT_DIR} · trials=${TRIALS} · parallel=${CONCURRENCY}`);
  const stop = await ensureOracle();
  try {
    const nodes = await resolveTasks(PROJECT_DIR, GOAL, PLAN_TURNS);
    console.log(`${nodes.length} task(s): ${nodes.map((n) => n.id).join(", ")}`);
    const cfg = { projectDir: PROJECT_DIR, project: PROJECT, maxTurns: MAX_TURNS, concurrency: CONCURRENCY };
    const brain = new OracleAdapter();
    const reductions: number[] = [];
    const reuseCounts: number[] = [];

    for (let t = 1; t <= TRIALS; t++) {
      await brain.reset!(); // each trial starts from an empty brain
      const base = await runFleet(`bench-base-${t}`, new NullMemoryAdapter(), nodes, cfg);
      const shared = await runFleet(`bench-shared-${t}`, brain, nodes, cfg);
      const pct = reductionPct(
        fleetRedundantCount(base.outcome.perWorker.map((w) => w.explored)),
        fleetRedundantCount(shared.outcome.perWorker.map((w) => w.explored)),
      );
      reductions.push(pct * 100);
      reuseCounts.push(shared.outcome.reuses);
      console.log(`trial ${t}/${TRIALS}: reduction=${(pct * 100).toFixed(1)}%  reuses=${shared.outcome.reuses}`);
    }

    const s = stats(reductions);
    console.log(`\n─── bench summary (${TRIALS} trial${TRIALS > 1 ? "s" : ""}, parallel=${CONCURRENCY}) ───`);
    console.log(`redundancy reduction: mean ${s.mean.toFixed(1)}% · min ${s.min.toFixed(1)}% · max ${s.max.toFixed(1)}% · sd ${s.stddev.toFixed(1)}`);
    console.log(`reuses per run: ${reuseCounts.join(", ")}`);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(
      `${OUT}/bench-summary.json`,
      JSON.stringify({ trials: TRIALS, concurrency: CONCURRENCY, project: PROJECT_DIR, reductionPct: reductions, reuses: reuseCounts, summary: s }, null, 2),
    );
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
