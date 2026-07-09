// Pluggable worker runtimes. ClaudeCodeRunner is the real one — it drives Claude Code via the Agent
// SDK (reuses existing auth, no API key) and its tool_use stream IS our exploration log. Optionally an
// in-process "brain" MCP server is attached so the worker can pull/push the shared brain directly.
// StubRunner is a deterministic stand-in for tests (no LLM, no network).
import { query } from "@anthropic-ai/claude-agent-sdk";
import { resolve, sep } from "node:path";

// Fleet processes mark themselves so repo hooks stand down: SDK worker subprocesses inherit this env and
// load the target repo's .claude hooks — without the mark, session-capture recorded a WORKER's prompt as a
// human instruction at trust 1.0 (found live). Workers' own narration already flows via onStep/the timeline.
process.env.AURALIS_FLEET = "1";

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
const WRITE_TOOLS = new Set(["Write", "Edit"]); // tracked only in build mode
function targetOf(name: string, input: any): string | undefined {
  if (name === "Read" || name === "Write" || name === "Edit") return input?.file_path;
  if (name === "Grep" || name === "Glob") return input?.pattern ?? input?.path;
  return undefined;
}

export class ClaudeCodeRunner implements AgentRunner {
  // `brain` is an in-process MCP server (from brainMcpServer). When set, the worker can call
  // mcp__oracle__search / mcp__oracle__learn directly. MCP tool calls are NOT counted as exploration.
  // `claim` is the concurrent-dedup gate: when set, every Read is routed through canUseTool and DENIED
  // if a teammate already owns that file — deterministic prevention, not a request the LLM may ignore.
  // `build` = write mode: the worker may Edit/Write its OWN file (claim guards writes, not reads) and every
  // write is confined to the workspace dir. Off = analyse mode: read-only, claim guards reads (dedup).
  // `onStep` (optional) narrates every tool call as it happens — the fix for the silent 50–70s while a
  // worker runs. It fires for EVERY tool_use (Read/Grep/Write and mcp__oracle__*), not just tracked reads.
  constructor(private readonly opts: { cwd: string; maxTurns?: number; brain?: unknown; build?: boolean; claim?: (target: string) => Promise<{ ok: boolean; owner: string }>; onStep?: (tool: string, target?: string) => void }) {}

  async run(prompt: string): Promise<RunResult> {
    const explored: Exploration[] = [];
    const denied = new Set<string>(); // targets the claim gate blocked — a teammate owns them, so they never happened
    const gate = this.opts.claim;
    const build = !!this.opts.build;
    const cwd = resolve(this.opts.cwd);
    let result = "";
    const options: any = {
      cwd,
      // build mode also lets the worker WRITE its owned file; analyse mode stays read-only.
      allowedTools: build ? ["Read", "Grep", "Glob", "Write", "Edit"] : ["Read", "Grep", "Glob"],
      permissionMode: "acceptEdits",
      maxTurns: this.opts.maxTurns ?? 12,
    };
    if (this.opts.brain) {
      options.mcpServers = { oracle: this.opts.brain };
      options.allowedTools = [...options.allowedTools, "mcp__oracle__search", "mcp__oracle__learn", "mcp__oracle__decide", "mcp__oracle__note", "mcp__oracle__cite"];
    }
    // A PreToolUse hook is the only place a tool can actually be BLOCKED. In build mode it guards WRITES
    // (anti-clobber via the claim + workspace path confinement); in analyse mode it guards READS (dedup).
    const guarded = build ? ["Write", "Edit"] : gate ? ["Read"] : [];
    if (guarded.length) {
      const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
      const hook = async (input: any) => {
        const path = input?.tool_input?.file_path;
        if (typeof path !== "string") return { continue: true };
        if (build) {
          const abs = resolve(cwd, path); // confine writes to the workspace — no absolute / ".." escape
          if (abs !== cwd && !abs.startsWith(cwd + sep)) {
            denied.add(path); // a blocked write never happened — drop it from the write metric too
            return deny(`Write blocked: ${path} is outside the build workspace. Write only inside the project directory.`);
          }
        }
        if (gate) {
          const r = await gate(path);
          if (!r.ok) {
            denied.add(path);
            return deny(
              build
                ? `A teammate (${r.owner}) owns ${path} — do NOT write it. Build only your own assigned file.`
                : `A teammate (${r.owner}) already owns ${path}. Use mcp__oracle__search to reuse their finding instead of reading it.`,
            );
          }
        }
        return { continue: true };
      };
      options.hooks = { PreToolUse: guarded.map((t) => ({ matcher: t, hooks: [hook] })) };
    }
    const track = build ? new Set<string>([...EXPLORE_TOOLS, ...WRITE_TOOLS]) : EXPLORE_TOOLS;
    try {
      for await (const m of query({ prompt, options })) {
        const msg: any = m;
        if (msg.type === "assistant") {
          for (const block of msg.message?.content ?? []) {
            if (block?.type === "tool_use") {
              const target = targetOf(block.name, block.input);
              if (track.has(block.name) && target) explored.push({ tool: block.name, target });
              this.opts.onStep?.(block.name, target); // narrate EVERY tool call (incl. brain calls) live
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
    // A blocked Read never happened — drop it so redundancy counts prevention, not a phantom read.
    return { result, explored: denied.size ? explored.filter((e) => !denied.has(e.target)) : explored };
  }
}

// A minimal, TOOL-LESS runner for background LLM lifecycle work (contradiction judging, distillation
// synthesis): prompt in, text out, via any OpenAI-compatible chat API. Unlike ClaudeCodeRunner it needs no
// interactive auth and no tools, so a scheduled job can run it UNATTENDED and CHEAP (gpt-4o-mini / a local
// model) without touching the developer's Claude session window. Point AURALIS_RUNNER_API_URL at a local
// server (Ollama / LM Studio) for a free background runner. `temperature` omitted for reasoning-model compat.
export class ApiRunner implements AgentRunner {
  constructor(private readonly opts: { url?: string; model?: string; key?: string } = {}) {}
  async run(prompt: string): Promise<RunResult> {
    const url = this.opts.url ?? process.env.AURALIS_RUNNER_API_URL ?? "https://api.openai.com/v1/chat/completions";
    const model = this.opts.model ?? process.env.AURALIS_RUNNER_MODEL ?? "gpt-4o-mini";
    const key = this.opts.key ?? process.env.AURALIS_RUNNER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    if (!key && !/localhost|127\.0\.0\.1/.test(url)) throw new Error("ApiRunner needs AURALIS_RUNNER_API_KEY (or OPENAI_API_KEY), or a localhost URL");
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
    });
    if (!r.ok) throw new Error(`ApiRunner ${model} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j: any = await r.json();
    return { result: String(j.choices?.[0]?.message?.content ?? "").trim(), explored: [] };
  }
}

// Pick the lifecycle runner by env. Default = ClaudeCodeRunner (interactive Claude auth, current behaviour
// for a human running `pnpm sleep`); AURALIS_RUNNER=api = the cheap, unattended API runner a scheduled
// background job (run-lifecycle) should use so it never competes with the interactive session window.
export function makeRunner(opts: { cwd: string; maxTurns?: number }): AgentRunner {
  return process.env.AURALIS_RUNNER === "api" ? new ApiRunner() : new ClaudeCodeRunner(opts);
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
