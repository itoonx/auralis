// `pnpm cognify` — build the knowledge graph: extract entity/relationship triplets from the brain's raw
// findings and store them as edges (linked by normalized entity). AURALIS_COGNIFY_LLM=1 uses Claude Code
// for real predicates (now the DEFAULT — set AURALIS_COGNIFY_LLM=0 for the free heuristic). Falls back
// to the heuristic per-finding if Claude Code is unavailable.
import { OracleAdapter } from "./memory";
import { ensureOracle } from "./fleet";
import { cognify, extractTriplets, llmExtractTriplets } from "./graph";
import { ClaudeCodeRunner } from "./runner";
import type { Triplet } from "./memory";

const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const PROJECT_DIR = process.env.AURALIS_PROJECT_DIR ?? process.cwd();
const LLM = process.env.AURALIS_COGNIFY_LLM !== "0"; // real predicates by default; =0 for heuristic

async function main() {
  const stop = await ensureOracle();
  try {
    const adapter = new OracleAdapter();
    const docs = (await adapter.listDocs?.({ project: PROJECT, max: 500 })) ?? [];
    const runner = LLM ? new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: 3 }) : null;
    const extract = runner ? (t: string): Promise<Triplet[]> => llmExtractTriplets(t, runner) : extractTriplets;
    let edges = 0;
    let linked = 0;
    for (const d of docs) {
      const triplets = await cognify(adapter, d.id, PROJECT, d.content, { extract });
      edges += triplets.length;
      if (triplets.length) linked++;
    }
    console.log("\n─── cognify ───");
    console.log(`findings scanned: ${docs.length}`);
    console.log(`findings with entities: ${linked}  →  ${edges} edge(s) added`);
    console.log(edges ? "✅ knowledge graph built (query it: GET /api/graph?entity=…)" : "no entities found to link");
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
