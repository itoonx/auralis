// Thin client over the oracle-lite brain. In dev, Vite proxies /api -> :47778 (see vite.config.ts), so
// every call is same-origin. Mirrors the server shapes in ../../../oracle-lite/server.ts (kept in sync by
// hand — the dashboard is a separate package, so there's no shared type import).

export interface TimelineEvent {
  seq: number; // server-assigned (AUTOINCREMENT pk) — always present, and the timeline's stable list key
  runId?: string;
  project?: string;
  kind: string; // phase | intent | note | finding | dedup | overlap | repair | prompt | trace | answer
  actor: string;
  human: string;
  nodeId?: string;
  parentNode?: string[];
  refs?: string[];
  ts?: string;
}

export interface Stats {
  count: number;
  edges: number;
  nodes: number;
  cited?: number; // explicit "this helped" credits (usage-health dial, P1)
  seen?: number; // recall servings
  vectors: boolean;
  embedder: string;
}

export interface Finding {
  id: string;
  content: string;
  tier?: string;
  source?: string;
  trust?: number;
  pinned?: boolean;
  archived?: boolean;
  timesUsed?: number;
  retrieved?: number;
  createdAt?: string;
}

// Every request gets a hard timeout so a wedged oracle can't hang a panel forever, plus the caller's
// abort signal so switching project/run cancels the stale fetch instead of racing it.
async function json<T>(url: string, signal?: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(8_000);
  let r: Response;
  try {
    r = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  } catch (e) {
    if ((e as DOMException).name === "TimeoutError") throw new Error("timeout after 8s");
    throw e;
  }
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export const getStats = (project?: string, signal?: AbortSignal) =>
  json<Stats>(project ? `/api/stats?project=${encodeURIComponent(project)}` : "/api/stats", signal);

export interface ProjectInfo {
  project: string;
  docs: number;
  events: number;
  lastTs: string;
}
// Projects that actually have data — the picker uses this so the default view isn't the (usually empty)
// "default" project. Ordered most-recent-first by the server.
export const getProjects = (signal?: AbortSignal) => json<{ projects: ProjectInfo[] }>("/api/projects", signal);

export const getTimeline = (project: string, run?: string, signal?: AbortSignal) => {
  const u = new URLSearchParams({ project, limit: "500" });
  if (run) u.set("run", run);
  return json<{ run: string; events: TimelineEvent[] }>(`/api/timeline?${u}`, signal);
};

export const getDocs = (project: string, signal?: AbortSignal) =>
  json<{ docs: Finding[] }>(`/api/docs?project=${encodeURIComponent(project)}&max=50`, signal);

// Same scorecard the CLI reader computes — evidence, not just a log. Kept local to the dashboard package.
export interface Scorecard {
  tasks: number;
  deduped: number;
  overlaps: number;
  repairs: number;
  notes: number;
}
export function scorecard(events: TimelineEvent[]): Scorecard {
  const c = (k: string) => events.filter((e) => e.kind === k).length;
  const tasks = new Set(events.filter((e) => e.nodeId).map((e) => e.nodeId)).size;
  return { tasks, deduped: c("dedup"), overlaps: c("overlap"), repairs: c("repair"), notes: c("note") };
}

// ---- run history ----
export interface RunSummary {
  runId: string;
  events: number;
  tasks: number;
  firstTs: string;
  lastTs: string;
  lastSeq: number;
  deduped: number;
  overlaps: number;
  repairs: number;
  notes: number;
  // Session-capture runs have prompts/answers instead of fleet counters. Optional: an older server
  // (the one already deployed) doesn't send them — the table renders "—" until it does.
  prompts?: number;
  answers?: number;
}
export const getRuns = (project: string, signal?: AbortSignal) =>
  json<{ runs: RunSummary[] }>(`/api/runs?project=${encodeURIComponent(project)}`, signal);

// ---- timing / bottleneck ----
// NOTE: the timing sink is per oracle *process*, not per run/project — spans carry no run tag. The UI
// must label it that way (it used to pose as project timing behind the project picker).
export interface TimingPhase {
  name: string;
  n: number;
  total: number;
  max: number;
  share: number;
}
export interface Timing {
  wall: number;
  spans: number;
  phases: TimingPhase[];
}
export const getTiming = (signal?: AbortSignal) => json<Timing>("/api/timing", signal);

// ---- knowledge graph ----
export interface GraphEntity {
  key: string;
  label: string;
  degree: number;
}
export interface GraphEdge {
  subject: string;
  predicate: string;
  object: string;
  docId?: string;
}
export const getGraphEntities = (project: string, signal?: AbortSignal) =>
  json<{ entities: GraphEntity[] }>(`/api/graph/entities?project=${encodeURIComponent(project)}`, signal);
export const getGraph = (entity: string, project: string, signal?: AbortSignal) =>
  json<{ entity: string; edges: GraphEdge[]; entities: string[] }>(
    `/api/graph?entity=${encodeURIComponent(entity)}&project=${encodeURIComponent(project)}`,
    signal,
  );

// ---- semantic search ----
export interface SearchResult {
  id: string;
  content: string;
  score?: number;
  source?: string;
  superseded_by?: string;
}
export const search = (q: string, project: string, signal?: AbortSignal) =>
  json<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}&project=${encodeURIComponent(project)}&limit=15`, signal);

// ---- whole graph (force view) ----
export interface GraphAllEdge {
  subject: string;
  predicate: string;
  object: string;
  subj_key: string;
  obj_key: string;
}
// Default cap 400 keeps the simulation fluid; "load all" passes the server max instead. Either way the
// graph header states how much of the whole is on screen (stats knows the true totals).
export const getGraphAll = (project: string, limit = 400, signal?: AbortSignal) =>
  json<{ edges: GraphAllEdge[] }>(`/api/graph/all?project=${encodeURIComponent(project)}&limit=${limit}`, signal);

// ---- honest ADR log ----
export interface Decision {
  id: string;
  content: string;
  createdAt: string;
  supersededBy?: string;
  supersededReason?: string;
}
export const getDecisions = (project: string, signal?: AbortSignal) =>
  json<{ decisions: Decision[] }>(`/api/decisions?project=${encodeURIComponent(project)}`, signal);
