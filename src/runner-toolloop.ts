// ToolLoopRunner — the OpenAI-compatible agentic loop (docs/prd-multi-runner.md M1). One runner covers
// GPT, GLM, DeepSeek, local Ollama…: anything speaking chat-completions + function calling. It honours the
// same contract as ClaudeCodeRunner (test/runner-contract.test.ts is the source of truth): identical tool
// NAMES (worker prompts stay untouched), the claim gate + workspace confinement enforced in the dispatcher
// (we own the loop — no PreToolUse hook needed), explored/denied bookkeeping, onStep narration, early-stop.
// M0.5 spike verdict: mozaik's runInference is fire-and-forget with a closed model registry (unknown model
// throws; wire model passes through verbatim), so this loop stays on raw fetch; mozaik remains the bus layer.
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve, sep, relative } from "node:path";
import { EXPLORE_TOOLS, WRITE_TOOLS, targetOf, type AgentRunner, type Exploration, type RunResult } from "./runner";

// The brain surface a worker sees — same five tools the Claude runner gets via MCP, names included.
export interface BrainTools {
  search(query: string): Promise<string>;
  learn(pattern: string): Promise<string>;
  decide?(decision: string, rejected?: string): Promise<string>;
  note?(note: string): Promise<string>;
  cite?(id: string): Promise<string>;
}

export interface ToolLoopCfg {
  cwd: string;
  baseURL: string; // e.g. https://api.openai.com/v1 · https://open.bigmodel.cn/api/paas/v4
  model: string;
  apiKey?: string;
  maxTurns?: number;
  build?: boolean;
  brain?: BrainTools;
  claim?: (target: string) => Promise<{ ok: boolean; owner: string }>;
  onStep?: (tool: string, target?: string) => void;
  maxToolChars?: number; // clamp tool outputs so small-context models survive (default 8000)
}

const READ_CAP = 16_000;

function toolDefs(build: boolean, brain: boolean) {
  const p = (props: Record<string, unknown>, required: string[]) => ({ type: "object", properties: props, required });
  const defs: any[] = [
    { name: "Read", description: "Read a file. Returns its text (truncated when huge).", parameters: p({ file_path: { type: "string" } }, ["file_path"]) },
    { name: "Grep", description: "Search file contents for a regex. Returns file:line: text matches.", parameters: p({ pattern: { type: "string" }, path: { type: "string", description: "directory to search (default: project root)" } }, ["pattern"]) },
    { name: "Glob", description: "List files matching a glob like src/**/*.ts.", parameters: p({ pattern: { type: "string" } }, ["pattern"]) },
  ];
  if (build) {
    defs.push(
      { name: "Write", description: "Write a file (build mode — only your own assigned file).", parameters: p({ file_path: { type: "string" }, content: { type: "string" } }, ["file_path", "content"]) },
      { name: "Edit", description: "Replace an exact string in a file.", parameters: p({ file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, ["file_path", "old_string", "new_string"]) },
    );
  }
  if (brain) {
    defs.push(
      { name: "mcp__oracle__search", description: "Search the shared brain for teammates' findings.", parameters: p({ query: { type: "string" } }, ["query"]) },
      { name: "mcp__oracle__learn", description: "Publish a finding/interface to the shared brain the moment you have it.", parameters: p({ pattern: { type: "string" } }, ["pattern"]) },
      { name: "mcp__oracle__decide", description: "Record a decision between real alternatives (include what you rejected and why).", parameters: p({ decision: { type: "string" }, rejected: { type: "string" } }, ["decision"]) },
      { name: "mcp__oracle__note", description: "Leave a short observability note on the run timeline.", parameters: p({ note: { type: "string" } }, ["note"]) },
      { name: "mcp__oracle__cite", description: "Credit an injected [id] that materially helped.", parameters: p({ id: { type: "string" } }, ["id"]) },
    );
  }
  return defs.map((d) => ({ type: "function", function: d }));
}

// Minimal glob→regex: supports **, *, ? — enough for worker patterns; ripgrep parity is a later upgrade.
function globToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, " ").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/ /g, ".*");
  return new RegExp(`^${esc}$`);
}

function* walk(dir: string, depth = 8): Generator<string> {
  if (depth < 0) return;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".git")) continue;
    const full = join(dir, e);
    let st; try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full, depth - 1);
    else yield full;
  }
}

export class ToolLoopRunner implements AgentRunner {
  constructor(private readonly cfg: ToolLoopCfg) {}

