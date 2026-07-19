// auralis as an MCP server — so a user's normal Claude Code CLI can call the fleet as tools. Proven viable
// by the nesting spike: an MCP tool can call the Agent SDK's query() (auth + stdio + re-entrancy all hold).
//
// stdout is the JSON-RPC channel, so it must stay clean: we redirect every console.log in this process to
// stderr, and AURALIS_MCP makes the sidecars log to stderr too (see ensureOracle). The StdioServerTransport
// writes to process.stdout directly, untouched.
//
// Install (a user's .mcp.json):
//   { "mcpServers": { "auralis": { "command": "pnpm", "args": ["-C", "/path/to/auralis", "mcp"] } } }
process.env.AURALIS_MCP = "1";
console.log = (...a: unknown[]) => console.error(...a); // protect the stdout JSON-RPC channel

import "./load-env"; // MUST be first: loads .env so memory.ts's AUTH picks up ORACLE_TOKEN before it's computed
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { OracleAdapter } from "./memory";
import { ensureOracle, resolveTasks, runFleet, stepSink } from "./fleet";
import { buildWithRework } from "./build";
import { recallRetro, writeRetro } from "./retro";

// Bridge fleet coordination events to MCP progress notifications: keeps a long tool call alive (clients that
// set resetTimeoutOnProgress won't time out) and shows the timeline live. No-op if the client sent no token.
function progressOf(extra: any): ((msg: string) => void) | undefined {
  const token = extra?._meta?.progressToken;
  if (token == null || typeof extra?.sendNotification !== "function") return undefined;
  let n = 0;
  return (msg: string) => {
    n += 1;
    try {
      void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: n, message: msg } });
    } catch {
      /* progress is best-effort */
    }
  };
}

// Coordination events are sparse — a single worker.run can be ~50s silent — so event-only progress can still
// let a client time out mid-worker. A heartbeat tick keeps progress flowing under the timeout; combined with
// resetTimeoutOnProgress it keeps a multi-minute build alive without the caller setting MCP_TOOL_TIMEOUT.
function startProgress(extra: any): { onProgress?: (msg: string) => void; stop: () => void } {
  const send = progressOf(extra);
  if (!send) return { stop: () => {} };
  const t0 = Date.now();
  send("starting…");
  const hb = setInterval(() => send(`working… ${Math.round((Date.now() - t0) / 1000)}s`), 15000);
  if (typeof hb.unref === "function") hb.unref();
  return { onProgress: send, stop: () => clearInterval(hb) };
}

const server = new McpServer({ name: "auralis", version: "1.0.0" });

server.tool(
  "analyze",
  "Run a society of AI agents to analyse a codebase and answer a question, coordinating through a shared persistent brain (they don't re-read each other's files). Returns each subtask's findings.",
  {
    goal: z.string().describe("what to understand about the codebase, e.g. 'how does authentication work?'"),
    dir: z.string().optional().describe("path to the repo to analyse (default: current directory)"),
    project: z.string().optional().describe("brain namespace — recall is scoped to it; use one per repo"),
  },
  async ({ goal, dir, project }, extra) => {
    const projectDir = resolve(dir ?? process.cwd());
    const { onProgress, stop: stopHb } = startProgress(extra);
    const stop = await ensureOracle();
    const proj = project ?? "default";
    const adapter = new OracleAdapter();
    try {
      // Self-improving loop: recall prior lessons for this goal, feed them to the planner, record a new retro.
      const prior = await recallRetro(adapter, proj, goal);
      const goalForPlan = prior ? `${goal}\n\n[MEMORY — measured from a prior run of a similar goal. If it names a failed check, that check is the real contract; satisfy it. Learn from it.]\n${prior}` : goal;
      const nodes = await resolveTasks(projectDir, goalForPlan, 6, false, stepSink("planner", projectDir, onProgress));
      const { outcome } = await runFleet("mcp", adapter, nodes, {
        projectDir, project: proj, maxTurns: 10, concurrency: 3, maxRetries: 1, workerPull: true, onProgress,
      });
      if (outcome.perWorker.some((w) => w.explored.length > 0)) await writeRetro(adapter, proj, { goal, mode: "analyze", reuses: outcome.reuses, repairs: outcome.repairs }); // dead run → no lesson
      const text = outcome.provenance.map((p) => `■ ${p.task}\n${p.summary}`).join("\n\n") || "(no findings)";
      return { content: [{ type: "text", text }] };
    } finally {
      stopHb();
      stop();
    }
  },
);

