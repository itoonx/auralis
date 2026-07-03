// `pnpm decisions` — print the honest ADR log straight from the shared brain. These aren't files in the
// repo; they're searchable knowledge a future agent (or you) can pull up when touching the area.
import { OracleAdapter } from "./memory";
import { ensureOracle } from "./fleet";
import { listDecisions } from "./decision";

const PROJECT = process.env.AURALIS_PROJECT ?? "default";

async function main() {
  const stop = await ensureOracle();
  try {
    const decisions = await listDecisions(new OracleAdapter(), PROJECT);
    if (!decisions.length) {
      console.log("No decisions recorded in the brain yet. Agents record them via the `decide` tool.");
      return;
    }
    console.log(`── ${decisions.length} decision(s) in the shared brain ──\n`);
    for (const d of decisions) console.log(d.text + "\n" + "─".repeat(64) + "\n");
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
