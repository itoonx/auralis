// oracle-lite — our own minimal shared-brain sidecar (PRD: memory lives behind a swappable adapter;
// this is the re-implemented layer so auralis runs end-to-end without the external BUSL-1.1 Oracle).
// Bun + bun:sqlite (FTS5). Append-only (no update/delete path). The FTS row is committed synchronously
// inside /api/learn, so a subsequent /api/search sees it immediately — the read-after-write guarantee.
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
  id TEXT PRIMARY KEY, content TEXT NOT NULL, concepts TEXT, project TEXT, source TEXT, created_at TEXT
);`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, content, concepts);`);

const insDoc = db.query(
  "INSERT INTO docs (id, content, concepts, project, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);
const insFts = db.query("INSERT INTO docs_fts (id, content, concepts) VALUES (?, ?, ?)");
const searchStmt = db.query(
  `SELECT d.id AS id, d.content AS content, d.source AS source, bm25(docs_fts) AS rank
   FROM docs_fts JOIN docs d ON d.id = docs_fts.id
   WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`,
);

// Mirror arra-oracle's sanitizeFtsQuery: unicode word tokens, dedup, cap 8, OR-joined — avoids FTS syntax errors.
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

    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") ?? 5)));
      const rows = searchStmt.all(sanitize(q), limit) as any[];
      const results = rows.map((r) => ({
        id: r.id,
        content: String(r.content).slice(0, 2000),
        type: "learning",
        source: r.source ?? "fts",
        score: 1 / (1 + Math.max(0, Number(r.rank))),
      }));
      return Response.json({ results, total: results.length, query: q });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`oracle-lite (bun:sqlite FTS5) listening on http://localhost:${server.port}  db=${DB_PATH}`);
