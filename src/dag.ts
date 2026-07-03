// A tiny dependency-graph engine: Kahn-style level grouping with cycle detection. The Planner emits
// nodes; the Conductor walks them in dependency order so a task can reuse what its prerequisites found.
export interface DagNode {
  id: string;
  question: string;
  dependsOn: string[];
}

// Group node ids into dependency levels; every id in level N depends only on ids in levels < N.
export function buildLevels(nodes: DagNode[]): string[][] {
  const ids = new Set(nodes.map((n) => n.id));
  const deps = new Map<string, string[]>();
  for (const n of nodes) deps.set(n.id, n.dependsOn.filter((d) => ids.has(d))); // drop dangling deps

  const levels: string[][] = [];
  const done = new Set<string>();
  while (done.size < nodes.length) {
    const level = nodes
      .filter((n) => !done.has(n.id) && deps.get(n.id)!.every((d) => done.has(d)))
      .map((n) => n.id);
    if (level.length === 0) {
      const stuck = nodes.filter((n) => !done.has(n.id)).map((n) => n.id);
      throw new Error(`cycle detected in plan DAG: ${stuck.join(", ")}`);
    }
    for (const id of level) done.add(id);
    levels.push(level);
  }
  return levels;
}

// Nodes in a valid execution order (levels flattened).
export function topoOrder(nodes: DagNode[]): DagNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return buildLevels(nodes).flat().map((id) => byId.get(id)!);
}
