// The activity timeline emitter. ONE tiny seam every coordination site calls to narrate a moment onto the
// shared, replayable timeline. Two rules keep it safe: (1) best-effort — the POST is fire-and-forget and
// never throws into the hot path, so a dead oracle can't slow or break a run; (2) deterministic — the glyph
// and shape are templated here, no LLM writes a structural line. Pure helpers (format/scorecard) are split
// out so they test without a network.
import { log } from "./log";
import type { MemoryAdapter, TimelineEvent } from "./memory";

// Glyph per kind — the human line is self-describing when read raw, no legend needed.
export const GLYPH: Record<string, string> = {
  phase: "━",
  intent: "▸",
  note: "✎",
  finding: "✓",
  dedup: "⇄",
  overlap: "⚠",
  repair: "↻",
};

// The stored human line: glyph + body. Body is already a concise, person-readable sentence.
export function format(kind: string, body: string): string {
  return `${GLYPH[kind] ?? "·"} ${body}`;
}

export type Emit = (
  kind: string,
  actor: string,
  body: string,
  opts?: { nodeId?: string; parentNode?: string[]; refs?: string[] },
) => void;

// Bind an emitter to one run. The returned emit() is synchronous-looking: it kicks off the POST and returns
// immediately. Failures are swallowed — the timeline is observability, never a dependency of the work.
export function makeEmitter(ctx: {
  adapter: MemoryAdapter;
  runId: string;
  project: string;
  onEvent?: (kind: string, actor: string, human: string) => void; // live sink (e.g. MCP progress notifications)
}): Emit {
  return (kind, actor, body, opts = {}) => {
    const human = format(kind, body);
    log.event(`timeline.${kind}`, { actor, human }); // also streams to stderr under AURALIS_LOG_TIMING=1
    ctx.onEvent?.(kind, actor, human); // best-effort live bridge; never throws into the run
    // Promise.resolve tolerates adapters without recordEvent (Null returns void) and never rejects the caller.
    Promise.resolve(
      ctx.adapter.recordEvent?.({ runId: ctx.runId, project: ctx.project, kind, actor, human, nodeId: opts.nodeId, parentNode: opts.parentNode, refs: opts.refs }),
    ).catch(() => {
      /* timeline is best-effort — a run must not fail because the ledger did */
    });
  };
}

// The run scorecard: turn the timeline into evidence. Computed purely from the events (no extra storage) —
// this is the "measured, not asserted" edge over a plain feed log.
export interface Scorecard {
  tasks: number;
  deduped: number;
  overlaps: number;
  repairs: number;
  notes: number;
}
export function scorecard(events: TimelineEvent[]): Scorecard {
  const count = (k: string) => events.filter((e) => e.kind === k).length;
  const tasks = new Set(events.filter((e) => e.nodeId).map((e) => e.nodeId)).size;
  return { tasks, deduped: count("dedup"), overlaps: count("overlap"), repairs: count("repair"), notes: count("note") };
}
