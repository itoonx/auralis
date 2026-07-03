// The Planner decomposes one goal into a small DAG of analysis subtasks. It runs like any worker
// (Claude Code via the Agent SDK, or a stub in tests) and returns structured nodes. Parsing is
// tolerant: on any failure it degrades to a single whole-goal node rather than crashing the run.
import type { AgentRunner } from "./runner";
import type { DagNode } from "./dag";

export async function planGoal(runner: AgentRunner, goal: string): Promise<DagNode[]> {
  const prompt =
    `You are the planner for a team of code-analysis agents working on THIS repository.\n` +
    `Decompose the goal below into 2-3 EXPLORATION subtasks that each examine a DIFFERENT aspect of the ` +
    `codebase (each with dependsOn: []), PLUS one final SYNTHESIS subtask whose dependsOn lists ALL of ` +
    `the exploration subtask ids, tying their findings together.\n\n` +
    `Goal: ${goal}\n\n` +
    `Output ONLY a JSON array, no prose:\n` +
    `[{"id":"kebab-id","question":"a concrete analysis question","dependsOn":["prerequisite-ids"]}]`;
  const { result } = await runner.run(prompt);
  return parsePlan(result);
}

export function parsePlan(text: string): DagNode[] {
  const json = extractJsonArray(text);
  const fallback: DagNode[] = [{ id: "whole", question: "Analyse this codebase end to end. Be concise.", dependsOn: [] }];
  if (!json) return fallback;
  try {
    const arr = JSON.parse(json) as any[];
    const nodes: DagNode[] = arr
      .filter((x) => x && typeof x.question === "string" && x.question.trim())
      .map((x, i) => ({
        id: String(x.id ?? `task-${i + 1}`),
        question: String(x.question).trim(),
        dependsOn: Array.isArray(x.dependsOn) ? x.dependsOn.map(String) : [],
      }));
    return nodes.length ? nodes : fallback;
  } catch {
    return fallback;
  }
}

function extractJsonArray(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/);
  if (fenced) return fenced[1];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}
