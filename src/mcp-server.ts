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

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { OracleAdapter } from "./memory";
import { ensureOracle, resolveTasks, runFleet } from "./fleet";
import { buildWithRework } from "./build";

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
    try {
      const nodes = await resolveTasks(projectDir, goal, 6);
      const { outcome } = await runFleet("mcp", new OracleAdapter(), nodes, {
        projectDir, project: project ?? "default", maxTurns: 10, concurrency: 3, maxRetries: 1, workerPull: true, onProgress,
      });
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
    accept: z.enum(["rps", "todo"]).optional().describe("acceptance spec to verify against, if one fits"),
  },
  async ({ goal, dir, accept }, extra) => {
    const projectDir = resolve(dir);
    mkdirSync(projectDir, { recursive: true });
    const pkg = resolve(projectDir, "package.json");
    if (!existsSync(pkg)) writeFileSync(pkg, JSON.stringify({ name: "build", private: true, type: "commonjs" }, null, 2) + "\n");
    const { onProgress, stop: stopHb } = startProgress(extra);
    const stop = await ensureOracle();
    try {
      const nodes = await resolveTasks(projectDir, goal, 6, true); // build-aware planner
      // Same closed loop as the CLI: on acceptance FAIL, rework the fleet (bounded). Progress keeps the call alive.
      const { shared, acc, attempts } = await buildWithRework(
        new OracleAdapter(),
        nodes,
        { projectDir, project: "mcp-build", maxTurns: 15, concurrency: 3, maxRetries: 1, workerPull: true, build: true, onProgress },
        { accept, retries: 1, projectDir },
      );
      const written = [...new Set(shared.outcome.perWorker.flatMap((w) => w.explored).filter((e) => e.tool === "Write" || e.tool === "Edit").map((e) => e.target))];
      const verdict = acc ? `\n\nacceptance (${accept}): ${acc.pass ? "✅ PASS" : `❌ FAIL after ${attempts} rework(s)\n${acc.failLines}`}` : "";
      const text = `built ${written.length} file(s) in ${projectDir}:\n${written.map((f) => `- ${f}`).join("\n")}${verdict}`;
      return { content: [{ type: "text", text }] };
    } finally {
      stopHb();
      stop();
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("auralis MCP server ready (stdio)");
