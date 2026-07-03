// The mozaik society: workers on the shared AgenticEnvironment bus, observers (Auditor, Sentry) that
// react to every announcement, and a MemoryLibrarian bridging to the shared brain. Coordination logic
// lives in the Conductor (src/conductor.ts); this file is the participants + the M1 two-task helper.
import { AgenticEnvironment, BaseParticipant, sendMessage } from "@mozaik-ai/core";
import type { AgentRunner, RunResult, Exploration } from "./runner";
import type { MemoryAdapter } from "./memory";

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
      if (prev && prev !== e.workerId) this.warnings.push({ target: t, workers: [prev, e.workerId] });
      else if (!prev) this.claimed.set(t, e.workerId);
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
    return {
      context: hits.map((h) => `- ${h.content}`).join("\n"),
      hitIds: hits.map((h) => h.id).filter(Boolean),
    };
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
