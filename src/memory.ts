// The shared brain, behind an adapter. The Oracle is one implementation; the interface keeps it
// swappable (PRD risk: BUSL-1.1). NullMemoryAdapter is the no-shared-memory control for the experiment.

export interface SearchHit {
  id: string;
  content: string;
  score?: number;
  source?: string;
  type?: string;
}

export interface MemoryAdapter {
  search(query: string, opts?: { limit?: number; project?: string }): Promise<SearchHit[]>;
  learn(pattern: string, opts?: { concepts?: string[]; project?: string; source?: string }): Promise<{ id: string }>;
}

// Baseline: remembers nothing. This is the control run.
export class NullMemoryAdapter implements MemoryAdapter {
  async search(): Promise<SearchHit[]> {
    return [];
  }
  async learn(): Promise<{ id: string }> {
    return { id: "" };
  }
}

const DEFAULT_ORACLE = process.env.ORACLE_API_URL ?? "http://localhost:47778";

// Talks to the arra-oracle HTTP sidecar (REST). The Oracle's FTS write is synchronous server-side,
// so a learn() is immediately visible to a subsequent search() within the session (PRD-verified).
// ponytail: REST paths pinned to the current MCP-proxy mapping (/api/*); if a build exposes /search
// instead, flip ORACLE_SEARCH_PATH / ORACLE_LEARN_PATH.
export class OracleAdapter implements MemoryAdapter {
  private readonly searchPath = process.env.ORACLE_SEARCH_PATH ?? "/api/search";
  private readonly learnPath = process.env.ORACLE_LEARN_PATH ?? "/api/learn";
  constructor(private readonly baseUrl: string = DEFAULT_ORACLE) {}

  async search(query: string, opts: { limit?: number; project?: string } = {}): Promise<SearchHit[]> {
    const u = new URL(this.searchPath, this.baseUrl);
    u.searchParams.set("q", query);
    u.searchParams.set("mode", "hybrid");
    u.searchParams.set("limit", String(opts.limit ?? 5));
    if (opts.project) u.searchParams.set("project", opts.project);
    const res = await fetch(u, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`oracle search ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { results?: any[] };
    return (body.results ?? []).map((r) => ({
      id: String(r.id ?? ""),
      content: String(r.content ?? ""),
      score: r.score,
      source: r.source,
      type: r.type,
    }));
  }

  async learn(
    pattern: string,
    opts: { concepts?: string[]; project?: string; source?: string } = {},
  ): Promise<{ id: string }> {
    const res = await fetch(new URL(this.learnPath, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pattern,
        concepts: opts.concepts,
        project: opts.project,
        source: opts.source ?? "auralis",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`oracle learn ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { id?: string };
    return { id: String(body.id ?? "") };
  }
}

// Is the Oracle sidecar up? Used to gate the live integration test.
export async function oracleReachable(baseUrl: string = DEFAULT_ORACLE): Promise<boolean> {
  try {
    const res = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(2_000) });
    return res.ok;
  } catch {
    return false;
  }
}
