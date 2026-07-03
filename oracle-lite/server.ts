// oracle-lite — our own shared-brain sidecar. Bun + bun:sqlite (FTS5) for keyword search, plus an
// OPTIONAL LanceDB vector index for semantic recall, merged into a hybrid ranking. Embeddings come from
// a Node embed-sidecar when ORACLE_EMBED_URL is set (real sentence-transformer, semantic); otherwise a
// built-in char-trigram embedder (fuzzy). Either way it's best-effort: if the sidecar or LanceDB fails,
// the brain silently falls back, so it always boots. VALUES LAYER: append-only — no delete route;
// obsolescence is SUPERSESSION. FTS writes are synchronous (read-after-write).
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

const PORT = Number(process.env.ORACLE_PORT ?? 47778);
const DB_PATH = process.env.ORACLE_DB ?? ".auralis-out/brain.sqlite";
mkdirSync(DB_PATH.replace(/\/[^/]*$/, "") || ".", { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL;");
if (process.env.ORACLE_RESET) {
  db.run("DROP TABLE IF EXISTS docs;");
  db.run("DROP TABLE IF EXISTS docs_fts;");
  db.run("DROP TABLE IF EXISTS edges;");
}
db.run(`CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, concepts TEXT, project TEXT, source TEXT, created_at TEXT,
  superseded_by TEXT, superseded_at TEXT, superseded_reason TEXT
);`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, content, concepts);`);
try { db.run("ALTER TABLE docs ADD COLUMN tier TEXT DEFAULT 'raw';"); } catch { /* column already exists */ }
// Graph layer: entity/relationship triplets extracted from findings (the 'cognify' step). Additive —
// the brain is a graph AND a flat doc store. subj_key/obj_key are normalized so 'same key = same node'.
db.run(`CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT, predicate TEXT, object TEXT,
  subj_key TEXT, obj_key TEXT, doc_id TEXT, project TEXT, created_at TEXT
);`);

const insDoc = db.query("INSERT INTO docs (id, content, concepts, project, source, created_at, tier) VALUES (?, ?, ?, ?, ?, ?, ?)");
const insFts = db.query("INSERT INTO docs_fts (id, content, concepts) VALUES (?, ?, ?)");
const supersedeStmt = db.query("UPDATE docs SET superseded_by = ?, superseded_at = ?, superseded_reason = ? WHERE id = ?");
const countStmt = db.query("SELECT COUNT(*) AS c FROM docs");
const getDocStmt = db.query("SELECT id, content, source, superseded_by, project FROM docs WHERE id = ?");
const insEdge = db.query("INSERT INTO edges (subject, predicate, object, subj_key, obj_key, doc_id, project, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const edgeCountStmt = db.query("SELECT COUNT(*) AS c FROM edges");
const nodeCountStmt = db.query("SELECT COUNT(*) AS c FROM (SELECT subj_key AS k FROM edges UNION SELECT obj_key FROM edges)");
const searchStmt = db.query(
  `SELECT d.id AS id, d.content AS content, d.source AS source, d.superseded_by AS superseded_by, bm25(docs_fts) AS rank
   FROM docs_fts JOIN docs d ON d.id = docs_fts.id
   WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`,
);

function sanitize(q: string): string {
  const toks = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1);
  const uniq = [...new Set(toks)].slice(0, 8);
  return uniq.length ? uniq.map((t) => `"${t}"`).join(" OR ") : '"_"';
}
function idFrom(content: string): string {
  const slug = content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `learning_${Date.now()}_${slug}`.slice(0, 90);
}
// Entity resolution: normalize an entity name to a node key. ponytail: string match; embeddings later.
function normKey(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

// ---- embeddings: semantic via the Node sidecar (ORACLE_EMBED_URL) with a built-in fallback ----
const EMBED_URL = process.env.ORACLE_EMBED_URL;
let EMBED_DIM = 256; // built-in default; overwritten to the model's dim when semantic is on
let embedder: "semantic" | "builtin" = "builtin";

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function builtinEmbed(text: string, dim: number): number[] {
  const v = new Float32Array(dim);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1);
  for (const w of words) {
    v[hashStr(w) % dim] += 1;
    const p = `#${w}#`;
    for (let i = 0; i + 3 <= p.length; i++) v[hashStr(p.slice(i, i + 3)) % dim] += 1;
  }
  let n = 0;
  for (let i = 0; i < dim; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}
async function semanticEmbed(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${EMBED_URL}/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ texts: [text.slice(0, 2000)] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { embeddings?: number[][] };
    return body.embeddings?.[0] ?? null;
  } catch {
    return null;
  }
}
async function embed(text: string): Promise<number[]> {
  if (embedder === "semantic") {
    const v = await semanticEmbed(text);
    if (v && v.length === EMBED_DIM) return v;
    return builtinEmbed(text, EMBED_DIM); // per-call fallback at the same dim
  }
  return builtinEmbed(text, EMBED_DIM);
}
async function initEmbedder() {
  if (!EMBED_URL) return;
  try {
    const res = await fetch(`${EMBED_URL}/health`, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const b = (await res.json()) as { dim?: number };
      EMBED_DIM = Number(b.dim ?? 384);
      embedder = "semantic";
      console.error(`embedder: semantic (dim ${EMBED_DIM}) via ${EMBED_URL}`);
      return;
    }
  } catch { /* fall through */ }
  console.error("embedder: built-in (embed-sidecar unreachable)");
}

