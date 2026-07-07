// The mozaik society: workers on the shared AgenticEnvironment bus, observers (Auditor, Sentry) that
// react to every announcement, and a MemoryLibrarian bridging to the shared brain. Coordination logic
// lives in the Conductor (src/conductor.ts); this file is the participants + the M1 two-task helper.
import { AgenticEnvironment, BaseParticipant, sendMessage } from "@mozaik-ai/core";
import type { AgentRunner, RunResult, Exploration } from "./runner";
import type { MemoryAdapter } from "./memory";
import { graphContext } from "./graph";
import { log } from "./log";
import type { Emit } from "./narrate";

export interface TraceEvent {
  kind: string;
  workerId?: string;
  question?: string;
  summary?: string;
  count?: number;
  targets?: string[];
  ts: number;
}

// Wraps an AgentRunner and announces its finding (with the targets it explored) on the bus.
export class Worker extends BaseParticipant {
  constructor(
    public readonly id: string,
    private readonly env: AgenticEnvironment,
    private readonly runner: AgentRunner,
    // livePull = the runner has the brain MCP tools, so the worker can read/write the shared brain
    // mid-task. That's what turns once-at-start injection into real-time sharing: a sibling running RIGHT
    // NOW commits a finding and this worker sees it on its next search, instead of only at the next level.
    private readonly livePull = false,
    // build = write mode: the worker builds (writes) its owned file instead of only analysing.
    private readonly build = false,
  ) {
    super();
  }

  private buildPrompt(question: string, injectedContext: string): string {
    const seedCtx = injectedContext ? `\n\nAlready in the shared brain when you started:\n${injectedContext}` : "";
    if (this.build) {
      return (
        `You are worker "${this.id}", BUILDING part of a program as a team working AT THE SAME TIME. You OWN exactly one file; teammates own the others.\n` +
        `• First call mcp__oracle__search to pull any interface/contract a teammate already published, so your code matches theirs exactly.\n` +
        `• WRITE your assigned file to disk with the Write tool — plain Node, no dependencies, no external packages. Writing a file a teammate owns is BLOCKED, so build only your own.\n` +
        `• You have NO shell: do NOT run Bash or try to execute, run, or test your code — you can't, and it wastes turns. Just WRITE correct code; auralis runs the checks for you.\n` +
        `• The MOMENT your file exposes something others depend on, call mcp__oracle__learn to publish the exact interface (e.g. "game.js exports play(a,b) -> win|lose|tie").\n` +
        `• If you CHOOSE between real alternatives (data structure, protocol, library approach), record it with mcp__oracle__decide — include what you rejected and why.\n` +
        `You are done only once your file is actually written to disk.${seedCtx}\n\n---\nYour task: ${question}`
      );
    }
    if (this.livePull) {
      const seed = injectedContext ? `\n\nAlready in the shared brain when you started:\n${injectedContext}` : "";
      return (
        `You are worker "${this.id}", analysing a codebase as part of a team working AT THE SAME TIME. Files are auto-assigned so two teammates never read the same one:\n` +
        `• If a Read is BLOCKED because a teammate already owns that file, do NOT retry it — call mcp__oracle__search for that file and reuse their finding instead.\n` +
        `• The MOMENT you learn something worth sharing, call mcp__oracle__learn with it — don't wait until the end, or teammates in flight will miss it.\n` +
        `• If you CHOOSE between real alternatives while answering, record it with mcp__oracle__decide (include the rejected options and why).\n` +
        `Only explore what is genuinely new after checking the brain.${seed}\n\n---\nYour task: ${question}`
      );
    }
    return injectedContext
      ? `You are analysing a codebase. A teammate has ALREADY explored part of it and recorded the findings below. ` +
        `Do NOT re-read files your teammate already covered — trust their findings and only explore what is genuinely new to YOUR task.\n\n` +
        `Teammate's findings:\n${injectedContext}\n\n---\nYour task: ${question}`
      : `Analyse this codebase and answer concisely. Task: ${question}`;
  }

  async run(question: string, injectedContext: string): Promise<RunResult> {
    const prompt = this.buildPrompt(question, injectedContext);
    const res = await this.runner.run(prompt);
    sendMessage(
      this.env,
      JSON.stringify({
        kind: "finding",
        workerId: this.id,
        question,
        summary: res.result.slice(0, 500),
        count: res.explored.length,
        targets: res.explored.map((e) => e.target),
      }),
      this,
    );
    return res;
  }
}

// Pure observer — records every bus message; never runs inference. Writes the per-run audit trail.
export class Auditor extends BaseParticipant {
  readonly events: TraceEvent[] = [];
  async onMessage(message: string): Promise<void> {
    try {
      const e = JSON.parse(message);
      this.events.push({ ...e, ts: Date.now() });
    } catch {
      /* non-JSON chatter: ignore */
    }
  }
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}

