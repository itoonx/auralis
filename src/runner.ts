// Pluggable worker runtimes. ClaudeCodeRunner is the real one — it drives Claude Code via the Agent
// SDK (reuses existing auth, no API key) and its tool_use stream IS our exploration log. StubRunner is
// a deterministic stand-in for tests (no LLM, no network).
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
  constructor(private readonly opts: { cwd: string; maxTurns?: number }) {}

  async run(prompt: string): Promise<RunResult> {
    const explored: Exploration[] = [];
    let result = "";
    for await (const m of query({
      prompt,
      options: {
        cwd: this.opts.cwd,
        allowedTools: ["Read", "Grep", "Glob"],
        permissionMode: "acceptEdits",
        maxTurns: this.opts.maxTurns ?? 20,
      } as any,
    })) {
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
