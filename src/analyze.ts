// analyze(goal) — the usable one-shot: run the society over the repo, auto-cognify the findings into the
// graph (real predicates by default), then synthesize an answer from graph-aware recall (flat + graph).
// Dependencies are injected so it's testable offline; run-analyze.ts wires the live Claude Code + brain.
import type { MemoryAdapter } from "./memory";
import { MemoryLibrarian } from "./participants";
import type { DagNode } from "./dag";
import type { FleetOutcome } from "./conductor";

export interface AnalyzeResult {
  goal: string;
  tasks: number;
  answer: string;
  recalled: string[];
  graphUsed: boolean;
}

export async function analyze(
  adapter: MemoryAdapter,
  project: string,
  goal: string,
  deps: {
    resolveTasks: () => Promise<DagNode[]>;
    runFleet: (nodes: DagNode[]) => Promise<FleetOutcome>;
    cognifyAll: () => Promise<number>; // auto-trigger: build the graph from the new findings
    synthesize: (goal: string, context: string) => Promise<string>;
  },
): Promise<AnalyzeResult> {
  const nodes = await deps.resolveTasks();
  await deps.runFleet(nodes); // the society explores; findings land in the brain
  await deps.cognifyAll(); // auto-cognify (real predicates) → the graph
  const { context, hitIds } = await new MemoryLibrarian(adapter, project).injectFor(goal); // flat + fuzzy graph
  const answer = await deps.synthesize(goal, context);
  return {
    goal,
    tasks: nodes.length,
    answer,
    recalled: hitIds,
    graphUsed: context.includes("Connected in the knowledge graph"),
  };
}