// ---- LanceDB vector layer (best-effort; FTS-only fallback). Dir namespaced by dim so semantic and
// built-in vector spaces never mix. ----
const dbDir = DB_PATH.replace(/[^/]*$/, "") || "./";
const dbBase = (DB_PATH.match(/[^/]*$/)?.[0] ?? "brain").replace(/\.[^.]*$/, "");
let LANCE_DIR = "";
let vdb: any = null;
let vtable: any = null;
let vectorsOn = false;

async function initVectors() {
  if (process.env.ORACLE_NO_VECTORS) { console.error("vectors: disabled (ORACLE_NO_VECTORS)"); return; }
  LANCE_DIR = process.env.ORACLE_LANCEDB ?? `${dbDir}lancedb-${dbBase}-d${EMBED_DIM}`;
  try {
    const lancedb: any = await import("@lancedb/lancedb");
    vdb = await lancedb.connect(LANCE_DIR);
    if (process.env.ORACLE_RESET) { try { await vdb.dropTable("docs"); } catch { /* no table yet */ } }
    const names: string[] = await vdb.tableNames();
    if (names.includes("docs")) vtable = await vdb.openTable("docs");
    vectorsOn = true;
    console.error(`vectors: LanceDB ON (${LANCE_DIR}, ${embedder})`);
  } catch (e) {
    vectorsOn = false;
    console.error("vectors: OFF, FTS-only fallback —", String(e).slice(0, 120));
  }
}
async function vectorAdd(id: string, content: string) {
  if (!vectorsOn) return;
  try {
    const row = { id, vector: await embed(content), content: content.slice(0, 2000) };
    if (!vtable) vtable = await vdb.createTable("docs", [row]);
    else await vtable.add([row]);
  } catch (e) { console.error("vector add failed, disabling vectors:", String(e).slice(0, 100)); vectorsOn = false; }
}
async function vectorQuery(text: string, k: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!vectorsOn || !vtable) return out;
  try {
    const rows: any[] = await vtable.search(await embed(text)).limit(k).toArray();
    for (const r of rows) {
      const d = typeof r._distance === "number" ? r._distance : 1;
      out.set(String(r.id), 1 / (1 + d));
    }
  } catch (e) { console.error("vector query failed:", String(e).slice(0, 100)); }
  return out;
}
async function vectorReset() {
  if (!vectorsOn || !vdb) return;
  try { await vdb.dropTable("docs"); vtable = null; } catch { /* ignore */ }
}

