// `pnpm distill` — consolidate the brain: cluster similar raw findings, synthesize one vetted finding
// per cluster, and supersede the raws (never delete). AURALIS_DISTILL_LLM=1 synthesizes with Claude
// Code (higher quality, costs); default is a cheap heuristic. AURALIS_SEMANTIC=1 clusters by meaning.
import { OracleAdapter } from "./memory";
import { ensureOracle } from "./fleet";
import { distill } from "./distill";
import { ClaudeCodeRunner } from "./runner";

const PROJECT = process.env.AURALIS_PROJECT ?? "default";
const PROJECT_DIR = process.env.AURALIS_PROJECT_DIR ?? process.cwd();
const THRESHOLD = Number(process.env.AURALIS_DISTILL_THRESHOLD ?? 0.55);
const LLM = process.env.AURALIS_DISTILL_LLM === "1";

async function heuristicSynthesize(contents: string[]): Promise<string> {
  const spine = [...contents].sort((a, b) => b.length - a.length)[0];
  return `Consolidated finding (distilled from ${contents.length} related notes):\n${spine}`;
}

async function llmSynthesize(contents: string[]): Promise<string> {
  const runner = new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: 4 });
  const prompt =
    `Merge these ${contents.length} related findings into ONE concise, non-redundant consolidated finding. ` +
    `Resolve contradictions, keep only what is durable, output the consolidated finding only.\n\n` +
    contents.map((c, i) => `[${i + 1}] ${c}`).join("\n\n");
  const { result } = await runner.run(prompt);
  return result.trim() || heuristicSynthesize(contents);
}

async function main() {
  const stop = await ensureOracle();
  try {
    const res = await distill(new OracleAdapter(), PROJECT, {
      threshold: THRESHOLD,
      synthesize: LLM ? llmSynthesize : heuristicSynthesize,
    });
    console.log("\n─── distillation ───");
    console.log(`raw findings scanned: ${res.rawDocs}`);
    console.log(`clusters of ≥2 similar: ${res.clusters}  →  ${res.distilled} vetted finding(s), ${res.superseded} raw superseded`);
    console.log(res.distilled ? "✅ brain consolidated (raws superseded, never deleted)" : "nothing to consolidate yet");
  } finally {
    stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
