// The shared brain, behind an adapter. The interface stays swappable; oracle-lite is one impl. The
// values layer surfaces here as optional supersede()/count(): the brain is append-only, so obsolete
// findings are superseded (flagged), never deleted. NullMemoryAdapter is the no-shared-memory control.
import { log } from "./log";
import type { ClaimResult } from "./claim";

export interface Triplet {
  subject: string;
  predicate: string;
  object: string;
}

export interface GraphEdge extends Triplet {
  docId?: string; // the finding this edge came from
}

export interface SearchHit {
  id: string;
  content: string;
  score?: number;
  source?: string;
  type?: string;
  supersededBy?: string; // set when this finding has been superseded by a newer one (still searchable)
  validAt?: string; // U6: when the fact became true in the world (defaults to creation when unset)
  // explain=1: why this hit was retrieved — per-list ranks, RRF base, and each boost component.
  why?: { ftsRank: number | null; vecRank: number | null; rrf: number; recency: number; usage: number; trust: number; multiplier: number; outdated: boolean; asOf: string | null };
}

// One narrated moment on the activity timeline. `human` is the concise line a person reads; nodeId +
// parentNode carry the DAG so the causal tree reconstructs without agent bookkeeping. seq/ts are server-set.
export interface TimelineEvent {
  seq?: number;
  runId?: string;
  project?: string;
  kind: string; // phase | intent | note | finding | dedup | overlap | repair
  actor: string;
  human: string;
  nodeId?: string;
  parentNode?: string[];
  refs?: string[];
  ts?: string;
}

export interface MemoryAdapter {
  // asOf (ISO): U6 temporal retrieval — "what was TRUE at time T" (valid-time; superseded docs never qualify).
  search(query: string, opts?: { limit?: number; project?: string; asOf?: string }): Promise<SearchHit[]>;
  learn(pattern: string, opts?: { concepts?: string[]; project?: string; source?: string; tier?: "raw" | "distilled"; pinned?: boolean; validAt?: string }): Promise<{ id: string }>;
  listDocs?(opts?: { tier?: string; project?: string; max?: number }): Promise<{ id: string; content: string; tier?: string }[]>;
  supersede?(oldId: string, newId: string, reason?: string): Promise<void>;
  // U6: the world changed — the fact WAS true until invalidAt (default now). Distinct from supersede (= we
  // were wrong). The doc stays searchable; ranking sinks it; as_of queries before invalidAt still see it.
  invalidate?(oldId: string, opts?: { newId?: string; reason?: string; invalidAt?: string }): Promise<void>;
  relate?(docId: string, project: string, triplets: Triplet[]): Promise<void>; // store graph edges for a finding
  graph?(entity: string, project?: string): Promise<{ edges: GraphEdge[]; entities: string[] }>; // 1-hop neighborhood
  count?(): Promise<number>;
  reset?(): Promise<void>;
  // Concurrent-dedup claim, resolved by the shared brain so it holds across processes and agent runtimes.
  claim?(scope: string, target: string, by: string): Promise<ClaimResult>;
  claimReset?(scope: string): Promise<void>;
  // U3 usage feedback: a worker CITES a finding that materially helped — bumps its usage ranking boost.
  cite?(id: string): Promise<void>;
  // Activity timeline (append-only): record one narrated event; replay a run's events in order.
  recordEvent?(e: TimelineEvent): Promise<void>;
  timeline?(opts?: { run?: string; project?: string; limit?: number }): Promise<TimelineEvent[]>;
}

export class NullMemoryAdapter implements MemoryAdapter {
  async search(): Promise<SearchHit[]> {
    return [];
  }
  async learn(): Promise<{ id: string }> {
    return { id: "" };
  }
  async supersede(): Promise<void> {
    /* no shared brain: nothing to supersede */
  }
  async relate(): Promise<void> {
    /* no shared brain: no graph */
  }
  async graph(): Promise<{ edges: GraphEdge[]; entities: string[] }> {
    return { edges: [], entities: [] };
  }
  async count(): Promise<number> {
    return 0;
  }
  async reset(): Promise<void> {
    /* nothing to reset */
  }
  async claim(_scope: string, _target: string, by: string): Promise<ClaimResult> {
    return { ok: true, owner: by, fresh: true }; // no shared brain → no coordination; every target is "yours"
  }
  async claimReset(): Promise<void> {
    /* nothing to reset */
  }
  // No recordEvent/timeline here on purpose: the null control has no shared brain, so it has no timeline —
  // and `!adapter.recordEvent` is exactly how the fleet skips emitting for the baseline arm.
  async listDocs(): Promise<{ id: string; content: string; tier?: string }[]> {
    return [];
  }
}

