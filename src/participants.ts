// The mozaik society: workers on the shared AgenticEnvironment bus, an Auditor observing every
// announcement, and a MemoryLibrarian bridging to the shared brain (pull before a worker runs,
// push after). The Conductor sequences A -> B so B can reuse what A learned.
import { AgenticEnvironment, BaseParticipant, sendMessage } from "@mozaik-ai/core";
import type { AgentRunner, RunResult, Exploration } from "./runner";
import type { MemoryAdapter } from "./memory";

export interface TraceEvent {
  kind: string;
  workerId?: string;
  question?: string;
  summary?: string;
  count?: number;
  ts: number;
}

// Wraps an AgentRunner and announces its finding on the bus (observed by the Auditor).
export class Worker extends BaseParticipant {
  constructor(
    public readonly id: string,
    private readonly env: AgenticEnvironment,
    private readonly runner: AgentRunner,
  ) {
    super();
  }

  async run(question: string, injectedContext: string): Promise<RunResult> {
    const prompt = injectedContext
      ? `You are analysing a codebase. A teammate has ALREADY explored part of it and recorded the findings below. ` +
        `Do NOT re-read files your teammate already covered — trust their findings and only explore what is genuinely new to YOUR task.\n\n` +
        `Teammate's findings:\n${injectedContext}\n\n---\nYour task: ${question}`
      : `Analyse this codebase and answer concisely. Task: ${question}`;
    const res = await this.runner.run(prompt);
    sendMessage(
      this.env,
      JSON.stringify({
        kind: "finding",
        workerId: this.id,
        question,
        summary: res.result.slice(0, 500),
        count: res.explored.length,
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

// The bridge to the shared brain. Pull (search + inject) before a worker runs; push (learn) after.
export class MemoryLibrarian {
  readonly learnedIds: string[] = [];
  constructor(
    private readonly adapter: MemoryAdapter,
    private readonly project = "default",
  ) {}

  async injectFor(question: string): Promise<{ context: string; hitIds: string[] }> {
    const hits = await this.adapter.search(question, { project: this.project, limit: 5 });
    return {
      context: hits.map((h) => `- ${h.content}`).join("\n"),
      hitIds: hits.map((h) => h.id).filter(Boolean),
    };
  }

  async capture(workerId: string, question: string, res: RunResult): Promise<string> {
    const pattern =
      `[from worker ${workerId}] Q: ${question}\n` +
      `Findings: ${res.result}\n` +
      `Files already explored (do not re-read): ${res.explored.map((e) => e.target).join(", ")}`;
    const { id } = await this.adapter.learn(pattern, {
      project: this.project,
      concepts: ["analysis"],
      source: `auralis:worker:${workerId}`,
    });
    if (id) this.learnedIds.push(id);
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
  reuse: boolean; // did B's injected context include a doc A just wrote?
  resultA: string;
  resultB: string;
}

// One reference run: A explores with a cold brain, its findings land in memory, B reuses them.
export async function conductRun(
  task: TaskSpec,
  workerA: Worker,
  workerB: Worker,
  librarian: MemoryLibrarian,
): Promise<RunOutcome> {
  const ctxA = await librarian.injectFor(task.qA); // empty on a cold brain / baseline
  const a = await workerA.run(task.qA, ctxA.context);
  const learnedIdA = await librarian.capture(workerA.id, task.qA, a);

  const ctxB = await librarian.injectFor(task.qB); // now sees A's finding (FTS write is synchronous)
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
