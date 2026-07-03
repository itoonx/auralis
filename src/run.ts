// Live fleet harness (Milestone #2): boot the brain, have the Planner decompose one goal into a DAG,
// then run the coordinated society twice (shared brain vs. baseline) with real Claude Code workers
// over a target codebase, and report fleet redundancy reduction, reuse, and Sentry overlap warnings.
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { OracleAdapter, NullMemoryAdapter, oracleReachable, type MemoryAdapter } from "./memory";
import { ClaudeCodeRunner } from "./runner";
import { Worker, Auditor, Sentry, MemoryLibrarian } from "./participants";
import { coordinate } from "./conductor";
import { planGoal } from "./planner";
import { buildLevels, type DagNode } from "./dag";
import { fleetRedundantCount, reductionPct } from "./metrics";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 10);
const PLAN_TURNS = Number(process.env.AURALIS_PLAN_TURNS ?? 6);
const GOAL =
  process.env.AURALIS_GOAL ??
  "Understand this codebase end-to-end: its architecture, core modules, primary end-to-end flow, and error handling.";

async function ensureOracle(): Promise<() => void> {
  if (await oracleReachable()) return () => {};
  console.log("· starting oracle-lite sidecar…");
  const child = spawn("bun", ["run", "oracle-lite/server.ts"], {
    env: { ...process.env, ORACLE_RESET: "1" },
    stdio: "inherit",
  });
  for (let i = 0; i < 60; i++) {
    if (await oracleReachable()) return () => { try { child.kill(); } catch { /* noop */ } };
    await new Promise((r) => setTimeout(r, 200));
  }
  try { child.kill(); } catch { /* noop */ }
  throw new Error("oracle-lite failed to start on :47778");
}

async function runFleet(label: string, adapter: MemoryAdapter, nodes: DagNode[]) {
  const env = new AgenticEnvironment();
  const auditor = new Auditor();
  auditor.join(env);
  const sentry = new Sentry();
  sentry.join(env);
  const makeWorker = (id: string) => {
    const w = new Worker(id, env, new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: MAX_TURNS }));
    w.join(env);
    return w;
  };
  const outcome = await coordinate(nodes, makeWorker, new MemoryLibrarian(adapter, PROJECT));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/trace-${label}.jsonl`, auditor.toJSONL());
  writeFileSync(`${OUT}/fleet-${label}.json`, JSON.stringify({ outcome, warnings: sentry.warnings }, null, 2));
  return { outcome, warnings: sentry.warnings.length };
}

async function main() {
  console.log(`target project: ${PROJECT_DIR}`);
  const stop = await ensureOracle();
  try {
    console.log("· planning (decomposing goal into a DAG)…");
    const planner = new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: PLAN_TURNS });
    const nodes = await planGoal(planner, GOAL);
    const levels = buildLevels(nodes);
    console.log(`planned ${nodes.length} subtasks (${levels.length} level(s)): ${nodes.map((n) => n.id).join(", ")}`);

    console.log("▶ baseline (no shared memory)…");
    const base = await runFleet("baseline", new NullMemoryAdapter(), nodes);
    console.log("▶ shared brain…");
    const shared = await runFleet("shared", new OracleAdapter(), nodes);

    const baseRed = fleetRedundantCount(base.outcome.perWorker.map((w) => w.explored));
    const sharedRed = fleetRedundantCount(shared.outcome.perWorker.map((w) => w.explored));
    const pct = reductionPct(baseRed, sharedRed);

    console.log("\n─── auralis milestone #2 (live fleet) ───");
    console.log(`plan: ${nodes.length} tasks`);
    console.log(`baseline: fleet-redundant=${baseRed}, sentry overlap warnings=${base.warnings}`);
    console.log(`shared  : fleet-redundant=${sharedRed}, sentry overlap warnings=${shared.warnings}, reuses=${shared.outcome.reuses}`);
    console.log(`redundancy reduction: ${(pct * 100).toFixed(1)}%   (target ≥ 30%)`);
    console.log(`cross-task reuse via brain: ${shared.outcome.reuses}   (target ≥ 1)`);
    const pass = pct >= 0.3 && shared.outcome.reuses >= 1;
    console.log(pass ? "\n✅ milestone #2 met on live data" : `\n⚠️  not met this run — see ${OUT}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
