// Shared fleet plumbing used by both the live harness (run.ts) and the benchmark (bench.ts): start the
// brain sidecar, resolve the task set (fixed via AURALIS_TASKS, or Planner-decomposed), and run one
// baseline/shared fleet with a chosen concurrency.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { oracleReachable, type MemoryAdapter } from "./memory";
import { ClaudeCodeRunner } from "./runner";
import { Worker, Auditor, Sentry, MemoryLibrarian } from "./participants";
import { coordinate, type FleetOutcome } from "./conductor";
import { planGoal } from "./planner";
import type { DagNode } from "./dag";

export async function ensureOracle(): Promise<() => void> {
  if (await oracleReachable()) return () => {};
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

// Fixed task set (AURALIS_TASKS = inline JSON or a file path) keeps benchmark trials comparable;
// otherwise the Planner decomposes the goal live.
export async function resolveTasks(projectDir: string, goal: string, planTurns: number): Promise<DagNode[]> {
  const raw = process.env.AURALIS_TASKS;
  if (raw && raw.trim()) {
    const text = raw.trim().startsWith("[") ? raw : readFileSync(raw, "utf8");
    const arr = JSON.parse(text) as any[];
    return arr
      .filter((x) => x && x.question)
      .map((x, i) => ({
        id: String(x.id ?? `task-${i + 1}`),
        question: String(x.question),
        dependsOn: Array.isArray(x.dependsOn) ? x.dependsOn.map(String) : [],
      }));
  }
  const planner = new ClaudeCodeRunner({ cwd: projectDir, maxTurns: planTurns });
  return planGoal(planner, goal);
}

export interface FleetCfg {
  projectDir: string;
  project: string;
  maxTurns: number;
  concurrency: number;
  maxRetries?: number; // self-repair retries per task (0 = off)
  out?: string; // when set, write trace + provenance files
}

export async function runFleet(
  label: string,
  adapter: MemoryAdapter,
  nodes: DagNode[],
  cfg: FleetCfg,
): Promise<{ outcome: FleetOutcome; warnings: number }> {
  const env = new AgenticEnvironment();
  const auditor = new Auditor();
  auditor.join(env);
  const sentry = new Sentry();
  sentry.join(env);
  const makeWorker = (id: string) => {
    const w = new Worker(id, env, new ClaudeCodeRunner({ cwd: cfg.projectDir, maxTurns: cfg.maxTurns }));
    w.join(env);
    return w;
  };
  const outcome = await coordinate(nodes, makeWorker, new MemoryLibrarian(adapter, cfg.project), {
    concurrency: cfg.concurrency,
    maxRetries: cfg.maxRetries,
  });
  if (cfg.out) {
    mkdirSync(cfg.out, { recursive: true });
    writeFileSync(`${cfg.out}/trace-${label}.jsonl`, auditor.toJSONL());
    writeFileSync(`${cfg.out}/provenance-${label}.json`, JSON.stringify(outcome.provenance, null, 2));
  }
  return { outcome, warnings: sentry.warnings.length };
}
