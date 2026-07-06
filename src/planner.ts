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

// Build-aware planner: decompose a BUILD goal into file-disjoint tasks — one file per task, ordered by
// dependency — so the claim gate can hand each worker its own file. The analyze planner (above) produced
// exploration/synthesis tasks, which on a build goal went off-spec (meta files, missed the core file).
export async function planBuild(runner: AgentRunner, goal: string): Promise<DagNode[]> {
  const prompt =
    `You are the planner for a team of agents that will BUILD (write code files for) the goal below, in the ` +
    `current working directory. Decompose it into a small set of build tasks. RULES:\n` +
    `- Each task OWNS exactly ONE file. Name that file in the question. Two tasks must NEVER write the same file.\n` +
    `- If the goal names specific files, produce EXACTLY those files — no more, no fewer. Do NOT add README, ` +
    `CONVENTIONS, config, or any extra file unless the goal explicitly asks for it.\n` +
    `- Order by dependency: if file B requires/imports file A, B's task dependsOn A's task. Put shared/core logic first.\n` +
    `- Each question must instruct: create and WRITE that ONE file to the current working directory, say what it ` +
    `must contain, use plain Node with NO external dependencies, and write no other file.\n` +
    `- Keep it minimal: the fewest files that satisfy the goal (usually a core-logic file, an entry/CLI file, a test file).\n\n` +
    `Goal: ${goal}\n\n` +
    `Output ONLY a JSON array, no prose:\n` +
    `[{"id":"kebab-id","question":"Create <file>: ... . WRITE <file> to the current directory and no other file.","dependsOn":["prerequisite-ids"]}]`;
  const { result } = await runner.run(prompt);
  return parsePlan(result, `Implement the goal in a single Node.js file and WRITE it to the current directory: ${goal}`);
}

export function parsePlan(text: string, fallbackQuestion = "Analyse this codebase end to end. Be concise."): DagNode[] {
  const json = extractJsonArray(text);
  const fallback: DagNode[] = [{ id: "whole", question: fallbackQuestion, dependsOn: [] }];
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
