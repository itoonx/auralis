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
