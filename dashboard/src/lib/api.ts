// Thin client over the oracle-lite brain. In dev, Vite proxies /api -> :47778 (see vite.config.ts), so
// every call is same-origin. Mirrors the server shapes in ../../src/memory.ts (kept in sync by hand — the
// dashboard is a separate package, so there's no shared type import).

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

async function json<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json() as Promise<T>;
}

export const getStats = (project?: string) =>
  json<Stats>(project ? `/api/stats?project=${encodeURIComponent(project)}` : "/api/stats");

export interface ProjectInfo {
  project: string;
  docs: number;
  events: number;
  lastTs: string;
}
// Projects that actually have data — the picker uses this so the default view isn't the (usually empty)
// "default" project. Ordered most-recent-first by the server.
export const getProjects = () => json<{ projects: ProjectInfo[] }>("/api/projects");

export const getTimeline = (project: string, run?: string) => {
  const u = new URLSearchParams({ project, limit: "500" });
  if (run) u.set("run", run);
  return json<{ run: string; events: TimelineEvent[] }>(`/api/timeline?${u}`);
};

export const getDocs = (project: string) =>
  json<{ docs: Finding[] }>(`/api/docs?project=${encodeURIComponent(project)}&max=50`);

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
}
export const getRuns = (project: string) => json<{ runs: RunSummary[] }>(`/api/runs?project=${encodeURIComponent(project)}`);

// ---- timing / bottleneck ----
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
export const getTiming = () => json<Timing>("/api/timing");

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
export const getGraphEntities = (project: string) =>
  json<{ entities: GraphEntity[] }>(`/api/graph/entities?project=${encodeURIComponent(project)}`);
export const getGraph = (entity: string, project: string) =>
  json<{ entity: string; edges: GraphEdge[]; entities: string[] }>(
    `/api/graph?entity=${encodeURIComponent(entity)}&project=${encodeURIComponent(project)}`,
  );

// ---- semantic search ----
export interface SearchResult {
  id: string;
  content: string;
  score?: number;
  source?: string;
  superseded_by?: string;
}
export const search = (q: string, project: string) =>
  json<{ results: SearchResult[] }>(`/api/search?q=${encodeURIComponent(q)}&project=${encodeURIComponent(project)}&limit=15`);

// ---- whole graph (force view) ----
export interface GraphAllEdge {
  subject: string;
  predicate: string;
  object: string;
  subj_key: string;
  obj_key: string;
}
export const getGraphAll = (project: string) =>
  json<{ edges: GraphAllEdge[] }>(`/api/graph/all?project=${encodeURIComponent(project)}&limit=400`);

// ---- honest ADR log ----
export interface Decision {
  id: string;
  content: string;
  createdAt: string;
  supersededBy?: string;
  supersededReason?: string;
}
export const getDecisions = (project: string) =>
  json<{ decisions: Decision[] }>(`/api/decisions?project=${encodeURIComponent(project)}`);