server.tool(
  "build",
  "Run a society of AI agents to BUILD a small program into a directory (each worker owns its own file; the claim gate stops them clobbering one another), then verify the result against a spec. Returns the files written and the acceptance verdict.",
  {
    goal: z.string().describe("what to build, e.g. 'a rock-paper-scissors game in Node'"),
    dir: z.string().describe("the directory to build into (created if missing; kept isolated)"),
    accept: z.enum(["rps", "todo", "restapi", "calc"]).optional().describe("acceptance spec to verify against, if one fits"),
  },
  async ({ goal, dir, accept }, extra) => {
    const projectDir = resolve(dir);
    mkdirSync(projectDir, { recursive: true });
    const pkg = resolve(projectDir, "package.json");
    if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: "build", private: true, type: "commonjs" }, null, 2) + "\n");
    const { onProgress, stop: stopHb } = startProgress(extra);
    const stop = await ensureOracle();
    const adapter = new OracleAdapter();
    try {
      // Self-improving loop: recall prior build lessons for this goal, feed them to the planner.
      const prior = await recallRetro(adapter, "mcp-build", goal);
      const goalForPlan = prior ? `${goal}\n\n[MEMORY — measured from a prior build of a similar goal, not optional. If it names a FAILED acceptance check, that check is the real contract: satisfy it up front even if the goal above is silent or seems to say otherwise. Do NOT repeat the miss.]\n${prior}` : goal;
      const nodes = await resolveTasks(projectDir, goalForPlan, 6, true, stepSink("planner", projectDir, onProgress)); // build-aware planner
      // Same closed loop as the CLI: on acceptance FAIL, rework the fleet (bounded). Progress keeps the call alive.
      const { shared, acc, attempts, firstFail } = await buildWithRework(
        adapter,
        nodes,
        { projectDir, project: "mcp-build", maxTurns: 15, concurrency: 3, maxRetries: 1, workerPull: true, build: true, onProgress },
        { accept, retries: 1, projectDir },
      );
      const written = [...new Set(shared.outcome.perWorker.flatMap((w) => w.explored).filter((e) => e.tool === "Write" || e.tool === "Edit").map((e) => e.target))];
      if (written.length > 0 || shared.outcome.perWorker.some((w) => w.explored.length > 0)) await writeRetro(adapter, "mcp-build", { goal, mode: "build", pass: acc ? acc.pass : written.length >= 1, reworks: attempts, firstFail, filesWritten: written.length, reuses: shared.outcome.reuses, repairs: shared.outcome.repairs }); // dead run → no lesson
      const verdict = acc ? `\n\nacceptance (${accept}): ${acc.pass ? "✅ PASS" : `❌ FAIL after ${attempts} rework(s)\n${acc.failLines}`}` : "";
      const text = `built ${written.length} file(s) in ${projectDir}:\n${written.map((f) => `- ${f}`).join("\n")}${verdict}`;
      return { content: [{ type: "text", text }] };
    } finally {
      stopHb();
      stop();
    }
  },
);

// Brainstorm is cwd-INDEPENDENT (topic in, decision brief out, learned to the brain) — so exposing it as a
// tool makes it usable from ANY project once this server is registered at user scope. We shell out to the
// battle-tested CLI (src/run-brainstorm.ts) rather than re-wire its main(): the CLI already splits stdout
// (the synthesis) from stderr (live progress), which is exactly the shape a tool needs. Runs in the auralis
// repo dir so pnpm/tsx and .env/.env.oracle resolve no matter which project the caller is in.
const AURALIS_ROOT = fileURLToPath(new URL("..", import.meta.url));
server.tool(
  "brainstorm",
  "Run a multi-model panel brainstorm on a topic or design question: models propose independently, then critique and revise across rounds until the votes stabilize, and a synthesizer writes a decision brief that is LEARNED into the shared brain (recallable by every future session and fleet worker). Works from any project. Takes minutes and bills the configured paid providers.",
  {
    topic: z.string().describe("the topic or design question to brainstorm, e.g. 'should we cache at the edge or the origin?'"),
    mode: z.enum(["panel", "converge"]).optional().describe("panel (default) = simultaneous propose+converge; converge = adversarial dialectic (propose→challenge→defend→judge→synthesize), learned PROVISIONAL with its scar record"),
  },
  async ({ topic, mode }, extra) => {
    const { onProgress, stop: stopHb } = startProgress(extra);
    const env = { ...process.env };
    if (mode) env.AURALIS_BRAINSTORM_MODE = mode;
    try {
      const synthesis = await new Promise<string>((res, rej) => {
        const child = spawn("pnpm", ["-C", AURALIS_ROOT, "brainstorm", topic], { env });
        let out = "", errTail = "";
        child.stdout.on("data", (b) => { out += b.toString(); });
        child.stderr.on("data", (b) => {
          const s = b.toString();
          errTail = (errTail + s).slice(-2000); // keep the tail for a useful error if it exits non-zero
          for (const line of s.split("\n")) if (line.trim()) onProgress?.(line.trim());
        });
        child.on("error", rej);
        child.on("close", (code) => (code === 0 ? res(out.trim()) : rej(new Error(`brainstorm exited ${code}: ${errTail.slice(-500)}`))));
      });
      return { content: [{ type: "text", text: synthesis || "(brainstorm produced no synthesis — check provider keys/credits)" }] };
    } finally {
      stopHb();
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("auralis MCP server ready (stdio)");
