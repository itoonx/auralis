// `pnpm analyze "<goal>"` — the real usable mode. Runs the society once over the repo, auto-cognifies the
// findings into the knowledge graph (real predicates by default), then answers the goal from graph-aware
// recall. Quality is on by default: AURALIS_SEMANTIC and AURALIS_COGNIFY_LLM default to 1 here (set to 0
// to opt out); everything degrades gracefully if Claude Code / the embed sidecar isn't available.
import { resolve } from "node:path";
import { OracleAdapter } from "./memory";
import { ensureOracle, resolveTasks, runFleet } from "./fleet";
import { analyze } from "./analyze";
import { cognify, extractTriplets, llmExtractTriplets } from "./graph";
import { ClaudeCodeRunner } from "./runner";
import { buildLevels, type DagNode } from "./dag";
import type { Triplet } from "./memory";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 10);
const PLAN_TURNS = Number(process.env.AURALIS_PLAN_TURNS ?? 6);
const COGNIFY_LLM = process.env.AURALIS_COGNIFY_LLM !== "0"; // real predicates by default
const goal = process.argv.slice(2).join(" ").trim() || process.env.AURALIS_GOAL || "Understand this codebase end-to-end.";
if (!process.env.AURALIS_SEMANTIC) process.env.AURALIS_SEMANTIC = "1"; // quality recall by default

async function main() {
  console.log(`analyze: ${PROJECT_DIR}  ·  goal: ${goal}`);
  const stop = await ensureOracle();
  try {
    const adapter = new OracleAdapter();
    const cfg = {
      projectDir: PROJECT_DIR,
      project: PROJECT,
      maxTurns: MAX_TURNS,
      concurrency: Number(process.env.AURALIS_PARALLEL ?? 1),
      maxRetries: 1,
      out: process.env.AURALIS_OUT ?? "./.auralis-out",
    };
    const res = await analyze(adapter, PROJECT, goal, {
      resolveTasks: async () => {
        const nodes = await resolveTasks(PROJECT_DIR, goal, PLAN_TURNS);
        console.log(`${nodes.length} task(s), ${buildLevels(nodes).length} level(s): ${nodes.map((n) => n.id).join(", ")}`);
        return nodes;
      },
      runFleet: async (nodes: DagNode[]) => (await runFleet("analyze", adapter, nodes, cfg)).outcome,
      cognifyAll: async () => {
        const runner = COGNIFY_LLM ? new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: 3 }) : null;
        const extract = runner ? (t: string): Promise<Triplet[]> => llmExtractTriplets(t, runner) : extractTriplets;
        const docs = (await adapter.listDocs?.({ project: PROJECT, max: 500 })) ?? [];
        let edges = 0;
        for (const d of docs) edges += (await cognify(adapter, d.id, PROJECT, d.content, { extract })).length;
        console.log(`cognified ${docs.length} finding(s) → ${edges} edge(s)  (${COGNIFY_LLM ? "LLM predicates" : "heuristic"})`);
        return edges;
      },
      synthesize: async (g, context) => {
        const runner = new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: 4 });
        const prompt =
          `Answer the goal using the recalled knowledge below (prior findings + graph connections). ` +
          `Be concise and concrete; cite the connections where they matter.\n\nGOAL: ${g}\n\nRECALLED:\n${context || "(nothing yet)"}`;
        const { result } = await runner.run(prompt);
        return result.trim() || "(no answer produced)";
      },
    });
    console.log(`\n─── analyze ───\ngoal: ${res.goal}\n`);
    console.log(res.answer);
    console.log(`\n(${res.tasks} task(s) · ${res.recalled.length} finding(s) recalled · graph ${res.graphUsed ? "USED" : "not used"})`);
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
