// Live fleet harness: boot the brain, resolve the tasks (Planner or a fixed set), then run the
// coordinated society twice — shared brain vs. baseline — with real Claude Code workers over a target
// codebase, at the chosen parallelism. Reports fleet redundancy reduction + an auditable "why" trail.
// Tuning: AURALIS_PARALLEL=1 (default) maximises knowledge-sharing; >1 runs each DAG level concurrently.
import { resolve } from "node:path";
import { OracleAdapter, NullMemoryAdapter } from "./memory";
import { ensureOracle, resolveTasks, runFleet } from "./fleet";
import { explainProvenance } from "./audit";
import { buildLevels } from "./dag";
import { fleetRedundantCount, reductionPct } from "./metrics";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 10);
const PLAN_TURNS = Number(process.env.AURALIS_PLAN_TURNS ?? 6);
const CONCURRENCY = Number(process.env.AURALIS_PARALLEL ?? 1);
const GOAL =
  process.env.AURALIS_GOAL ??
  "Understand this codebase end-to-end: its architecture, core modules, primary end-to-end flow, and error handling.";

async function main() {
  console.log(`target project: ${PROJECT_DIR}  ·  parallel=${CONCURRENCY}`);
  const stop = await ensureOracle();
  try {
    console.log("· resolving tasks…");
    const nodes = await resolveTasks(PROJECT_DIR, GOAL, PLAN_TURNS);
    console.log(`${nodes.length} task(s), ${buildLevels(nodes).length} level(s): ${nodes.map((n) => n.id).join(", ")}`);
    const cfg = { projectDir: PROJECT_DIR, project: PROJECT, maxTurns: MAX_TURNS, concurrency: CONCURRENCY, out: OUT };

    console.log("▶ baseline (no shared memory)…");
    const base = await runFleet("baseline", new NullMemoryAdapter(), nodes, cfg);
    console.log("▶ shared brain…");
    const shared = await runFleet("shared", new OracleAdapter(), nodes, cfg);

    const baseRed = fleetRedundantCount(base.outcome.perWorker.map((w) => w.explored));
    const sharedRed = fleetRedundantCount(shared.outcome.perWorker.map((w) => w.explored));
    const pct = reductionPct(baseRed, sharedRed);

    console.log("\n─── auralis fleet run ───");
    console.log(`baseline: fleet-redundant=${baseRed}, sentry overlap warnings=${base.warnings}`);
    console.log(`shared  : fleet-redundant=${sharedRed}, sentry overlap warnings=${shared.warnings}, reuses=${shared.outcome.reuses}`);
    console.log(`redundancy reduction: ${(pct * 100).toFixed(1)}%   (target ≥ 30%)`);
    console.log("\n" + explainProvenance(shared.outcome.provenance));

    const pass = pct >= 0.3 && shared.outcome.reuses >= 1;
    console.log(pass ? "\n✅ fleet coordination met on live data" : `\n⚠️  not met this run — see ${OUT}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