const DEFAULT_ORACLE = process.env.ORACLE_API_URL ?? "http://localhost:47778";
// Production auth: when ORACLE_TOKEN is set (matching the sidecar's), every call carries the bearer.
const AUTH: Record<string, string> = process.env.ORACLE_TOKEN ? { authorization: `Bearer ${process.env.ORACLE_TOKEN}` } : {};

export class OracleAdapter implements MemoryAdapter {
  private readonly searchPath = process.env.ORACLE_SEARCH_PATH ?? "/api/search";
  private readonly learnPath = process.env.ORACLE_LEARN_PATH ?? "/api/learn";
  constructor(private readonly baseUrl: string = DEFAULT_ORACLE) {}

  async search(query: string, opts: { limit?: number; project?: string; asOf?: string; explain?: boolean } = {}): Promise<SearchHit[]> {
    const u = new URL(this.searchPath, this.baseUrl);
    u.searchParams.set("q", query);
    u.searchParams.set("mode", "hybrid");
    u.searchParams.set("limit", String(opts.limit ?? 5));
    if (opts.project) u.searchParams.set("project", opts.project);
    if (opts.asOf) u.searchParams.set("as_of", opts.asOf);
    if (opts.explain) u.searchParams.set("explain", "1");
    const res = await log.time("oracle.search", opts.project, () => fetch(u, { headers: AUTH, signal: AbortSignal.timeout(15_000) }));
    if (!res.ok) throw new Error(`oracle search ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { results?: any[] };
    return (body.results ?? []).map((r) => ({
      id: String(r.id ?? ""),
      content: String(r.content ?? ""),
      score: r.score,
      source: r.source,
      type: r.type,
      supersededBy: r.superseded_by ?? undefined,
      validAt: r.valid_at ?? undefined,
      why: r.why,
    }));
  }

  async learn(
    pattern: string,
    opts: { concepts?: string[]; project?: string; source?: string; tier?: "raw" | "distilled"; pinned?: boolean; validAt?: string } = {},
  ): Promise<{ id: string }> {
    const res = await log.time("oracle.learn", opts.project, () =>
      fetch(new URL(this.learnPath, this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({ pattern, concepts: opts.concepts, project: opts.project, source: opts.source ?? "auralis", tier: opts.tier, pinned: opts.pinned, validAt: opts.validAt }),
        signal: AbortSignal.timeout(30_000),
      }),
    );
    if (!res.ok) throw new Error(`oracle learn ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { id?: string };
    return { id: String(body.id ?? "") };
  }

  async supersede(oldId: string, newId: string, reason?: string): Promise<void> {
    const res = await fetch(new URL("/api/supersede", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ oldId, newId, reason }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`oracle supersede ${res.status}: ${await res.text()}`);
  }

  // U6: mark a fact as no-longer-true-in-the-world (validity ends at invalidAt; default now).
  async invalidate(oldId: string, opts: { newId?: string; reason?: string; invalidAt?: string } = {}): Promise<void> {
    const res = await fetch(new URL("/api/invalidate", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ oldId, newId: opts.newId, reason: opts.reason, invalidAt: opts.invalidAt }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`oracle invalidate ${res.status}: ${await res.text()}`);
  }

  async relate(docId: string, project: string, triplets: Triplet[]): Promise<void> {
    const res = await fetch(new URL("/api/relate", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ docId, project, triplets }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`oracle relate ${res.status}: ${await res.text()}`);
  }

  async graph(entity: string, project?: string): Promise<{ edges: GraphEdge[]; entities: string[] }> {
    const u = new URL("/api/graph", this.baseUrl);
    u.searchParams.set("entity", entity);
    if (project) u.searchParams.set("project", project);
    const res = await fetch(u, { headers: AUTH, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`oracle graph ${res.status}`);
    const body = (await res.json()) as { edges?: any[]; entities?: string[] };
    return {
      edges: (body.edges ?? []).map((e) => ({ subject: String(e.subject), predicate: String(e.predicate), object: String(e.object), docId: e.docId ? String(e.docId) : undefined })),
      entities: body.entities ?? [],
    };
  }

  async count(): Promise<number> {
    const res = await fetch(new URL("/api/stats", this.baseUrl), { headers: AUTH, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`oracle stats ${res.status}`);
    const body = (await res.json()) as { count?: number };
    return Number(body.count ?? 0);
  }

  async listDocs(opts: { tier?: string; project?: string; max?: number } = {}): Promise<{ id: string; content: string; tier?: string }[]> {
    const u = new URL("/api/docs", this.baseUrl);
    if (opts.tier) u.searchParams.set("tier", opts.tier);
    if (opts.project) u.searchParams.set("project", opts.project);
    u.searchParams.set("max", String(opts.max ?? 200));
    const res = await fetch(u, { headers: AUTH, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`oracle docs ${res.status}`);
    const body = (await res.json()) as { docs?: any[] };
    return (body.docs ?? []).map((d) => ({ id: String(d.id), content: String(d.content), tier: d.tier }));
  }

  // Bench-only: clear the brain between trials (requires the server to run with ORACLE_ALLOW_RESET).
  async reset(): Promise<void> {
    const res = await fetch(new URL("/api/reset", this.baseUrl), { method: "POST", headers: AUTH, signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`oracle reset ${res.status} (is ORACLE_ALLOW_RESET set on the sidecar?)`);
  }

  // Concurrent-dedup claim, resolved server-side so it is shared across processes and agent runtimes.
  async claim(scope: string, target: string, by: string): Promise<ClaimResult> {
    const res = await log.time("oracle.claim", scope, () =>
      fetch(new URL("/api/claim", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", ...AUTH },
        body: JSON.stringify({ scope, target, by }),
        signal: AbortSignal.timeout(5_000),
      }),
    );
    if (!res.ok) throw new Error(`oracle claim ${res.status}`);
    return (await res.json()) as ClaimResult;
  }

  async claimReset(scope: string): Promise<void> {
    const res = await fetch(new URL("/api/claim/reset", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ scope }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`oracle claim/reset ${res.status}`);
  }

  // U3: credit a finding that materially helped (bumps times_used → the usage ranking boost).
  async cite(id: string): Promise<void> {
    const res = await fetch(new URL("/api/cite", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`oracle cite ${res.status}`);
  }

  // Append one timeline event. Throws on failure like the other adapter calls; the emit helper
  // (src/narrate.ts) is the layer that swallows it so a run never blocks or breaks on the timeline.
  async recordEvent(e: TimelineEvent): Promise<void> {
    const res = await fetch(new URL("/api/event", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", ...AUTH },
      body: JSON.stringify({ runId: e.runId, project: e.project, kind: e.kind, actor: e.actor, human: e.human, nodeId: e.nodeId, parentNode: e.parentNode, refs: e.refs }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`oracle event ${res.status}`);
  }

  async timeline(opts: { run?: string; project?: string; limit?: number } = {}): Promise<TimelineEvent[]> {
    const u = new URL("/api/timeline", this.baseUrl);
    if (opts.run) u.searchParams.set("run", opts.run);
    if (opts.project) u.searchParams.set("project", opts.project);
    if (opts.limit) u.searchParams.set("limit", String(opts.limit));
    const res = await fetch(u, { headers: AUTH, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`oracle timeline ${res.status}`);
    const body = (await res.json()) as { events?: TimelineEvent[] };
    return body.events ?? [];
  }
}

export async function oracleReachable(baseUrl: string = DEFAULT_ORACLE): Promise<boolean> {
  try {
    const res = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}
