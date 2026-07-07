// Shared fleet plumbing used by both the live harness (run.ts) and the benchmark (bench.ts): start the
// brain sidecar, resolve the task set (fixed via AURALIS_TASKS, or Planner-decomposed), and run one
// baseline/shared fleet with a chosen concurrency.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { oracleReachable, type MemoryAdapter } from "./memory";
import { ClaudeCodeRunner } from "./runner";
import { Worker, Auditor, Sentry, MemoryLibrarian } from "./participants";
import { coordinate, type FleetOutcome } from "./conductor";
import { buildLevels } from "./dag";
import { planGoal, planBuild } from "./planner";
import { brainMcpServer, newLiveStats, type LiveStats } from "./brain-mcp";
import { makeEmitter, format } from "./narrate";
import type { DagNode } from "./dag";

export async function ensureOracle(): Promise<() => void> {
  const stops: (() => void)[] = [];
  // When auralis runs AS an MCP server, stdout is the JSON-RPC channel — sidecar logs must NOT touch it,
  // so send their stdout+stderr to our stderr (fd 2). Normal runs inherit as before.
  const sidecarStdio: any = process.env.AURALIS_MCP ? ["ignore", 2, 2] : "inherit";

  // Optional semantic embed-sidecar (Node). oracle-lite, spawned below, inherits ORACLE_EMBED_URL.
  if (process.env.AURALIS_SEMANTIC === "1" && !process.env.ORACLE_EMBED_URL) {
    const port = Number(process.env.EMBED_PORT ?? 47779);
    const url = `http://localhost:${port}`;
    const embed = spawn("pnpm", ["exec", "tsx", "src/embed-sidecar.ts"], { env: { ...process.env, EMBED_PORT: String(port) }, stdio: sidecarStdio });
    stops.push(() => { try { embed.kill(); } catch { /* noop */ } });
    let up = false;
    for (let i = 0; i < 180; i++) { // first run downloads the model
      try { if ((await fetch(`${url}/health`, { signal: AbortSignal.timeout(3_000) })).ok) { up = true; break; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (up) { process.env.ORACLE_EMBED_URL = url; console.log(`· embed-sidecar ready (${url})`); }
    else console.error("· embed-sidecar did not come up — falling back to the built-in embedder");
  }

  if (await oracleReachable()) return () => stops.forEach((s) => s());
  const child = spawn("bun", ["run", "oracle-lite/server.ts"], { env: { ...process.env, ORACLE_RESET: "1" }, stdio: sidecarStdio });
  stops.push(() => { try { child.kill(); } catch { /* noop */ } });
  for (let i = 0; i < 60; i++) {
    if (await oracleReachable()) return () => stops.forEach((s) => s());
    await new Promise((r) => setTimeout(r, 200));
  }
  stops.forEach((s) => s());
  throw new Error("oracle-lite failed to start on :47778");
}

// One place that narrates a line: to stderr (visible on the CLI; the MCP server redirects console.log→stderr
// so it's safe there too) and to the MCP progress channel when present. AURALIS_QUIET=1 silences the echo.
function narrateLine(human: string, onProgress?: (m: string) => void): void {
  if (process.env.AURALIS_QUIET !== "1") console.error(human);
  onProgress?.(human);
}

// An onStep for one actor (a worker id, or "planner"): formats each tool call and narrates it live. Paths
// under `base` are shown relative so the line stays short; patterns/other targets pass through unchanged.
export function stepSink(actor: string, base: string, onProgress?: (m: string) => void): (tool: string, target?: string) => void {
  const root = resolve(base);
  return (tool, target) => {
    const shown = target ? " " + (target.startsWith(root) ? relative(root, target) || "." : target) : "";
    narrateLine(format("intent", `${actor} → ${tool}${shown}`), onProgress);
  };
}

// Fixed task set (AURALIS_TASKS = inline JSON or a file path) keeps benchmark trials comparable;
// otherwise the Planner decomposes the goal live. onStep narrates the planner's own tool calls.
export async function resolveTasks(projectDir: string, goal: string, planTurns: number, build = false, onStep?: (tool: string, target?: string) => void): Promise<DagNode[]> {
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
  const planner = new ClaudeCodeRunner({ cwd: projectDir, maxTurns: planTurns, onStep });
  return build ? planBuild(planner, goal) : planGoal(planner, goal);
}

export interface FleetCfg {
  projectDir: string;
  project: string;
  maxTurns: number;
  concurrency: number;
  maxRetries?: number; // self-repair retries per task (0 = off)
  workerPull?: boolean; // attach the brain as an MCP tool the worker can call directly
  build?: boolean; // build mode: workers write files (Edit/Write), claim guards writes; off = read-only analyse
  onProgress?: (msg: string) => void; // live sink for each coordination event (e.g. MCP progress notifications)
  out?: string; // when set, write trace + provenance files
}

export async function runFleet(
  label: string,
  adapter: MemoryAdapter,
  nodes: DagNode[],
  cfg: FleetCfg,
): Promise<{ outcome: FleetOutcome; warnings: number; live: LiveStats; runId: string }> {
  const env = new AgenticEnvironment();
  // Activity timeline: one emitter per run arm. Only when the adapter actually persists events (the shared
  // brain) — the null baseline has no recordEvent, so it emits nothing. Best-effort, never blocks the run.
  const runId = `${cfg.project}:${label}:${new Date().toISOString()}`;
  const emit =
    process.env.AURALIS_TIMELINE !== "0" && adapter.recordEvent
      ? makeEmitter({ adapter, runId, project: cfg.project, onEvent: (_k, _a, human) => narrateLine(human, cfg.onProgress) })
      : undefined;
  const auditor = new Auditor();
  auditor.join(env);
  const sentry = new Sentry(emit);
  sentry.join(env);
  const live = newLiveStats();
  const scope = `${cfg.project}:${label}`; // claims are namespaced per run arm so arms/reruns don't collide
  if (cfg.workerPull && adapter.claimReset) await adapter.claimReset(scope);
  // The timeline must be complete at every point: open the run with the PLAN (what was decided to do),
  // not just the first task starting.
  emit?.("phase", "planner", `plan · ${nodes.length} task(s) · ${buildLevels(nodes).length} level(s): ${nodes.map((n) => n.id).join(", ")}`);
  const makeWorker = (id: string) => {
    // One MCP server PER worker (a single shared instance races on registration under concurrency), all
    // writing the same `live` stats. The claim itself is resolved by the shared brain (adapter.claim) so
    // ownership holds across processes and any agent runtime — not just this fleet's in-process memory.
    const brain = cfg.workerPull ? brainMcpServer(adapter, cfg.project, live, emit, id) : undefined;
    // AURALIS_CLAIM=0 turns OFF the claim gate while keeping the brain — the "free-for-all" A/B arm that
    // shows what coordination prevents (workers can then clobber a shared file).
    const claim =
      cfg.workerPull && adapter.claim && process.env.AURALIS_CLAIM !== "0"
        ? async (target: string) => {
            const r = await adapter.claim!(scope, target, id);
            if (!r.ok) {
              live.skips++;
              emit?.("dedup", id, `${id} skipped ${target} — ${r.owner} owns it`, { nodeId: id, refs: [target] });
            } else if (r.fresh) live.claims++;
            return r;
          }
        : undefined;
    // Narrate this worker's tool calls live AND persist each one to the timeline (kind=trace) — without
    // this the worker's interior is visible only while you watch; a replay would skip its 50–70s again.
    const sink = stepSink(id, cfg.projectDir, cfg.onProgress);
    const onStep = (tool: string, target?: string) => {
      sink(tool, target);
      emit?.("trace", id, `${id} → ${tool}${target ? ` ${target}` : ""}`, { nodeId: id, refs: target ? [target] : undefined });
    };
    const w = new Worker(id, env, new ClaudeCodeRunner({ cwd: cfg.projectDir, maxTurns: cfg.maxTurns, brain, claim, build: cfg.build, onStep }), !!brain, cfg.build);
    w.join(env);
    return w;
  };
  const outcome = await coordinate(nodes, makeWorker, new MemoryLibrarian(adapter, cfg.project), {
    concurrency: cfg.concurrency,
    maxRetries: cfg.maxRetries,
    emit,
  });
  if (cfg.out) {
    mkdirSync(cfg.out, { recursive: true });
    writeFileSync(`${cfg.out}/trace-${label}.jsonl`, auditor.toJSONL());
    writeFileSync(`${cfg.out}/provenance-${label}.json`, JSON.stringify(outcome.provenance, null, 2));
  }
  // Close the run on the timeline with its outcome — a replay tells the whole story without the console.
  emit?.(
    "phase",
    "conductor",
    `run complete · reuses=${outcome.reuses} repairs=${outcome.repairs} overlaps=${sentry.warnings.length} · live pulls=${live.hits}/${live.searches} pushes=${live.learns} prevented=${live.skips} cites=${live.cites}`,
  );
  // runId lets callers (the build/rework loop) append THEIR events — acceptance verdicts — to this same run.
  return { outcome, warnings: sentry.warnings.length, live, runId };
}
