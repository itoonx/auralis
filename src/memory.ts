// The shared brain, behind an adapter. The interface stays swappable; oracle-lite is one impl. The
// values layer surfaces here as optional supersede()/count(): the brain is append-only, so obsolete
// findings are superseded (flagged), never deleted. NullMemoryAdapter is the no-shared-memory control.

export interface SearchHit {
  id: string;
  content: string;
  score?: number;
  source?: string;
  type?: string;
  supersededBy?: string; // set when this finding has been superseded by a newer one (still searchable)
}

export interface MemoryAdapter {
  search(query: string, opts?: { limit?: number; project?: string }): Promise<SearchHit[]>;
  learn(pattern: string, opts?: { concepts?: string[]; project?: string; source?: string }): Promise<{ id: string }>;
  supersede?(oldId: string, newId: string, reason?: string): Promise<void>;
  count?(): Promise<number>;
  reset?(): Promise<void>;
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
  async count(): Promise<number> {
    return 0;
  }
  async reset(): Promise<void> {
    /* nothing to reset */
  }
}

const DEFAULT_ORACLE = process.env.ORACLE_API_URL ?? "http://localhost:47778";

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
      supersededBy: r.superseded_by ?? undefined,
    }));
  }

  async learn(
    pattern: string,
    opts: { concepts?: string[]; project?: string; source?: string } = {},
  ): Promise<{ id: string }> {
    const res = await fetch(new URL(this.learnPath, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pattern, concepts: opts.concepts, project: opts.project, source: opts.source ?? "auralis" }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`oracle learn ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { id?: string };
    return { id: String(body.id ?? "") };
  }

  async supersede(oldId: string, newId: string, reason?: string): Promise<void> {
    const res = await fetch(new URL("/api/supersede", this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ oldId, newId, reason }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`oracle supersede ${res.status}: ${await res.text()}`);
  }

  async count(): Promise<number> {
    const res = await fetch(new URL("/api/stats", this.baseUrl), { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`oracle stats ${res.status}`);
    const body = (await res.json()) as { count?: number };
    return Number(body.count ?? 0);
  }

  // Bench-only: clear the brain between trials (requires the server to run with ORACLE_ALLOW_RESET).
  async reset(): Promise<void> {
    const res = await fetch(new URL("/api/reset", this.baseUrl), { method: "POST", signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`oracle reset ${res.status} (is ORACLE_ALLOW_RESET set on the sidecar?)`);
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
