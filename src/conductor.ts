// The Conductor walks a planned DAG in dependency order. Before each task it pulls relevant context
// from the shared brain (so later tasks reuse earlier findings); after each task it pushes the new
// finding back. Coordination is data-driven (whatever DAG the Planner produced) and observed live on
// the bus by the Sentry — not a hardcoded handoff.
import type { DagNode } from "./dag";
import { topoOrder } from "./dag";
import type { Worker, MemoryLibrarian } from "./participants";
import type { Exploration } from "./runner";

export interface FleetOutcome {
  perWorker: { id: string; explored: Exploration[] }[];
  reuses: number; // how many tasks received a prior task's finding as injected context
}

export async function coordinate(
  nodes: DagNode[],
  makeWorker: (id: string) => Worker,
  librarian: MemoryLibrarian,
): Promise<FleetOutcome> {
  const perWorker: { id: string; explored: Exploration[] }[] = [];
  let reuses = 0;
  for (const node of topoOrder(nodes)) {
    const ctx = await librarian.injectFor(node.question);
    if (ctx.hitIds.length > 0) reuses++;
    const worker = makeWorker(node.id);
    const res = await worker.run(node.question, ctx.context); // emits finding on the bus → Sentry reacts
    await librarian.capture(node.id, node.question, res);
    perWorker.push({ id: node.id, explored: res.explored });
  }
  return { perWorker, reuses };
}

export interface SessionMetrics {
  label: string;
  cold: boolean;
  crossSessionRecall: number; // findings the brain already held for this goal (written by PRIOR sessions)
  explored: number; // distinct targets this session explored
}

// Run ONE independent analysis session against the shared brain. The only thing linking it to other
// sessions is the (persistent) brain — a fresh environment + worker start with no in-memory carryover.
// crossSessionRecall is measured BEFORE this session writes anything, so any hit came from a prior session.
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
