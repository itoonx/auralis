// The Conductor walks a planned DAG. It runs the DAG level by level: level N waits for N-1 (so a task
// reuses what its prerequisites found), while the independent tasks WITHIN a level can run concurrently
// up to a cap. Before each task it pulls context from the shared brain; after each it pushes the new
// finding back, recording per-task PROVENANCE so a run is auditable — "why did the society produce this?".
import type { DagNode } from "./dag";
import { buildLevels } from "./dag";
import type { Worker, MemoryLibrarian } from "./participants";
import type { Exploration } from "./runner";

export interface TaskProvenance {
  task: string;
  recalled: string[]; // ids of prior findings injected into this task
  explored: string[]; // distinct targets this task explored
  summary: string; // what the task produced (truncated)
  learnedId: string; // the finding this task contributed back
}

export interface FleetOutcome {
  perWorker: { id: string; explored: Exploration[] }[];
  reuses: number;
  provenance: TaskProvenance[];
}

// Bounded-concurrency map that preserves input order. limit=1 is strictly sequential.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  });
  await Promise.all(lanes);
  return results;
}

export async function coordinate(
  nodes: DagNode[],
  makeWorker: (id: string) => Worker,
  librarian: MemoryLibrarian,
  opts: { concurrency?: number } = {},
): Promise<FleetOutcome> {
  const concurrency = Math.max(1, opts.concurrency ?? 1); // 1 = original strict-sequential walk
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const perWorker: FleetOutcome["perWorker"] = [];
  const provenance: TaskProvenance[] = [];
  let reuses = 0;

  const runNode = async (node: DagNode) => {
    const ctx = await librarian.injectFor(node.question);
    const worker = makeWorker(node.id);
    const res = await worker.run(node.question, ctx.context); // emits finding on the bus → Sentry reacts
    const learnedId = await librarian.capture(node.id, node.question, res);
    return { node, ctx, res, learnedId };
  };

  for (const levelIds of buildLevels(nodes)) {
    const levelNodes = levelIds.map((id) => byId.get(id)!);
    const done = await mapWithConcurrency(levelNodes, concurrency, runNode);
    for (const r of done) {
      if (r.ctx.hitIds.length > 0) reuses++;
      perWorker.push({ id: r.node.id, explored: r.res.explored });
      provenance.push({
        task: r.node.id,
        recalled: r.ctx.hitIds,
        explored: [...new Set(r.res.explored.map((e) => e.target))],
        summary: r.res.result.slice(0, 300),
        learnedId: r.learnedId,
      });
    }
  }
  return { perWorker, reuses, provenance };
}

export interface SessionMetrics {
  label: string;
  cold: boolean;
  crossSessionRecall: number;
  explored: number;
}

// Run ONE independent analysis session against the shared brain. The only thing linking it to other
// sessions is the (persistent) brain. crossSessionRecall is measured BEFORE this session writes
// anything, so any hit came from a prior session.
export async function runOneSession(
  goal: string,
  label: string,
  librarian: MemoryLibrarian,
  makeWorker: (id: string) => Worker,
  cold = false,
): Promise<SessionMetrics> {
  const pre = await librarian.injectFor(goal);
  const crossSessionRecall = pre.hitIds.length;
  const worker = makeWorker(label);
  const res = await worker.run(goal, pre.context);
  await librarian.capture(label, goal, res);
  return { label, cold, crossSessionRecall, explored: new Set(res.explored.map((e) => e.target)).size };
}
