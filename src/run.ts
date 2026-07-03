// Live harness: boot the shared-brain sidecar, run a two-worker analysis task twice (shared vs.
// baseline) with real Claude Code workers over a target codebase, and report the redundancy
// reduction + cross-worker reuse. Nothing is project-specific — the target repo and the two worker
// questions all come from the environment.
import { writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { OracleAdapter, NullMemoryAdapter, oracleReachable, type MemoryAdapter } from "./memory";
import { ClaudeCodeRunner } from "./runner";
import { Worker, Auditor, MemoryLibrarian, conductRun, type TaskSpec } from "./participants";
import { redundantCount, reductionPct } from "./metrics";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const OUT = process.env.AURALIS_OUT ?? "./.auralis-out";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 12);

// The two worker questions. Override per project via env; the defaults are generic and deliberately
// overlap (both need the core), so the shared-brain effect is observable on any codebase.
const TASK: TaskSpec = {
  qA:
    process.env.AURALIS_TASK_A ??
    "Explain the core architecture of this codebase: the main modules and how they connect. Be concise.",
  qB:
    process.env.AURALIS_TASK_B ??
    "Trace this codebase's primary end-to-end flow, module by module, from entry point to result. Be concise.",
};

// Make `pnpm dev` self-contained: start oracle-lite if it isn't already up, and return a stopper.
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

async function runOnce(label: string, adapter: MemoryAdapter) {
  const env = new AgenticEnvironment();
  const auditor = new Auditor();
  auditor.join(env);
  const mk = (id: string) => {
    const w = new Worker(id, env, new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: MAX_TURNS }));
    w.join(env);
    return w;
  };
  const outcome = await conductRun(TASK, mk("A"), mk("B"), new MemoryLibrarian(adapter, PROJECT));
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/trace-${label}.jsonl`, auditor.toJSONL());
  writeFileSync(`${OUT}/outcome-${label}.json`, JSON.stringify(outcome, null, 2));
  return outcome;
}

async function main() {
  console.log(`target project: ${PROJECT_DIR}`);
  const stop = await ensureOracle();
  try {
    console.log("▶ baseline (no shared memory)…");
    const base = await runOnce("baseline", new NullMemoryAdapter());
    console.log("▶ shared brain (oracle-lite)…");
    const shared = await runOnce("shared", new OracleAdapter());

    const baseRed = redundantCount(base.exploredA, base.exploredB);
    const sharedRed = redundantCount(shared.exploredA, shared.exploredB);
    const pct = reductionPct(baseRed, sharedRed);

    console.log("\n─── auralis milestone #1 (live) ───");
    console.log(`baseline: A=${base.exploredA.length} B=${base.exploredB.length} explored, redundant=${baseRed}`);
    console.log(`shared  : A=${shared.exploredA.length} B=${shared.exploredB.length} explored, redundant=${sharedRed}`);
    console.log(`redundancy reduction: ${(pct * 100).toFixed(1)}%   (target ≥ 30%)`);
    console.log(`cross-worker reuse via brain: ${shared.reuse ? "yes" : "no"}   (target: yes)`);
    const pass = pct >= 0.3 && shared.reuse;
    console.log(pass ? "\n✅ milestone #1 met on live data" : `\n⚠️  not met this run — see ${OUT}`);
    process.exitCode = pass ? 0 : 1;
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
