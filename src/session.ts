// One independent analysis session, run as its own OS process. Its only link to other sessions is the
// on-disk shared brain (via HTTP). The persistence harness (src/run-persist.ts) spawns this multiple
// times. Writes its metrics to AURALIS_METRICS_OUT.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { AgenticEnvironment } from "@mozaik-ai/core";
import { OracleAdapter, NullMemoryAdapter } from "./memory";
import { ClaudeCodeRunner } from "./runner";
import { Worker, MemoryLibrarian } from "./participants";
import { runOneSession } from "./conductor";

const PROJECT_DIR = resolve(process.env.AURALIS_PROJECT_DIR ?? process.cwd());
const GOAL = process.env.AURALIS_GOAL ?? "Analyse this codebase. Be concise.";
const LABEL = process.env.AURALIS_SESSION_LABEL ?? "session";
const PROJECT = process.env.AURALIS_PROJECT ?? "persist-demo";
const MAX_TURNS = Number(process.env.AURALIS_MAX_TURNS ?? 10);
const COLD = process.env.AURALIS_COLD === "1";
const OUT = process.env.AURALIS_METRICS_OUT ?? `./.auralis-out/session-${LABEL}.json`;

async function main() {
  const env = new AgenticEnvironment();
  const adapter = COLD ? new NullMemoryAdapter() : new OracleAdapter();
  const librarian = new MemoryLibrarian(adapter, PROJECT);
  const makeWorker = (id: string) => {
    const w = new Worker(id, env, new ClaudeCodeRunner({ cwd: PROJECT_DIR, maxTurns: MAX_TURNS }));
    w.join(env);
    return w;
  };
  const m = await runOneSession(GOAL, LABEL, librarian, makeWorker, COLD);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(m, null, 2));
  console.log(`[session ${LABEL}] cross-session recall=${m.crossSessionRecall}  explored=${m.explored}  cold=${COLD}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