  async run(prompt: string): Promise<RunResult> {
    const { cfg } = this;
    const cwd = resolve(cfg.cwd);
    const build = !!cfg.build;
    const maxTurns = cfg.maxTurns ?? 12;
    const clamp = (s: string, cap = cfg.maxToolChars ?? 8_000) => (s.length > cap ? s.slice(0, cap) + `\n…(truncated ${s.length - cap} chars)` : s);
    const explored: Exploration[] = [];
    const denied = new Set<string>();
    const track = build ? new Set<string>([...EXPLORE_TOOLS, ...WRITE_TOOLS]) : EXPLORE_TOOLS;
    const guarded = build ? WRITE_TOOLS : cfg.claim ? new Set(["Read"]) : new Set<string>();

    const dispatch = async (name: string, args: any): Promise<string> => {
      const target = targetOf(name, args);
      // The gate — same semantics as ClaudeCodeRunner's PreToolUse hook, enforced right here because we
      // own the loop: confinement first (build), then the claim; a denied target never happened.
      if (guarded.has(name) && typeof args?.file_path === "string") {
        if (build) {
          const abs = resolve(cwd, args.file_path);
          if (abs !== cwd && !abs.startsWith(cwd + sep)) {
            denied.add(args.file_path);
            return `DENIED: ${args.file_path} is outside the build workspace. Write only inside the project directory.`;
          }
        }
        if (cfg.claim) {
          const r = await cfg.claim(args.file_path);
          if (!r.ok) {
            denied.add(args.file_path);
            return build
              ? `DENIED: a teammate (${r.owner}) owns ${args.file_path} — do NOT write it. Build only your own assigned file.`
              : `DENIED: a teammate (${r.owner}) already owns ${args.file_path}. Use mcp__oracle__search to reuse their finding instead of reading it.`;
          }
        }
      }
      if (track.has(name) && target) explored.push({ tool: name, target });
      try {
        switch (name) {
          case "Read": return clamp(readFileSync(resolve(cwd, String(args.file_path)), "utf8"), READ_CAP);
          case "Glob": {
            const re = globToRegExp(String(args.pattern));
            const hits = [...walk(cwd)].map((f) => relative(cwd, f)).filter((f) => re.test(f)).slice(0, 200);
            return hits.join("\n") || "(no matches)";
          }
          case "Grep": {
            const re = new RegExp(String(args.pattern));
            const root = args.path ? resolve(cwd, String(args.path)) : cwd;
            const out: string[] = [];
            for (const f of walk(root)) {
              let text; try { text = readFileSync(f, "utf8"); } catch { continue; }
              const lines = text.split("\n");
              for (let i = 0; i < lines.length && out.length < 100; i++) if (re.test(lines[i])) out.push(`${relative(cwd, f)}:${i + 1}: ${lines[i].slice(0, 200)}`);
              if (out.length >= 100) break;
            }
            return clamp(out.join("\n") || "(no matches)");
          }
          case "Write": {
            const abs = resolve(cwd, String(args.file_path));
            mkdirSync(resolve(abs, ".."), { recursive: true });
            writeFileSync(abs, String(args.content ?? ""));
            return `wrote ${args.file_path}`;
          }
          case "Edit": {
            const abs = resolve(cwd, String(args.file_path));
            const text = readFileSync(abs, "utf8");
            if (!text.includes(String(args.old_string))) return `EDIT FAILED: old_string not found in ${args.file_path}`;
            writeFileSync(abs, text.replace(String(args.old_string), String(args.new_string ?? "")));
            return `edited ${args.file_path}`;
          }
          case "mcp__oracle__search": return clamp((await this.cfg.brain?.search(String(args.query))) ?? "(brain unavailable)");
          case "mcp__oracle__learn": return (await this.cfg.brain?.learn(String(args.pattern))) ?? "(brain unavailable)";
          case "mcp__oracle__decide": return (await this.cfg.brain?.decide?.(String(args.decision), args.rejected ? String(args.rejected) : undefined)) ?? "(recorded)";
          case "mcp__oracle__note": return (await this.cfg.brain?.note?.(String(args.note))) ?? "(recorded)";
          case "mcp__oracle__cite": return (await this.cfg.brain?.cite?.(String(args.id))) ?? "(cited)";
          default: return `UNKNOWN TOOL: ${name}`;
        }
      } catch (err) {
        return `TOOL ERROR (${name}): ${(err as Error).message}`;
      }
    };

    // Evidence discipline — found live (M3): gpt-5.4-mini did the work correctly but ANSWERED with
    // meta-talk ("Done — the file has been written"), so the LLM critic rejected every summary and the
    // brain captured nothing. Claude workers self-corrected after one rejection; small API models don't.
    const messages: any[] = [
      { role: "system", content: "You are a worker agent on a coding fleet. Use the tools to do the work — never merely describe it. Your FINAL message is a report to a strict reviewer: it must carry concrete evidence (quote the exact content you wrote, or the exact facts you found, with file paths). Unevidenced claims like 'the file has been written' are rejected." },
      { role: "user", content: prompt },
    ];
    const tools = toolDefs(build, !!cfg.brain);
    let result = "";
    let turns = 0;
    while (turns < maxTurns) {
      turns++;
      let resp: Response | undefined;
      // one retry on 429/5xx — transient provider hiccups; a persistent failure degrades LOUDLY below.
      for (let attempt = 0; attempt < 2; attempt++) {
        resp = await fetch(`${cfg.baseURL.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
          body: JSON.stringify({ model: cfg.model, messages, tools }),
        }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message ?? e) }) as unknown as Response);
        if (resp.ok || (resp.status < 500 && resp.status !== 429)) break;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
      if (!resp || !resp.ok) {
        // Loud, Critic-rejectable degradation — the INFRA_ERROR pattern in the Critic catches this text.
        const detail = resp ? (await resp.text()).slice(0, 300) : "no response";
        result = result || `(worker stopped early: provider error ${resp?.status ?? "?"} — ${detail})`;
        break;
      }
      const data: any = await resp.json();
      const msg = data.choices?.[0]?.message ?? {};
      messages.push(msg);
      const calls: any[] = msg.tool_calls ?? [];
      if (!calls.length) {
        result = String(msg.content ?? "").trim();
        break;
      }
      for (const call of calls) {
        const name = String(call.function?.name ?? "");
        let args: any = null;
        try { args = JSON.parse(call.function?.arguments || "{}"); } catch { /* malformed → corrective error below */ }
        this.cfg.onStep?.(name, args ? targetOf(name, args) : undefined);
        const output = args === null ? `TOOL ERROR (${name}): malformed JSON arguments` : await dispatch(name, args);
        messages.push({ role: "tool", tool_call_id: call.id, content: output });
      }
    }
    if (!result) result = `(worker stopped early: hit the ${maxTurns}-turn budget)`;
    return { result, explored: denied.size ? explored.filter((e) => !denied.has(e.target)) : explored };
  }
}
