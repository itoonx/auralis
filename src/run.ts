// Live fleet harness: boot the brain, resolve the tasks (Planner or a fixed set), then run the
// coordinated society twice — shared brain vs. baseline — with real Claude Code workers over a target
// codebase, at the chosen parallelism. Reports fleet redundancy reduction + an auditable "why" trail.
// Tuning: AURALIS_PARALLEL=1 (default) maximises knowledge-sharing; >1 runs each DAG level concurrently.
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { OracleAdapter, NullMemoryAdapter } from "./memory";
import { ensureOracle, resolveTasks, runFleet } from "./fleet";
import { explainProvenance } from "./audit";
import { buildLevels } from "./dag";
import { fleetRedundantCount, reductionPct } from "./metrics";
import { buildWithRework } from "./build";
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
const BUILD = (process.env.AURALIS_MODE ?? "analyze") === "build"; // build: workers WRITE files (claim guards writes); else read-only analyse
const ACCEPT = process.env.AURALIS_ACCEPT; // build: close the loop — validate against this spec (rps|todo)
const REWORK = Number(process.env.AURALIS_BUILD_RETRIES ?? 1); // extra fleet reworks when acceptance FAILS
const GOAL =
  process.env.AURALIS_GOAL ??
  "Understand this codebase end-to-end: its architecture, core modules, primary end-to-end flow, and error handling.";

async function main() {
  console.log(`target project: ${PROJECT_DIR}  ·  mode=${BUILD ? "build" : "analyze"}  ·  parallel=${CONCURRENCY}  ·  worker-pull=${WORKER_PULL}  ·  baseline=${RUN_BASELINE}`);
  // Build mode: the workspace needs its OWN package.json, or Node resolves module type from auralis's
  // package.json ("type":"module") and the generated CommonJS (require/module.exports) fails to run — a
  // real edge case the first live build surfaced. Don't overwrite a project that already declares its type.
  if (BUILD) {
    mkdirSync(PROJECT_DIR, { recursive: true });
    const pkg = resolve(PROJECT_DIR, "package.json");
    if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: "build", private: true, type: "commonjs" }, null, 2) + "\n");
  }
  log.reset(`${OUT}/timing.jsonl`);
  const stop = await log.time("oracle.boot", undefined, () => ensureOracle());
  try {
    console.log("· resolving tasks…");
    const nodes = await log.time("plan", undefined, () => resolveTasks(PROJECT_DIR, GOAL, PLAN_TURNS, BUILD));
    console.log(`${nodes.length} task(s), ${buildLevels(nodes).length} level(s): ${nodes.map((n) => n.id).join(", ")}`);
    const cfg = { projectDir: PROJECT_DIR, project: PROJECT, maxTurns: MAX_TURNS, concurrency: CONCURRENCY, maxRetries: RETRIES, workerPull: WORKER_PULL, build: BUILD, out: OUT };

    // Redundancy that matters is duplicate FILE reads (expensive). Glob/grep are cheap discovery scans
    // that different workers reasonably repeat, so split them: read-redundant is the headline the claim
    // gate acts on; scan-redundant is a secondary note, not counted against the run.
    const READ_ONLY = new Set(["Read"]);
    const SCAN_ONLY = new Set(["Grep", "Glob"]);
    const WRITE_ONLY = new Set(["Write", "Edit"]); // build mode: which files each worker actually wrote
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
    const oracle = new OracleAdapter();
    // Close the loop (shared with the MCP build tool): run the fleet, and in build mode with a spec, validate
    // and rework on FAIL up to AURALIS_BUILD_RETRIES. analyse / no spec = one run, no rework.
    const { shared, acc } = await buildWithRework(oracle, nodes, cfg, { accept: BUILD ? ACCEPT : undefined, retries: REWORK, projectDir: PROJECT_DIR });
    const explored = shared.outcome.perWorker.map((w) => w.explored);
    const sharedRead = fleetRedundantCount(explored, READ_ONLY);
    const sharedScan = fleetRedundantCount(explored, SCAN_ONLY);

    console.log("\n─── auralis fleet run ───");
    if (baseRead !== undefined) console.log(`baseline: read-redundant=${baseRead} file(s), sentry overlap warnings=${baseWarnings}`);
    console.log(`shared  : read-redundant=${sharedRead} file(s), scan-redundant=${sharedScan} glob/grep, sentry overlap warnings=${shared.warnings}, reuses=${shared.outcome.reuses}, self-repairs=${shared.outcome.repairs}`);
    console.log(`realtime: live-pushes=${shared.live.learns}, live-pulls=${shared.live.hits}/${shared.live.searches} hit, claims=${shared.live.claims}, prevented-dupes=${shared.live.skips}`);
    const written = [...new Set(explored.flat().filter((e) => WRITE_ONLY.has(e.tool)).map((e) => e.target))];
    if (BUILD) console.log(`build   : files-written=${written.length} [${written.join(", ")}], write-collisions=${fleetRedundantCount(explored, WRITE_ONLY)}, prevented-clobbers=${shared.live.skips}`);
    if (BUILD && acc) console.log(`accept  : ${acc.pass ? "✅ PASS" : `❌ FAIL after ${REWORK} rework(s)`}${acc.pass ? "" : ` — ${acc.failLines.replace(/\n/g, "; ")}`}`);
    if (baseRead !== undefined) console.log(`redundancy reduction (file reads): ${(reductionPct(baseRead, sharedRead) * 100).toFixed(1)}%   (target ≥ 30%)`);
    console.log("\n" + explainProvenance(shared.outcome.provenance));

    // Coordination "worked" if the brain was reused OR the claim gate prevented a duplicate read. With a
    // baseline we additionally require the measured FILE-READ redundancy reduction to clear the bar.
    const coordinated = shared.outcome.reuses >= 1 || shared.live.skips >= 1;
    // Build mode's real verdict is the acceptance harness (Phase 2, `pnpm accept`); here the fleet-level
    // signal is simply "did the workers actually write files" (Phase 0 baseline wrote zero).
    const pass = BUILD ? (acc ? acc.pass : written.length >= 1) : coordinated && (baseRead === undefined || reductionPct(baseRead, sharedRead) >= 0.3);
    console.log(
      pass
        ? BUILD
          ? acc
            ? "\n✅ built & verified — acceptance PASS"
            : `\n✅ fleet wrote ${written.length} file(s) — run \`pnpm accept\` to verify`
          : "\n✅ fleet coordination met on live data"
        : BUILD && acc
          ? `\n❌ acceptance FAILED after ${REWORK} rework(s) — see ${OUT}`
          : `\n⚠️  not met this run — see ${OUT}`,
    );
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
