// Pluggable worker runtimes. ClaudeCodeRunner is the real one — it drives Claude Code via the Agent
// SDK (reuses existing auth, no API key) and its tool_use stream IS our exploration log. Optionally an
// in-process "brain" MCP server is attached so the worker can pull/push the shared brain directly.
// StubRunner is a deterministic stand-in for tests (no LLM, no network).
import { query } from "@anthropic-ai/claude-agent-sdk";

export interface Exploration {
  tool: string;
  target: string;
}
export interface RunResult {
  result: string;
  explored: Exploration[];
}
export interface AgentRunner {
  run(prompt: string): Promise<RunResult>;
}

const EXPLORE_TOOLS = new Set(["Read", "Grep", "Glob"]);
function targetOf(name: string, input: any): string | undefined {
  if (name === "Read") return input?.file_path;
  if (name === "Grep" || name === "Glob") return input?.pattern ?? input?.path;
  return undefined;
}

export class ClaudeCodeRunner implements AgentRunner {
  // `brain` is an in-process MCP server (from brainMcpServer). When set, the worker can call
  // mcp__oracle__search / mcp__oracle__learn directly. MCP tool calls are NOT counted as exploration.
  constructor(private readonly opts: { cwd: string; maxTurns?: number; brain?: unknown }) {}

  async run(prompt: string): Promise<RunResult> {
    const explored: Exploration[] = [];
    let result = "";
    const options: any = {
      cwd: this.opts.cwd,
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "acceptEdits",
      maxTurns: this.opts.maxTurns ?? 12,
    };
    if (this.opts.brain) {
      options.mcpServers = { oracle: this.opts.brain };
      options.allowedTools = [...options.allowedTools, "mcp__oracle__search", "mcp__oracle__learn", "mcp__oracle__decide"];
    }
    try {
      for await (const m of query({ prompt, options })) {
        const msg: any = m;
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block?.type === "tool_use" && EXPLORE_TOOLS.has(block.name)) {
              const target = targetOf(block.name, block.input);
              if (target) explored.push({ tool: block.name, target });
            }
          }
        } else if (msg.type === "result" && msg.subtype === "success") {
          result = String(msg.result ?? "");
        }
      }
    } catch (err) {
      // The agent hit its turn/budget cap or errored mid-run. The exploration captured before the
      // throw is what the redundancy metric needs, so keep it and note the early stop.
      if (!result) result = `(worker stopped early: ${(err as Error).message})`;
    }
    return { result, explored };
  }
}

// Deterministic worker for tests: "explores" a fixed file list, but SKIPS any file already named in
// its prompt — modelling an agent that reuses injected shared knowledge instead of re-reading it.
export class StubRunner implements AgentRunner {
  constructor(private readonly files: string[]) {}
  async run(prompt: string): Promise<RunResult> {
    const explored = this.files
      .filter((f) => !prompt.includes(f))
      .map((f) => ({ tool: "Read", target: f }));
    return {
      result: `explored ${explored.length} files: ${explored.map((e) => e.target).join(", ")}`,
      explored,
    };
  }
}
