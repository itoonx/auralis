// `pnpm run help` — usage guide for auralis. Everything runs via env vars + pnpm scripts (no unified CLI
// yet), so this is the map: commands, key settings, and a typical real-use workflow.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const b = (s: string) => paint("1", s);
const dim = (s: string) => paint("2", s);
const cy = (s: string) => paint("36", s);
const mg = (s: string) => paint("35", s);

const cmd = (name: string, desc: string) => `  ${cy(name.padEnd(36))}${dim(desc)}`;
const setting = (name: string, desc: string) => `  ${mg(name.padEnd(24))}${dim(desc)}`;

console.log(`
${b("auralis")} — a society of AI agents with a shared, persistent brain
${dim("run via env vars + pnpm scripts (there is no unified CLI yet)")}

${b("QUICK START")}
${cmd("pnpm install", "")}
${cmd("pnpm test", "offline proofs of the mechanics + a live memory check")}
  ${dim("AURALIS_PROJECT=myrepo AURALIS_PROJECT_DIR=/path/to/repo pnpm dev")}

${b("COMMANDS")}
 ${dim("— analyse & answer —")}
${cmd('pnpm analyze "<goal>"', "run the society once, then answer from graph-aware recall (quality on)")}
 ${dim("— run the fleet —")}
${cmd("pnpm dev", "analyse a repo (baseline vs shared brain) + a “why” trail")}
${cmd("pnpm persist", "prove cross-session recall across separate processes")}
${cmd("pnpm bench", "run the experiment N times, report mean ± spread")}
${cmd("pnpm bench-graph", "measure how much recall the graph adds over flat search")}
${cmd("pnpm bench-rank", "A/B ranking bench — full ranker vs plain relevance on a decoy corpus")}
 ${dim("— the brain —")}
${cmd('pnpm recall "<query>"', "what recall hands a worker: flat findings + graph neighborhood")}
${cmd("pnpm build-graph", "build the knowledge graph from findings (entity/relationship edges)")}
${cmd("pnpm distill", "consolidate near-duplicate findings into vetted ones")}
${cmd("pnpm sleep", "the sleep job: snapshot -> dedup pass -> LLM judges ambiguous same-entity pairs (contradiction -> invalidate)")}
${cmd("pnpm decisions", "print the honest ADR log from the brain")}
${cmd("pnpm timeline", "replay a run's activity timeline — narrated feed + scorecard")}
${cmd("pnpm values", "show append-only + supersession (never deletes)")}
 ${dim("— services (usually auto-started) —")}
${cmd("pnpm oracle", "run the brain sidecar (oracle-lite) on its own")}
${cmd("pnpm embed", "run the semantic embedding sidecar")}
 ${dim("— dev —")}
${cmd("pnpm test", "run the test suite")}
${cmd("pnpm typecheck", "tsc --noEmit")}
${cmd("pnpm run help", "this guide")}

${b("KEY SETTINGS")} ${dim("(full list + defaults in .env.example)")}
${setting("AURALIS_PROJECT_DIR", "the repo to analyse (default: current dir)")}
${setting("AURALIS_PROJECT", "brain namespace — recall is scoped to it; use one per repo")}
${setting("AURALIS_GOAL", "the analysis goal for pnpm dev")}
${setting("AURALIS_SEMANTIC=1", "real sentence-embedding recall (starts the embed sidecar)")}
${setting("AURALIS_PARALLEL=3", "run each DAG level concurrently (faster; less sharing)")}
${setting("AURALIS_WORKER_PULL", "workers read/write the brain live, mid-task (real-time sharing) — ON by default; =0 to opt out")}
${setting("AURALIS_BASELINE=1", "re-measure mode — also run the no-brain A/B baseline arm (~2x slower; OFF by default)")}
${setting("AURALIS_QUIET=1", "silence the live step narration on stderr (MCP progress still flows)")}
${setting("AURALIS_LOG_TIMING=1", "stream each timing span to stderr; the TIMING summary prints either way")}
${setting("AURALIS_TIMELINE=0", "opt out of the activity timeline (default on when a brain is present)")}
${setting("ORACLE_GRAPH=0", "opt OUT of the automatic heuristic graph the brain builds on every learn")}
${setting("AURALIS_BUILD_GRAPH_LLM", "real predicates via Claude Code — ON by default; =0 for heuristic")}
${setting("AURALIS_DISTILL_LLM=1", "distill with Claude Code for real merges (costs)")}

${b("TYPICAL WORKFLOW")} ${dim("— the short path")}
  ${dim("•")} AURALIS_PROJECT=myrepo AURALIS_PROJECT_DIR=/path/to/repo pnpm analyze "how does auth work?"
    ${dim("↳ runs the fleet once, builds the graph, answers from graph-aware recall (quality on by default)")}
  ${dim("— or step by step —")}
  ${dim("1.")} …pnpm dev   ${dim("2.")} pnpm build-graph   ${dim("3.")} pnpm recall "<q>"   ${dim("4.")} pnpm distill

${b("DOCS")}  README.md ${dim("(full walkthrough)")}  ·  .env.example ${dim("(every setting + default)")}
`);
