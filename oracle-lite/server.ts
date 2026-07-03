// oracle-lite — our own shared-brain sidecar. Bun + bun:sqlite (FTS5) for keyword search, plus an
// OPTIONAL LanceDB vector index for semantic-ish recall, merged into a hybrid ranking. Everything
// vector-related is best-effort: if LanceDB or embedding fails, the brain silently falls back to
// FTS-only, so it always boots. VALUES LAYER: append-only — no delete route; obsolescence is expressed
// by SUPERSESSION. FTS writes are synchronous (read-after-write).
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
}
db.run(`CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, concepts TEXT, project TEXT, source TEXT, created_at TEXT,
  superseded_by TEXT, superseded_at TEXT, superseded_reason TEXT
);`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, content, concepts);`);

const insDoc = db.query("INSERT INTO docs (id, content, concepts, project, source, created_at) VALUES (?, ?, ?, ?, ?, ?)");
const insFts = db.query("INSERT INTO docs_fts (id, content, concepts) VALUES (?, ?, ?)");
const supersedeStmt = db.query("UPDATE docs SET superseded_by = ?, superseded_at = ?, superseded_reason = ? WHERE id = ?");
const countStmt = db.query("SELECT COUNT(*) AS c FROM docs");
const getDocStmt = db.query("SELECT id, content, source, superseded_by FROM docs WHERE id = ?");
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

// ---- built-in embedder: char-trigram + word feature-hashing → L2-normalized vector (no deps, no
// downloads, works under Bun). Not deep-semantic, but catches subword/fuzzy matches FTS misses; swap
// for a real model behind this function when one is available. ----
const DIM = 256;
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function embed(text: string): number[] {
  const v = new Float32Array(DIM);
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length > 1);
  for (const w of words) {
    v[hashStr(w) % DIM] += 1;
    const p = `#${w}#`;
    for (let i = 0; i + 3 <= p.length; i++) v[hashStr(p.slice(i, i + 3)) % DIM] += 1;
  }
  let n = 0;
  for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

// ---- LanceDB vector layer (best-effort; FTS-only fallback) ----
const dbDir = DB_PATH.replace(/[^/]*$/, "") || "./";
const dbBase = (DB_PATH.match(/[^/]*$/)?.[0] ?? "brain").replace(/\.[^.]*$/, "");
const LANCE_DIR = process.env.ORACLE_LANCEDB ?? `${dbDir}lancedb-${dbBase}`;
let vdb: any = null;
let vtable: any = null;
let vectorsOn = false;

async function initVectors() {
  if (process.env.ORACLE_NO_VECTORS) { console.error("vectors: disabled (ORACLE_NO_VECTORS)"); return; }
  try {
    const lancedb: any = await import("@lancedb/lancedb");
    vdb = await lancedb.connect(LANCE_DIR);
    if (process.env.ORACLE_RESET) { try { await vdb.dropTable("docs"); } catch { /* no table yet */ } }
    const names: string[] = await vdb.tableNames();
    if (names.includes("docs")) vtable = await vdb.openTable("docs");
    vectorsOn = true;
    console.error(`vectors: LanceDB ON (${LANCE_DIR})`);
  } catch (e) {
    vectorsOn = false;
    console.error("vectors: OFF, FTS-only fallback —", String(e).slice(0, 120));
  }
}
async function vectorAdd(id: string, content: string) {
  if (!vectorsOn) return;
  try {
    const row = { id, vector: embed(content), content: content.slice(0, 2000) };
    if (!vtable) vtable = await vdb.createTable("docs", [row]);
    else await vtable.add([row]);
  } catch (e) { console.error("vector add failed, disabling vectors:", String(e).slice(0, 100)); vectorsOn = false; }
}
async function vectorQuery(text: string, k: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!vectorsOn || !vtable) return out;
  try {
    const rows: any[] = await vtable.search(embed(text)).limit(k).toArray();
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

await initVectors();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true, vectors: vectorsOn });

    if (url.pathname === "/api/stats") {
      const row = countStmt.get() as { c: number };
      return Response.json({ count: row.c, vectors: vectorsOn });
    }

    if (req.method === "POST" && url.pathname === "/api/learn") {
      const body = (await req.json().catch(() => ({}))) as any;
      const pattern = String(body?.pattern ?? "").trim();
      if (!pattern) return Response.json({ error: "pattern is required" }, { status: 400 });
      const id = idFrom(pattern);
      const concepts = Array.isArray(body?.concepts) ? body.concepts.join(" ") : "";
      insDoc.run(id, pattern, concepts, body?.project ?? null, body?.source ?? "auralis", new Date().toISOString());
      insFts.run(id, pattern, concepts); // synchronous -> immediately searchable
      await vectorAdd(id, pattern); // best-effort
      return Response.json({ success: true, id, embedding: vectorsOn ? "vector" : "fts-only" });
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
      await vectorReset();
      return Response.json({ success: true, reset: true });
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 5)));
      const mode = url.searchParams.get("mode") ?? "hybrid";

      const ftsRows = mode === "vector" ? [] : (searchStmt.all(sanitize(q), limit * 3) as any[]);
      const vScores = mode === "fts" ? new Map<string, number>() : await vectorQuery(q, limit * 3);

      const merged = new Map<string, { id: string; content: string; source: string; superseded_by: any; score: number }>();
      for (const r of ftsRows) {
        const ftsScore = 1 / (1 + Math.max(0, Number(r.rank)));
        const v = vScores.get(String(r.id)) ?? 0;
        const score = (0.5 * ftsScore + 0.5 * v) * (v > 0 ? 1.1 : 1); // hybrid boost when both agree
        merged.set(String(r.id), { id: r.id, content: r.content, source: r.source, superseded_by: r.superseded_by, score });
      }
      for (const [id, v] of vScores) {
        if (merged.has(id)) continue;
        const d = getDocStmt.get(id) as any;
        if (d) merged.set(id, { id, content: d.content, source: d.source ?? "vector", superseded_by: d.superseded_by, score: 0.5 * v });
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
      return Response.json({ results, total: results.length, query: q, mode, vectors: vectorsOn });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`oracle-lite (bun:sqlite FTS5${vectorsOn ? " + LanceDB vectors" : ", FTS-only"}) on http://localhost:${server.port}  db=${DB_PATH}`);