await initEmbedder();
await initVectors();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true, vectors: vectorsOn, embedder });
    if (url.pathname === "/api/stats") {
      const row = countStmt.get() as { c: number };
      const e = edgeCountStmt.get() as { c: number };
      const n = nodeCountStmt.get() as { c: number };
      return Response.json({ count: row.c, edges: e.c, nodes: n.c, vectors: vectorsOn, embedder });
    }

    if (req.method === "POST" && url.pathname === "/api/learn") {
      const body = (await req.json().catch(() => ({}))) as any;
      const pattern = String(body?.pattern ?? "").trim();
      if (!pattern) return Response.json({ error: "pattern is required" }, { status: 400 });
      const id = idFrom(pattern);
      const concepts = Array.isArray(body?.concepts) ? body.concepts.join(" ") : "";
      insDoc.run(id, pattern, concepts, body?.project ?? null, body?.source ?? "auralis", new Date().toISOString(), body?.tier === "distilled" ? "distilled" : "raw");
      insFts.run(id, pattern, concepts); // synchronous -> immediately searchable
      await vectorAdd(id, pattern);
      return Response.json({ success: true, id, embedding: vectorsOn ? embedder : "fts-only" });
    }

    // Graph edges from a finding (posted by the cognify step, separate from learn so slow/optional
    // extraction never blocks learn's synchronous read-after-write).
    if (req.method === "POST" && url.pathname === "/api/relate") {
      const body = (await req.json().catch(() => ({}))) as any;
      const docId = String(body?.docId ?? "");
      const project = body?.project ?? null;
      const triplets = Array.isArray(body?.triplets) ? body.triplets : [];
      const now = new Date().toISOString();
      let added = 0;
      for (const t of triplets) {
        const subj = String(t?.subject ?? "").trim();
        const obj = String(t?.object ?? "").trim();
        const pred = String(t?.predicate ?? "relates-to").trim() || "relates-to";
        if (!subj || !obj) continue;
        insEdge.run(subj, pred, obj, normKey(subj), normKey(obj), docId, project, now);
        added++;
      }
      return Response.json({ success: true, added });
    }

    if (req.method === "POST" && url.pathname === "/api/supersede") {
      const body = (await req.json().catch(() => ({}))) as any;
      const oldId = String(body?.oldId ?? "");
      const newId = String(body?.newId ?? "");
      if (!oldId || !newId) return Response.json({ error: "oldId and newId are required" }, { status: 400 });
      supersedeStmt.run(newId, new Date().toISOString(), body?.reason ?? null, oldId);
      return Response.json({ success: true, oldId, newId });
    }

    // Bench-only, gated behind ORACLE_ALLOW_RESET (off in normal use → no-delete guarantee unchanged).
    if (req.method === "POST" && url.pathname === "/api/reset" && process.env.ORACLE_ALLOW_RESET) {
      db.run("DELETE FROM docs;");
      db.run("DELETE FROM docs_fts;");
      db.run("DELETE FROM edges;");
      await vectorReset();
      return Response.json({ success: true, reset: true });
    }

    if (req.method === "GET" && url.pathname === "/api/docs") {
      const tier = url.searchParams.get("tier");
      const project = url.searchParams.get("project");
      const max = Math.max(1, Math.min(500, Number(url.searchParams.get("max") ?? 200)));
      let sql = "SELECT id, content, tier FROM docs WHERE superseded_by IS NULL";
      const params: any[] = [];
      if (tier) { sql += " AND tier = ?"; params.push(tier); }
      if (project) { sql += " AND project = ?"; params.push(project); }
      sql += " LIMIT ?"; params.push(max);
      const rows = db.query(sql).all(...params) as any[];
      return Response.json({ docs: rows.map((r) => ({ id: r.id, content: r.content, tier: r.tier ?? "raw" })) });
    }

    // 1-hop neighborhood of an entity: every edge touching its normalized key + connected entities.
    if (req.method === "GET" && url.pathname === "/api/graph") {
      const entity = url.searchParams.get("entity") ?? "";
      const project = url.searchParams.get("project");
      const key = normKey(entity);
      let sql = "SELECT subject, predicate, object, doc_id FROM edges WHERE (subj_key = ? OR obj_key = ?)";
      const params: any[] = [key, key];
      if (project) { sql += " AND project = ?"; params.push(project); }
      sql += " ORDER BY id";
      const rows = db.query(sql).all(...params) as any[];
      const edges = rows.map((r) => ({ subject: r.subject, predicate: r.predicate, object: r.object, docId: r.doc_id }));
      const entities = [...new Set(edges.flatMap((e) => [e.subject, e.object]))];
      return Response.json({ entity, edges, entities });
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 5)));
      const mode = url.searchParams.get("mode") ?? "hybrid";
      const project = url.searchParams.get("project"); // recall must not leak across projects

      const ftsRows =
        mode === "vector"
          ? []
          : ((project
              ? db
                  .query(
                    `SELECT d.id AS id, d.content AS content, d.source AS source, d.superseded_by AS superseded_by, bm25(docs_fts) AS rank
                     FROM docs_fts JOIN docs d ON d.id = docs_fts.id
                     WHERE docs_fts MATCH ? AND d.project = ? ORDER BY rank LIMIT ?`,
                  )
                  .all(sanitize(q), project, limit * 3)
              : searchStmt.all(sanitize(q), limit * 3)) as any[]);
      const vScores = mode === "fts" ? new Map<string, number>() : await vectorQuery(q, limit * 3);

      const merged = new Map<string, { id: string; content: string; source: string; superseded_by: any; score: number }>();
      for (const r of ftsRows) {
        const ftsScore = 1 / (1 + Math.max(0, Number(r.rank)));
        const v = vScores.get(String(r.id)) ?? 0;
        const score = (0.5 * ftsScore + 0.5 * v) * (v > 0 ? 1.1 : 1) * (r.superseded_by ? 0.3 : 1);
        merged.set(String(r.id), { id: r.id, content: r.content, source: r.source, superseded_by: r.superseded_by, score });
      }
      for (const [id, v] of vScores) {
        if (merged.has(id)) continue;
        const d = getDocStmt.get(id) as any;
        if (!d || (project && d.project !== project)) continue;
        merged.set(id, { id, content: d.content, source: d.source ?? "vector", superseded_by: d.superseded_by, score: 0.5 * v * (d.superseded_by ? 0.3 : 1) });
      }

      const results = [...merged.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          content: String(r.content).slice(0, 2000),
          type: "learning",
          source: r.source ?? "fts",
          superseded_by: r.superseded_by ?? undefined,
          score: r.score,
        }));
      return Response.json({ results, total: results.length, query: q, mode, vectors: vectorsOn, embedder });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`oracle-lite (FTS5${vectorsOn ? ` + LanceDB vectors/${embedder}` : ", FTS-only"}) on http://localhost:${server.port}  db=${DB_PATH}`);