// Reactive coordination observer — flags, live on the bus, when a second worker explores a target a
// teammate already covered. This is the "coordination is reactive, not a hardcoded handoff" signal.
export class Sentry extends BaseParticipant {
  private readonly claimed = new Map<string, string>(); // target -> first worker that explored it
  readonly warnings: { target: string; workers: [string, string] }[] = [];
  // emit (optional): narrate each overlap onto the activity timeline as it's detected.
  constructor(private readonly emit?: Emit) {
    super();
  }
  async onMessage(message: string): Promise<void> {
    let e: any;
    try {
      e = JSON.parse(message);
    } catch {
      return;
    }
    if (e?.kind !== "finding" || !Array.isArray(e.targets)) return;
    for (const t of e.targets as string[]) {
      const prev = this.claimed.get(t);
      if (prev && prev !== e.workerId) {
        this.warnings.push({ target: t, workers: [prev, e.workerId] });
        this.emit?.("overlap", "sentry", `${prev} & ${e.workerId} both touched ${t}`, { refs: [t] });
      } else if (!prev) this.claimed.set(t, e.workerId);
    }
  }
}

// The bridge to the shared brain. Pull (search + inject) before a worker runs; push (learn) after.
export class MemoryLibrarian {
  readonly learnedIds: string[] = [];
  constructor(
    private readonly adapter: MemoryAdapter,
    private readonly project = "default",
  ) {}

  async injectFor(question: string): Promise<{ context: string; hitIds: string[] }> {
    const hits = await this.adapter.search(question, { project: this.project, limit: 5 });
    // Ids are shown so the worker can CITE injected findings (P1): before this, the biggest recall path
    // fed ZERO usage signal — reuses came from here, yet none were citable, starving the U3 boost and the
    // U4 forgetting decisions (baseline at change time: cited/seen ratio 0.029).
    const flat = hits.map((h) => `- [${h.id}] ${h.content}`).join("\n");
    // Graph-expand (graph-linked recall): seed from the question + top hits so recall surfaces what CONNECTS
    // to what the query is about, even with no shared keywords. No-op when the brain has no graph.
    const seedText = `${question}\n${hits.map((h) => h.content).join("\n")}`;
    const gc = await log.time("graph.expand", this.project, () => graphContext(this.adapter, this.project, seedText));
    const teach = "(cite the [id] of anything above that materially helps your work: mcp__oracle__cite — only real help)";
    const body = [flat, gc.text].filter(Boolean).join("\n\n");
    const context = body ? `${body}\n${teach}` : "";
    const hitIds = [...new Set([...hits.map((h) => h.id).filter(Boolean), ...gc.docIds])];
    return { context, hitIds };
  }

  async capture(workerId: string, question: string, res: RunResult): Promise<string> {
    const pattern =
      `Aspect already analysed by worker ${workerId} — question: ${question}\n` +
      `Files fully covered (do NOT re-open or re-search these): ${res.explored.map((e) => e.target).join(", ")}\n` +
      `Summary of findings: ${res.result}`;
    const { id } = await this.adapter.learn(pattern, {
      project: this.project,
      concepts: ["analysis"],
      source: `auralis:worker:${workerId}`,
    });
    if (id) this.learnedIds.push(id);
    // Graph memory needs no client-side step anymore: oracle-lite builds heuristic edges AT THE INGRESS
    // for every learn (idempotent — unique edge index). LLM predicate refinement stays a batch job.
    return id;
  }
}

export interface TaskSpec {
  qA: string;
  qB: string;
}
export interface RunOutcome {
  exploredA: Exploration[];
  exploredB: Exploration[];
  reuse: boolean;
  resultA: string;
  resultB: string;
}

// M1 helper: the fixed two-task case (kept for the deterministic M1 test). The general N-task
// coordination lives in src/conductor.ts::coordinate.
export async function conductRun(
  task: TaskSpec,
  workerA: Worker,
  workerB: Worker,
  librarian: MemoryLibrarian,
): Promise<RunOutcome> {
  const ctxA = await librarian.injectFor(task.qA);
  const a = await workerA.run(task.qA, ctxA.context);
  const learnedIdA = await librarian.capture(workerA.id, task.qA, a);

  const ctxB = await librarian.injectFor(task.qB);
  const b = await workerB.run(task.qB, ctxB.context);
  await librarian.capture(workerB.id, task.qB, b);

  return {
    exploredA: a.explored,
    exploredB: b.explored,
    reuse: !!learnedIdA && ctxB.hitIds.includes(learnedIdA),
    resultA: a.result,
    resultB: b.result,
  };
}
