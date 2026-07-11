// `pnpm recall "<query>"` — show what a worker would be handed for a query: flat findings PLUS the graph
// neighborhood (GRAPH_COMPLETION). Proves the graph is USED in recall, not just built.
import "./load-env"; // MUST be first: loads .env so memory.ts's AUTH picks up ORACLE_TOKEN before it's computed
import { OracleAdapter } from "./memory";
import { ensureOracle } from "./fleet";
import { MemoryLibrarian } from "./participants";

const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const query = process.argv.slice(2).join(" ").trim() || process.env.AURALIS_GOAL || "the codebase";

async function main() {
  const stop = await ensureOracle();
  try {
    const { context, hitIds } = await new MemoryLibrarian(new OracleAdapter(), PROJECT).injectFor(query);
    console.log(`\n─── recall ───\nquery: ${query}\n`);
    console.log(context || "(nothing recalled)");
    console.log(`\n${hitIds.length} finding(s) recalled (flat search + graph)`);
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
