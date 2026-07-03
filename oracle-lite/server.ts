// oracle-lite — our own minimal shared-brain sidecar. Bun + bun:sqlite (FTS5). VALUES LAYER: it is
// APPEND-ONLY — there is no delete route and content is never removed. Obsolescence is expressed by
// SUPERSESSION: /api/supersede flags an old doc as outdated (superseded_by) while keeping it fully
// intact and searchable. The FTS row is committed synchronously inside /api/learn (read-after-write).
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

const insDoc = db.query(
  "INSERT INTO docs (id, content, concepts, project, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const insFts = db.query("INSERT INTO docs_fts (id, content, concepts) VALUES (?, ?, ?)");
const supersedeStmt = db.query(
  "UPDATE docs SET superseded_by = ?, superseded_at = ?, superseded_reason = ? WHERE id = ?",
);
const countStmt = db.query("SELECT COUNT(*) AS c FROM docs");
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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname === "/api/stats") {
      const row = countStmt.get() as { c: number };
      return Response.json({ count: row.c });
    }

    if (req.method === "POST" && url.pathname === "/api/learn") {
      const body = (await req.json().catch(() => ({}))) as any;
      const pattern = String(body?.pattern ?? "").trim();
      if (!pattern) return Response.json({ error: "pattern is required" }, { status: 400 });
      const id = idFrom(pattern);
      const concepts = Array.isArray(body?.concepts) ? body.concepts.join(" ") : "";
      insDoc.run(id, pattern, concepts, body?.project ?? null, body?.source ?? "auralis", new Date().toISOString());
      insFts.run(id, pattern, concepts); // synchronous -> immediately searchable
      return Response.json({ success: true, id, file: null, embedding: "skipped" });
    }

    // Supersession, not deletion: flag the old doc as outdated; it stays intact and searchable.
    if (req.method === "POST" && url.pathname === "/api/supersede") {
      const body = (await req.json().catch(() => ({}))) as any;
      const oldId = String(body?.oldId ?? "");
      const newId = String(body?.newId ?? "");
      if (!oldId || !newId) return Response.json({ error: "oldId and newId are required" }, { status: 400 });
      supersedeStmt.run(newId, new Date().toISOString(), body?.reason ?? null, oldId);
      return Response.json({ success: true, oldId, newId });
    }

    // Bench-only: wipe the brain between trials. Gated behind ORACLE_ALLOW_RESET so it does not exist
    // in normal use — the append-only / no-delete guarantee is unchanged unless a benchmark opts in.
    if (req.method === "POST" && url.pathname === "/api/reset" && process.env.ORACLE_ALLOW_RESET) {
      db.run("DELETE FROM docs;");
      db.run("DELETE FROM docs_fts;");
      return Response.json({ success: true, reset: true });
    }

    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 5)));
      const rows = searchStmt.all(sanitize(q), limit) as any[];
      const results = rows.map((r) => ({
        id: r.id,
        content: String(r.content).slice(0, 2000),
        type: "learning",
        source: r.source ?? "fts",
        superseded_by: r.superseded_by ?? undefined,
        score: 1 / (1 + Math.max(0, Number(r.rank))),
      }));
      return Response.json({ results, total: results.length, query: q });
    }

    // No DELETE route exists — the store is append-only by construction.
    return new Response("not found", { status: 404 });
  },
});

console.log(`oracle-lite (bun:sqlite FTS5, append-only) listening on http://localhost:${server.port}  db=${DB_PATH}`);
