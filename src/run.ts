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
import { log } from "./log";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 10);
const PLAN_TURNS = Number(process.env.AURALIS_PLAN_TURNS ?? 6);
const CONCURRENCY = Number(process.env.AURALIS_PARALLEL ?? 1);
const RETRIES = Number(process.env.AURALIS_RETRIES ?? 1); // self-repair retries per task
const WORKER_PULL = process.env.AURALIS_WORKER_PULL !== "0"; // workers read/write the brain live, mid-task (real-time sharing); =0 to opt out
const RUN_BASELINE = process.env.AURALIS_BASELINE !== "0"; // prod mode (=0): skip the baseline A/B arm — run only the shared brain
const GOAL =
  process.env.AURALIS_GOAL ??
  "Understand this codebase end-to-end: its architecture, core modules, primary end-to-end flow, and error handling.";

async function main() {
  console.log(`target project: ${PROJECT_DIR}  ·  parallel=${CONCURRENCY}  ·  worker-pull=${WORKER_PULL}  ·  baseline=${RUN_BASELINE}`);
  log.reset(`${OUT}/timing.jsonl`);
  const stop = await log.time("oracle.boot", undefined, () => ensureOracle());
  try {
    console.log("· resolving tasks…");
    const nodes = await log.time("plan", undefined, () => resolveTasks(PROJECT_DIR, GOAL, PLAN_TURNS));
    console.log(`${nodes.length} task(s), ${buildLevels(nodes).length} level(s): ${nodes.map((n) => n.id).join(", ")}`);
    const cfg = { projectDir: PROJECT_DIR, project: PROJECT, maxTurns: MAX_TURNS, concurrency: CONCURRENCY, maxRetries: RETRIES, workerPull: WORKER_PULL, out: OUT };

    // Redundancy that matters is duplicate FILE reads (expensive). Glob/grep are cheap discovery scans
    // that different workers reasonably repeat, so split them: read-redundant is the headline the claim
    // gate acts on; scan-redundant is a secondary note, not counted against the run.
    const READ_ONLY = new Set(["Read"]);
    const SCAN_ONLY = new Set(["Grep", "Glob"]);
    // The baseline is the A/B control that MEASURES the brain's value — pure overhead for a real run.
    // Prod mode (AURALIS_BASELINE=0) skips it and runs only the shared brain, roughly halving wall time.
    let baseRead: number | undefined;
    let baseWarnings = 0;
    if (RUN_BASELINE) {
      console.log("▶ baseline (no shared memory)…");
      const base = await log.time("arm.baseline", undefined, () => runFleet("baseline", new NullMemoryAdapter(), nodes, cfg));
      baseRead = fleetRedundantCount(base.outcome.perWorker.map((w) => w.explored), READ_ONLY);
      baseWarnings = base.warnings;
    }

    console.log(RUN_BASELINE ? "▶ shared brain…" : "▶ shared brain (prod — no baseline)…");
    const shared = await log.time("arm.shared", undefined, () => runFleet("shared", new OracleAdapter(), nodes, cfg));
    const explored = shared.outcome.perWorker.map((w) => w.explored);
    const sharedRead = fleetRedundantCount(explored, READ_ONLY);
    const sharedScan = fleetRedundantCount(explored, SCAN_ONLY);

    console.log("\n─── auralis fleet run ───");
    if (baseRead !== undefined) console.log(`baseline: read-redundant=${baseRead} file(s), sentry overlap warnings=${baseWarnings}`);
    console.log(`shared  : read-redundant=${sharedRead} file(s), scan-redundant=${sharedScan} glob/grep, sentry overlap warnings=${shared.warnings}, reuses=${shared.outcome.reuses}, self-repairs=${shared.outcome.repairs}`);
    console.log(`realtime: live-pushes=${shared.live.learns}, live-pulls=${shared.live.hits}/${shared.live.searches} hit, claims=${shared.live.claims}, prevented-dupes=${shared.live.skips}`);
    if (baseRead !== undefined) console.log(`redundancy reduction (file reads): ${(reductionPct(baseRead, sharedRead) * 100).toFixed(1)}%   (target ≥ 30%)`);
    console.log("\n" + explainProvenance(shared.outcome.provenance));

    // Coordination "worked" if the brain was reused OR the claim gate prevented a duplicate read. With a
    // baseline we additionally require the measured FILE-READ redundancy reduction to clear the bar.
    const coordinated = shared.outcome.reuses >= 1 || shared.live.skips >= 1;
    const pass = coordinated && (baseRead === undefined || reductionPct(baseRead, sharedRead) >= 0.3);
    console.log(pass ? "\n✅ fleet coordination met on live data" : `\n⚠️  not met this run — see ${OUT}`);
    console.log("\n" + log.summary());
    process.exitCode = pass ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
