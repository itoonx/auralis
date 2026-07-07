// oracle-lite — our own shared-brain sidecar. Bun + bun:sqlite (FTS5) for keyword search, plus an
// OPTIONAL LanceDB vector index for semantic recall, merged into a hybrid ranking. Embeddings come from
// a Node embed-sidecar when ORACLE_EMBED_URL is set (real sentence-transformer, semantic); otherwise a
// built-in char-trigram embedder (fuzzy). Either way it's best-effort: if the sidecar or LanceDB fails,
// the brain silently falls back, so it always boots. VALUES LAYER: append-only — no delete route;
// obsolescence is SUPERSESSION. FTS writes are synchronous (read-after-write).
import { Database } from "bun:sqlite";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolveClaim } from "../src/claim";
import { extractTriplets } from "../src/triplets";
import { rrf, trustOf, boost, boostParts, daysBetween, strength, pinnedOf, ARCHIVE_FLOOR } from "./rank";

const PORT = Number(process.env.ORACLE_PORT ?? 47778);
const DB_PATH = process.env.ORACLE_DB ?? ".auralis-out/brain.sqlite";
// The fleet's centralized timing sink (src/log.ts). Read-only here so the dashboard can show where wall
// time goes; truncated per run by log.reset, so this file is the latest run's spans.
const TIMING_PATH = process.env.ORACLE_TIMING ?? ".auralis-out/timing.jsonl";
mkdirSync(DB_PATH.replace(/\/[^/]*$/, "") || ".", { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.run("PRAGMA journal_mode = WAL;");
if (process.env.ORACLE_RESET) {
  db.run("DROP TABLE IF EXISTS docs;");
  db.run("DROP TABLE IF EXISTS docs_fts;");
  db.run("DROP TABLE IF EXISTS edges;");
  db.run("DROP TABLE IF EXISTS events;");
}
db.run(`CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, concepts TEXT, project TEXT, source TEXT, created_at TEXT,
  superseded_by TEXT, superseded_at TEXT, superseded_reason TEXT
);`);
db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(id UNINDEXED, content, concepts);`);
try { db.run("ALTER TABLE docs ADD COLUMN tier TEXT DEFAULT 'raw';"); } catch { /* column already exists */ }
// Ranking v2 columns (U1+U2, docs/research-memory-os.md): trust prior set at learn from the source;
// access/usage counters power the recency+usage boosts. Additive — an existing brain upgrades in place.
try { db.run("ALTER TABLE docs ADD COLUMN trust REAL DEFAULT 0.5;"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE docs ADD COLUMN last_accessed_at TEXT;"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE docs ADD COLUMN times_used INTEGER DEFAULT 0;"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE docs ADD COLUMN retrieved_count INTEGER DEFAULT 0;"); } catch { /* column already exists */ }
// U4 forgetting-as-ranking: archived = strength fell below the floor (hidden from default search, never
// deleted); pinned = decisions/retros/human-stated — exempt from archiving, forever.
try { db.run("ALTER TABLE docs ADD COLUMN archived INTEGER DEFAULT 0;"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE docs ADD COLUMN pinned INTEGER DEFAULT 0;"); } catch { /* column already exists */ }
// U6 bi-temporal: two DIFFERENT ways a doc stops being current, kept distinct on purpose —
//   superseded_*  = we were WRONG (the fact never held; the correction replaces it),
//   invalid_*     = the WORLD CHANGED (the fact was true from valid_at until invalid_at).
// valid_at NULL means "true since created_at". Nothing is deleted either way; ranking sinks both.
try { db.run("ALTER TABLE docs ADD COLUMN valid_at TEXT;"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE docs ADD COLUMN invalid_at TEXT;"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE docs ADD COLUMN invalidated_by TEXT;"); } catch { /* column already exists */ }
try { db.run("ALTER TABLE docs ADD COLUMN invalidated_reason TEXT;"); } catch { /* column already exists */ }
// Backfill for brains that predate the trust/pinned columns: the ALTER default (0.5/0) can't know the
// source, so retros/decisions/humans in an upgraded brain would rank and archive as ordinary worker
// findings. Recompute the priors for rows still at the default — idempotent, respects later overrides.
db.run("UPDATE docs SET trust = 1.0,  pinned = 1 WHERE trust = 0.5 AND pinned = 0 AND source LIKE 'human%';");
db.run("UPDATE docs SET trust = 0.85, pinned = 1 WHERE trust = 0.5 AND pinned = 0 AND source = 'auralis:retro';");
db.run("UPDATE docs SET trust = 0.7,  pinned = 1 WHERE trust = 0.5 AND pinned = 0 AND source = 'auralis:decision';");
db.run("UPDATE docs SET trust = 0.7 WHERE trust = 0.5 AND source = 'auralis:distilled';");
// Graph layer: entity/relationship triplets extracted from findings (the 'buildGraph' step). Additive —
// the brain is a graph AND a flat doc store. subj_key/obj_key are normalized so 'same key = same node'.
db.run(`CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT, predicate TEXT, object TEXT,
  subj_key TEXT, obj_key TEXT, doc_id TEXT, project TEXT, created_at TEXT
);`);
// Idempotent graph builds: the same fact from the same doc is one edge, ever — so re-running build-graph
// (or the learn-time build below racing a client-side one) can't inflate the graph. One-time migration
// drops any duplicates that predate the index; COALESCE because NULLs never collide in SQLite UNIQUE.
db.run(`DELETE FROM edges WHERE id NOT IN (
  SELECT MIN(id) FROM edges GROUP BY COALESCE(project,''), subj_key, predicate, obj_key, COALESCE(doc_id,'')
);`);
db.run(`CREATE UNIQUE INDEX IF NOT EXISTS edges_uniq
  ON edges (COALESCE(project,''), subj_key, predicate, obj_key, COALESCE(doc_id,''));`);
// Activity timeline: one narrated event per coordination moment (intent/finding/dedup/overlap/…). Append-
// only like everything here (no delete route). seq = server-assigned order so same-ms events stay stable;
// node_id/parent_node carry the DAG so the causal tree reconstructs without any agent bookkeeping.
db.run(`CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, project TEXT, kind TEXT, actor TEXT,
  human TEXT, node_id TEXT, parent_node TEXT, refs TEXT, ts TEXT
);`);

const insDoc = db.query("INSERT INTO docs (id, content, concepts, project, source, created_at, tier, trust, pinned, valid_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const invalidateStmt = db.query("UPDATE docs SET invalid_at = ?, invalidated_by = ?, invalidated_reason = ? WHERE id = ?");
const insFts = db.query("INSERT INTO docs_fts (id, content, concepts) VALUES (?, ?, ?)");
const supersedeStmt = db.query("UPDATE docs SET superseded_by = ?, superseded_at = ?, superseded_reason = ? WHERE id = ?");
const countStmt = db.query("SELECT COUNT(*) AS c FROM docs");
const getDocStmt = db.query("SELECT id, content, source, superseded_by, project, trust, times_used, last_accessed_at, created_at, archived, valid_at, invalid_at FROM docs WHERE id = ?");
// Serving a doc touches its access columns: retrieved_count is observability; last_accessed_at feeds the
// recency boost (MemoryBank-style reinforcement). times_used is NOT bumped here — usage counts citations
// only (U3), never retrievals, or ranking self-reinforces its own winners (Memoria's documented mistake).
const touchStmt = db.query("UPDATE docs SET retrieved_count = retrieved_count + 1, last_accessed_at = ? WHERE id = ?");
const insEdge = db.query("INSERT OR IGNORE INTO edges (subject, predicate, object, subj_key, obj_key, doc_id, project, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insEvent = db.query("INSERT INTO events (run_id, project, kind, actor, human, node_id, parent_node, refs, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq");
const edgeCountStmt = db.query("SELECT COUNT(*) AS c FROM edges");
const nodeCountStmt = db.query("SELECT COUNT(*) AS c FROM (SELECT subj_key AS k FROM edges UNION SELECT obj_key FROM edges)");
const SEARCH_COLS = `d.id AS id, d.content AS content, d.source AS source, d.superseded_by AS superseded_by,
          d.trust AS trust, d.times_used AS times_used, d.last_accessed_at AS last_accessed_at, d.created_at AS created_at,
          d.valid_at AS valid_at, d.invalid_at AS invalid_at`;
const searchStmt = db.query(
  `SELECT ${SEARCH_COLS}, bm25(docs_fts) AS rank
   FROM docs_fts JOIN docs d ON d.id = docs_fts.id
   WHERE docs_fts MATCH ? AND d.archived = 0 ORDER BY rank LIMIT ?`,
);
const searchDeepStmt = db.query(
  `SELECT ${SEARCH_COLS}, bm25(docs_fts) AS rank
   FROM docs_fts JOIN docs d ON d.id = docs_fts.id
   WHERE docs_fts MATCH ? ORDER BY rank LIMIT ?`,
);

// U4 sweep: archive (never delete) docs whose strength fell below the floor. Strength is computed in JS
// from the same formula ranking uses — one source of truth in rank.ts. Runs at boot and every 24h.
function sweepArchive(): number {
  const rows = db.query("SELECT id, source, trust, times_used, last_accessed_at, created_at, tier, project FROM docs WHERE archived = 0 AND pinned = 0").all() as any[];
  const now = Date.now();
  const mark = db.query("UPDATE docs SET archived = 1 WHERE id = ?");
  const byProject = new Map<string, number>();
  let archived = 0;
  for (const r of rows) {
    const days = daysBetween(r.last_accessed_at ?? r.created_at, now);
    if (strength(Number(r.trust ?? 0.5), Number(r.times_used ?? 0), days, String(r.tier ?? "raw")) < ARCHIVE_FLOOR) {
      mark.run(r.id);
      archived++;
      const p = String(r.project ?? "");
      byProject.set(p, (byProject.get(p) ?? 0) + 1);
    }
  }
  if (archived) {
    console.log(`· sweep: archived ${archived} faded doc(s) — deep search (include_archived=1) still reaches them`);
    // Maintenance belongs on the timeline too — forgetting is a memory event, not a silent side effect.
    const ts = new Date().toISOString();
    for (const [p, n] of byProject) {
      if (p) insEvent.get("oracle:maintenance", p, "note", "oracle", `✎ sweep archived ${n} faded doc(s) — deep search still reaches them`, null, null, null, ts);
    }
  }
  return archived;
}
sweepArchive();
const sweepTimer = setInterval(sweepArchive, 24 * 3600 * 1000);
if (typeof sweepTimer.unref === "function") sweepTimer.unref();

// U7 safety snapshot: an atomic full-brain backup (VACUUM INTO) before any automated mass-mutation —
// cheap insurance the research flagged as the one "git for memory" idea worth keeping. Keep the last 5.
const BACKUP_DIR = `${dbDirOf(DB_PATH)}backups`;
function dbDirOf(p: string): string { return p.replace(/[^/]*$/, "") || "./"; }
function snapshot(reason: string): string {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const file = `${BACKUP_DIR}/pre-${reason}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
  db.run(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const old = readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".db")).sort().reverse().slice(5);
  for (const f of old) rmSync(`${BACKUP_DIR}/${f}`, { force: true });
  return file;
}

// U5 (server half) — the DEDUP pass of the sleep job: same-entity, near-identical (cosine ≥ ~0.92) doc
// pairs collapse by supersession — the older/lower-trust loser is superseded by the winner, usage counters
// carried over so earned ranking survives. Mechanical and LLM-free (this image has no SDK, on purpose);
// the contradiction pass that NEEDS judgment lives host-side in `pnpm sleep`. Never touches pinned docs.
// cos ≥ 0.92 on normalized vectors ⇔ L2 ≤ 0.4 ⇔ our vector score 1/(1+L2) ≥ ~0.714.
const DEDUP_SCORE = 1 / 1.4;
const docEntities = db.query("SELECT DISTINCT subj_key AS k FROM edges WHERE doc_id = ? UNION SELECT DISTINCT obj_key FROM edges WHERE doc_id = ?");
const carryStmt = db.query("UPDATE docs SET times_used = times_used + ?, retrieved_count = retrieved_count + ? WHERE id = ?");
async function sleepDedup(cap = 200): Promise<{ deduped: number; scanned: number }> {
  const rows = db
    .query("SELECT id, content, project, source, trust, pinned, times_used, retrieved_count, created_at FROM docs WHERE superseded_by IS NULL AND invalid_at IS NULL AND archived = 0 ORDER BY created_at DESC LIMIT ?")
    .all(cap) as any[];
  const byId = new Map(rows.map((r) => [String(r.id), r]));
  const ents = (id: string) => new Set((docEntities.all(id, id) as any[]).map((e) => String(e.k)));
  let deduped = 0;
  const byProject = new Map<string, number>();
  for (const doc of rows) {
    if (byId.get(String(doc.id))?.superseded_by) continue; // already lost this run
    const near = await vectorQuery(String(doc.content), 6);
    for (const [otherId, score] of near) {
      if (otherId === String(doc.id) || score < DEDUP_SCORE) continue;
      const other = byId.get(otherId);
      if (!other || other.superseded_by || String(other.project ?? "") !== String(doc.project ?? "")) continue;
      const shared = [...ents(String(doc.id))].some((k) => ents(otherId).has(k));
      if (!shared) continue; // entity blocking: near-identical text about DIFFERENT things stays apart
      // Winner: higher trust; tie → newer. The loser must not be pinned (pins are frozen by policy).
      const [win, lose] =
        Number(doc.trust) !== Number(other.trust)
          ? Number(doc.trust) > Number(other.trust) ? [doc, other] : [other, doc]
          : String(doc.created_at) >= String(other.created_at) ? [doc, other] : [other, doc];
      if (lose.pinned) continue;
      supersedeStmt.run(String(win.id), new Date().toISOString(), "sleep: near-duplicate (same entity, cos ≥ 0.92)", String(lose.id));
      carryStmt.run(Number(lose.times_used ?? 0), Number(lose.retrieved_count ?? 0), String(win.id));
      lose.superseded_by = String(win.id); // keep the in-memory view consistent for this run
      deduped++;
      const p = String(lose.project ?? "");
      if (p) byProject.set(p, (byProject.get(p) ?? 0) + 1);
    }
  }
  if (deduped) {
    const ts = new Date().toISOString();
    for (const [p, n] of byProject) insEvent.get("oracle:maintenance", p, "note", "oracle", `✎ sleep deduped ${n} near-duplicate(s) — superseded, counters carried`, null, null, null, ts);
  }
  return { deduped, scanned: rows.length };
}
const sleepTimer = setInterval(() => { snapshot("sleep"); sleepDedup().catch(() => {}); }, 24 * 3600 * 1000);
if (typeof sleepTimer.unref === "function") sleepTimer.unref();

// Stopwords: high-frequency words carry no topic. Without dropping them, a query like "how does auth work"
// matches every doc containing "the/is/how" and the ranker orders noise — the ranking bench surfaced exactly
// this (boosts amplified off-topic docs that only shared "the"/"is"). Standard IR practice; helps real recall too.
const STOPWORDS = new Set(
  ("a an and are as at be been being but by can could did do does doing for from had has have how in into is it its of on or " +
   "that the their this to was were what when where which who why will with would you your").split(" "),
);
function sanitize(q: string): string {
  const raw = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1);
  const kept = raw.filter((t) => !STOPWORDS.has(t));
  const toks = kept.length ? kept : raw; // an all-stopword query keeps them rather than matching nothing
  const uniq = [...new Set(toks)].slice(0, 8);
  return uniq.length ? uniq.map((t) => `"${t}"`).join(" OR ") : '"_"';
}
// Collision-proof under concurrency: timestamp+slug alone collided when parallel learns landed in the
// same millisecond with similar openings (found live — the LongMemEval harness ingests 3 questions at
// once and a PK violation took the whole run down). A per-process sequence disambiguates.
let idSeq = 0;
function idFrom(content: string): string {
  const slug = content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `learning_${Date.now()}${(idSeq++ % 1296).toString(36).padStart(2, "0")}_${slug}`.slice(0, 90);
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

// Concurrent-dedup claim registry — the ONE shared, runtime-agnostic point every worker/process resolves
// against (the enforcement POLICY is central; each agent runtime only needs a thin call in). In-memory
// and ephemeral, scoped per run so a fresh run isn't blocked by a previous one's claims.
const claims = new Map<string, Map<string, string>>(); // scope -> (target -> owning worker)
function claimIn(scope: string): Map<string, string> {
  let m = claims.get(scope);
  if (!m) claims.set(scope, (m = new Map()));
  return m;
}

// Optional bearer auth (production): set ORACLE_TOKEN and every route except /health requires
// `Authorization: Bearer <token>`. Unset = dev behaviour unchanged. Compose publishes ports on
// 127.0.0.1 only; the token is defence for anything beyond that (tunnels, LAN).
const TOKEN = process.env.ORACLE_TOKEN;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true, vectors: vectorsOn, embedder });
    if (TOKEN && req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/api/stats") {
      // Scope to a project when asked, so the dashboard cards match its project-scoped tabs. No project =
      // global totals (kept for OracleAdapter.count() and any caller that wants the whole brain).
      const project = url.searchParams.get("project");
      const row = (project ? db.query("SELECT COUNT(*) AS c FROM docs WHERE project = ?").get(project) : countStmt.get()) as { c: number };
      const e = (project ? db.query("SELECT COUNT(*) AS c FROM edges WHERE project = ?").get(project) : edgeCountStmt.get()) as { c: number };
      const n = (project
        ? db.query("SELECT COUNT(*) AS c FROM (SELECT subj_key AS k FROM edges WHERE project = ? UNION SELECT obj_key FROM edges WHERE project = ?)").get(project, project)
        : nodeCountStmt.get()) as { c: number };
      // Usage health (P1's permanent instrument): cited = explicit "this helped" credits; seen = recall
      // servings. The ratio is the better/worse dial — up means memory is earning its keep; a ratio racing
      // toward 1 would mean cite-inflation (citing ritually), the failure mode to watch for.
      const u = (project
        ? db.query("SELECT COALESCE(SUM(times_used),0) AS u, COALESCE(SUM(retrieved_count),0) AS s FROM docs WHERE project = ? AND superseded_by IS NULL").get(project)
        : db.query("SELECT COALESCE(SUM(times_used),0) AS u, COALESCE(SUM(retrieved_count),0) AS s FROM docs WHERE superseded_by IS NULL").get()) as { u: number; s: number };
      return Response.json({ count: row.c, edges: e.c, nodes: n.c, cited: u.u, seen: u.s, vectors: vectorsOn, embedder });
    }

    if (req.method === "POST" && url.pathname === "/api/learn") {
      const body = (await req.json().catch(() => ({}))) as any;
      const pattern = String(body?.pattern ?? "").trim();
      if (!pattern) return Response.json({ error: "pattern is required" }, { status: 400 });
      const id = idFrom(pattern);
      const concepts = Array.isArray(body?.concepts) ? body.concepts.join(" ") : "";
      const source = String(body?.source ?? "auralis");
      // pinned: explicit body flag wins (e.g. a retro with a real lesson); else derived from the source.
      const pinned = typeof body?.pinned === "boolean" ? body.pinned : pinnedOf(source);
      // validAt (optional, ISO): when the fact became true IN THE WORLD — lets a correction recorded today
      // describe a truth that started last month. Defaults to "since created_at" (NULL).
      const validAt = typeof body?.validAt === "string" && !Number.isNaN(Date.parse(body.validAt)) ? new Date(body.validAt).toISOString() : null;
      insDoc.run(id, pattern, concepts, body?.project ?? null, source, new Date().toISOString(), body?.tier === "distilled" ? "distilled" : "raw", trustOf(source), pinned ? 1 : 0, validAt);
      insFts.run(id, pattern, concepts); // synchronous -> immediately searchable
      await vectorAdd(id, pattern);
      // Incremental graph AT THE INGRESS: every learn extracts heuristic triplets (pure, ~8.5ms measured,
      // no LLM in the write path) so the graph grows with the brain no matter which client wrote — fleet,
      // session hook, MCP, retro. Never a rebuild: entity keys make new edges join existing nodes, and the
      // unique index makes any re-extraction idempotent. LLM predicate refinement stays a batch job
      // (pnpm build-graph / analyze). ORACLE_GRAPH=0 opts out.
      let edges = 0;
      if (process.env.ORACLE_GRAPH !== "0") {
        const now = new Date().toISOString();
        for (const t of extractTriplets(pattern)) {
          insEdge.run(t.subject, t.predicate, t.object, normKey(t.subject), normKey(t.object), id, body?.project ?? null, now);
          edges++;
        }
      }
      return Response.json({ success: true, id, edges, embedding: vectorsOn ? embedder : "fts-only" });
    }

    // Graph edges from a finding (posted by the buildGraph step, separate from learn so slow/optional
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

    // U6: the world changed — the fact WAS true and stopped being true at invalidAt (default: now).
    // Distinct from supersede (= we were wrong). The doc stays searchable; ranking sinks it like a
    // superseded one, and as_of queries before invalidAt still return it — that is the whole point.
    if (req.method === "POST" && url.pathname === "/api/invalidate") {
      const body = (await req.json().catch(() => ({}))) as any;
      const oldId = String(body?.oldId ?? "");
      if (!oldId) return Response.json({ error: "oldId is required" }, { status: 400 });
      const invalidAt = typeof body?.invalidAt === "string" && !Number.isNaN(Date.parse(body.invalidAt)) ? new Date(body.invalidAt).toISOString() : new Date().toISOString();
      invalidateStmt.run(invalidAt, body?.newId ?? null, body?.reason ?? null, oldId);
      return Response.json({ success: true, oldId, invalidAt });
    }

    // Concurrent-dedup claim: first worker to claim a (scope,target) owns it; a later, different worker is
    // told to skip. This is the shared enforcement point for ANY agent runtime, not just the Claude hook.
    // U4: trigger the archive sweep on demand (ops/testing; boot + 24h interval run it automatically).
    if (req.method === "POST" && url.pathname === "/api/sweep") {
      return Response.json({ success: true, archived: sweepArchive() });
    }

    // U7: atomic full-brain backup on demand (VACUUM INTO; keeps the last 5).
    if (req.method === "POST" && url.pathname === "/api/snapshot") {
      const body = (await req.json().catch(() => ({}))) as any;
      return Response.json({ success: true, file: snapshot(String(body?.reason ?? "manual").replace(/[^a-z0-9-]/gi, "-").slice(0, 24)) });
    }

    // U5 (server half): snapshot first, then the mechanical dedup pass. The response also carries the
    // CONTRADICTION CANDIDATES — same-entity pairs in the ambiguous band (cos ~0.75–0.92) — for the
    // host-side `pnpm sleep` to judge with an LLM; this server stays LLM-free by design.
    if (req.method === "POST" && url.pathname === "/api/sleep") {
      const file = snapshot("sleep");
      const res = await sleepDedup();
      const BAND_LO = 1 / (1 + Math.sqrt(2 - 2 * 0.75)); // cos 0.75 → score ~0.586
      const rows = db
        .query("SELECT id, content, project, created_at FROM docs WHERE superseded_by IS NULL AND invalid_at IS NULL AND archived = 0 ORDER BY created_at DESC LIMIT 120")
        .all() as any[];
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      const ents = (id: string) => new Set((docEntities.all(id, id) as any[]).map((e) => String(e.k)));
      const seen = new Set<string>();
      const candidates: any[] = [];
      for (const doc of rows) {
        if (candidates.length >= 20) break; // budget cap — the host LLM pass is per-pair work
        const near = await vectorQuery(String(doc.content), 6);
        for (const [otherId, score] of near) {
          if (otherId === String(doc.id) || score < BAND_LO || score >= DEDUP_SCORE) continue;
          const other = byId.get(otherId);
          if (!other || String(other.project ?? "") !== String(doc.project ?? "")) continue;
          const key = [String(doc.id), otherId].sort().join("|");
          if (seen.has(key)) continue;
          seen.add(key);
          if (![...ents(String(doc.id))].some((k) => ents(otherId).has(k))) continue;
          const [newer, older] = String(doc.created_at) >= String(other.created_at) ? [doc, other] : [other, doc];
          candidates.push({ newerId: String(newer.id), olderId: String(older.id), newer: String(newer.content).slice(0, 500), older: String(older.content).slice(0, 500), project: doc.project ?? null });
        }
      }
      return Response.json({ success: true, snapshot: file, ...res, candidates });
    }

    // U3 usage feedback: a worker cited this finding as having materially helped. Citation (not retrieval)
    // feeds the usage boost — see the touchStmt comment for why. Idempotent-ish, append-only in spirit.
    if (req.method === "POST" && url.pathname === "/api/cite") {
      const body = (await req.json().catch(() => ({}))) as any;
      const id = String(body?.id ?? "").trim();
      if (!id) return Response.json({ error: "id is required" }, { status: 400 });
      const r = db.query("UPDATE docs SET times_used = times_used + 1, last_accessed_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return Response.json({ success: (r as any).changes !== 0 });
    }

    if (req.method === "POST" && url.pathname === "/api/claim") {
      const body = (await req.json().catch(() => ({}))) as any;
      const scope = String(body?.scope ?? "default");
      const target = String(body?.target ?? "");
      const by = String(body?.by ?? "");
      if (!target || !by) return Response.json({ error: "target and by are required" }, { status: 400 });
      return Response.json(resolveClaim(claimIn(scope), target, by));
    }
    if (req.method === "POST" && url.pathname === "/api/claim/reset") {
      const body = (await req.json().catch(() => ({}))) as any;
      claims.delete(String(body?.scope ?? "default"));
      return Response.json({ success: true });
    }

    // Activity timeline — append one narrated event. Best-effort by design (callers never block on it), so
    // a bad body just 400s and the run carries on.
    if (req.method === "POST" && url.pathname === "/api/event") {
      const body = (await req.json().catch(() => ({}))) as any;
      const kind = String(body?.kind ?? "").trim();
      const human = String(body?.human ?? "").trim();
      if (!kind || !human) return Response.json({ error: "kind and human are required" }, { status: 400 });
      const row = insEvent.get(
        body?.runId ?? null,
        body?.project ?? null,
        kind,
        String(body?.actor ?? ""),
        human,
        body?.nodeId ?? null,
        body?.parentNode != null ? JSON.stringify(body.parentNode) : null,
        body?.refs != null ? JSON.stringify(body.refs) : null,
        new Date().toISOString(),
      ) as { seq: number };
      return Response.json({ ok: true, seq: row.seq });
    }

    // Replay a run's timeline in order. run omitted => the newest run for the project (or newest overall).
    if (req.method === "GET" && url.pathname === "/api/timeline") {
      let run = url.searchParams.get("run");
      const project = url.searchParams.get("project");
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 500)));
      if (!run) {
        const latest = db.query(
          project ? "SELECT run_id FROM events WHERE project = ? ORDER BY seq DESC LIMIT 1" : "SELECT run_id FROM events ORDER BY seq DESC LIMIT 1",
        ).get(...(project ? [project] : [])) as any;
        run = latest?.run_id ?? null;
      }
      const cond: string[] = [];
      const params: any[] = [];
      if (run) { cond.push("run_id = ?"); params.push(run); }
      if (project) { cond.push("project = ?"); params.push(project); }
      let sql = "SELECT seq, run_id, project, kind, actor, human, node_id, parent_node, refs, ts FROM events";
      if (cond.length) sql += " WHERE " + cond.join(" AND ");
      sql += " ORDER BY seq LIMIT ?";
      params.push(limit);
      const rows = db.query(sql).all(...params) as any[];
      const events = rows.map((r) => ({
        seq: r.seq, runId: r.run_id, project: r.project, kind: r.kind, actor: r.actor, human: r.human,
        nodeId: r.node_id ?? undefined,
        parentNode: r.parent_node ? JSON.parse(r.parent_node) : undefined,
        refs: r.refs ? JSON.parse(r.refs) : undefined,
        ts: r.ts,
      }));
      return Response.json({ run, events });
    }

    // All runs for a project (newest first) with a per-run scorecard — the run history / compare view.
    if (req.method === "GET" && url.pathname === "/api/runs") {
      const project = url.searchParams.get("project");
      let sql = `SELECT run_id AS runId, COUNT(*) AS events, COUNT(DISTINCT node_id) AS tasks,
        MIN(ts) AS firstTs, MAX(ts) AS lastTs, MAX(seq) AS lastSeq,
        SUM(kind = 'dedup') AS deduped, SUM(kind = 'overlap') AS overlaps,
        SUM(kind = 'repair') AS repairs, SUM(kind = 'note') AS notes
        FROM events`;
      const params: any[] = [];
      if (project) { sql += " WHERE project = ?"; params.push(project); }
      sql += " GROUP BY run_id ORDER BY lastSeq DESC LIMIT 50";
      return Response.json({ runs: db.query(sql).all(...params) });
    }

    // Where wall-clock went on the last run: the timing sink grouped by phase, sorted, with share-of-wall.
    if (req.method === "GET" && url.pathname === "/api/timing") {
      try {
        const text = await Bun.file(TIMING_PATH).text();
        const spans = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as any[];
        const g = new Map<string, { name: string; n: number; total: number; max: number }>();
        let wall = 0;
        for (const s of spans) {
          const e = g.get(s.name) ?? { name: s.name, n: 0, total: 0, max: 0 };
          e.n++; e.total += s.ms ?? 0; e.max = Math.max(e.max, s.ms ?? 0);
          g.set(s.name, e);
          wall = Math.max(wall, (s.atMs ?? 0) + (s.ms ?? 0)); // spans nest; wall = latest span end
        }
        const phases = [...g.values()].sort((a, b) => b.total - a.total).map((e) => ({ ...e, share: wall ? e.total / wall : 0 }));
        return Response.json({ wall, spans: spans.length, phases });
      } catch {
        return Response.json({ wall: 0, spans: 0, phases: [] }); // no run has written timing yet
      }
    }

    // Top entities in the knowledge graph by degree — the entry points for the graph explorer.
    if (req.method === "GET" && url.pathname === "/api/graph/entities") {
      const project = url.searchParams.get("project");
      const where = project ? " WHERE project = ?" : "";
      const params = project ? [project, project] : [];
      const sql = `SELECT k AS key, MAX(label) AS label, COUNT(*) AS degree FROM (
        SELECT subj_key AS k, subject AS label FROM edges${where}
        UNION ALL SELECT obj_key AS k, object AS label FROM edges${where}
      ) GROUP BY k ORDER BY degree DESC LIMIT 40`;
      return Response.json({ entities: db.query(sql).all(...params) });
    }

    // The whole graph (bounded) for the force-directed view — the frontend derives nodes from the keys.
    if (req.method === "GET" && url.pathname === "/api/graph/all") {
      const project = url.searchParams.get("project");
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get("limit") ?? 400)));
      let sql = "SELECT subject, predicate, object, subj_key, obj_key FROM edges";
      const params: any[] = [];
      if (project) { sql += " WHERE project = ?"; params.push(project); }
      sql += " ORDER BY id LIMIT ?"; params.push(limit);
      return Response.json({ edges: db.query(sql).all(...params) });
    }

    // The honest ADR log: decisions recorded into the brain (source auralis:decision). Superseded ones are
    // kept and flagged (reversed, not deleted) — the values layer made visible.
    if (req.method === "GET" && url.pathname === "/api/decisions") {
      const project = url.searchParams.get("project");
      let sql = "SELECT id, content, created_at AS createdAt, superseded_by AS supersededBy, superseded_reason AS supersededReason FROM docs WHERE source = 'auralis:decision'";
      const params: any[] = [];
      if (project) { sql += " AND project = ?"; params.push(project); }
      sql += " ORDER BY created_at DESC LIMIT 100";
      return Response.json({ decisions: db.query(sql).all(...params) });
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
      // The findings UI shows the full record — source, trust, pins, usage, age — not just text.
      let sql = `SELECT id, content, tier, source, trust, pinned, archived, times_used, retrieved_count, created_at
                 FROM docs WHERE superseded_by IS NULL`;
      const params: any[] = [];
      if (tier) { sql += " AND tier = ?"; params.push(tier); }
      if (project) { sql += " AND project = ?"; params.push(project); }
      sql += " ORDER BY created_at DESC LIMIT ?"; params.push(max);
      const rows = db.query(sql).all(...params) as any[];
      return Response.json({
        docs: rows.map((r) => ({
          id: r.id,
          content: r.content,
          tier: r.tier ?? "raw",
          source: r.source ?? "",
          trust: Number(r.trust ?? 0.5),
          pinned: !!r.pinned,
          archived: !!r.archived,
          timesUsed: Number(r.times_used ?? 0),
          retrieved: Number(r.retrieved_count ?? 0),
          createdAt: r.created_at ?? "",
        })),
      });
    }

    // Projects that actually have data — so the dashboard can offer a picker instead of a blind text box
    // defaulting to "default" (which is usually empty). Ordered by most-recent activity, then doc count.
    if (req.method === "GET" && url.pathname === "/api/projects") {
      const acc = new Map<string, { project: string; docs: number; events: number; lastTs: string }>();
      const get = (p: string) => acc.get(p) ?? acc.set(p, { project: p, docs: 0, events: 0, lastTs: "" }).get(p)!;
      for (const r of db.query("SELECT project, COUNT(*) c, MAX(created_at) last FROM docs WHERE project IS NOT NULL AND superseded_by IS NULL GROUP BY project").all() as any[]) {
        const e = get(String(r.project)); e.docs = Number(r.c); e.lastTs = String(r.last ?? "");
      }
      for (const r of db.query("SELECT project, COUNT(*) c, MAX(ts) last FROM events WHERE project IS NOT NULL GROUP BY project").all() as any[]) {
        const e = get(String(r.project)); e.events = Number(r.c); if (String(r.last ?? "") > e.lastTs) e.lastTs = String(r.last);
      }
      // Substance first: projects with real findings (docs) rank above doc-less timeline-only probes (e.g.
      // integration-test runs), then most-recent within each group — so the picker defaults to real data.
      const projects = [...acc.values()].sort((a, b) => {
        const sub = (b.docs > 0 ? 1 : 0) - (a.docs > 0 ? 1 : 0);
        return sub !== 0 ? sub : b.lastTs > a.lastTs ? 1 : b.lastTs < a.lastTs ? -1 : b.docs - a.docs;
      });
      return Response.json({ projects });
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
      const deep = url.searchParams.get("include_archived") === "1"; // deep search reaches archived docs
      // rank=plain returns pure relevance order (RRF only, no trust/recency/usage/supersede boosts) — the
      // A/B baseline the ranking bench compares against, so we can MEASURE whether the boosts earn their place.
      const plain = url.searchParams.get("rank") === "plain";
      // U6 temporal retrieval — as_of=<ISO> answers "what was TRUE at time T" (VALID-time semantics):
      // keep docs whose validity interval covers T (valid_at ?? created_at <= T < invalid_at), and still
      // exclude superseded ones — a corrected doc was never true, at any time; its correction (which may
      // carry a back-dated validAt) is the truth about T. "What did we BELIEVE at T" (transaction time) is
      // a different question, deliberately not implemented until someone needs it.
      const asOfRaw = url.searchParams.get("as_of");
      const asOf = asOfRaw && !Number.isNaN(Date.parse(asOfRaw)) ? Date.parse(asOfRaw) : null;
      // explain=1: every result justifies WHY it was retrieved (philosophy principle 4) — the rank each
      // list gave it, the RRF base, and each boost component. Same code path computes score and story.
      const explain = url.searchParams.get("explain") === "1";

      const ftsRows =
        mode === "vector"
          ? []
          : ((project
              ? db
                  .query(
                    `SELECT ${SEARCH_COLS}, bm25(docs_fts) AS rank
                     FROM docs_fts JOIN docs d ON d.id = docs_fts.id
                     WHERE docs_fts MATCH ? AND d.project = ? ${deep ? "" : "AND d.archived = 0"} ORDER BY rank LIMIT ?`,
                  )
                  .all(sanitize(q), project, limit * 3)
              : (deep ? searchDeepStmt : searchStmt).all(sanitize(q), limit * 3)) as any[]);
      const vScores = mode === "fts" ? new Map<string, number>() : await vectorQuery(q, limit * 3);

      // Ranking v2 (U1+U2): rank-only RRF over the two lists (bm25 and cosine scales never mix), then
      // bounded boosts (recency/usage/trust) — relevance dominates, metadata nudges. See oracle-lite/rank.ts.
      const byId = new Map<string, any>();
      for (const r of ftsRows) byId.set(String(r.id), r);
      const vRanked = [...vScores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      for (const id of vRanked) {
        if (byId.has(id)) continue;
        const d = getDocStmt.get(id) as any;
        if (!d || (project && d.project !== project) || (!deep && d.archived)) { byId.set(id, null); continue; } // out of project / faded — keep rank slot, drop doc
        byId.set(id, d);
      }
      const fused = rrf([ftsRows.map((r) => String(r.id)), vRanked]);
      const now = Date.now();
      let cands = [...fused.entries()].map(([id, base]) => ({ id, base, doc: byId.get(id) })).filter((c) => c.doc);
      if (asOf !== null) {
        // Truth-at-T: validity interval must cover T, and superseded docs never qualify (they were wrong).
        cands = cands.filter((c) => {
          if (c.doc.superseded_by) return false;
          const from = Date.parse(c.doc.valid_at ?? c.doc.created_at ?? "") || 0;
          const until = c.doc.invalid_at ? Date.parse(c.doc.invalid_at) : Infinity;
          return from <= asOf && asOf < until;
        });
      }
      const maxUsed = Math.max(0, ...cands.map((c) => Number(c.doc.times_used ?? 0)));
      // "No longer current" sinks the same way whichever way it happened: superseded (we were wrong) or
      // invalidated (the world changed). In as_of mode nothing sinks — everything left WAS true at T.
      const outdated = (d: any) => !!d.superseded_by || (d.invalid_at != null && Date.parse(d.invalid_at) <= now);
      const ftsRankOf = new Map(ftsRows.map((r, i) => [String(r.id), i + 1]));
      const vecRankOf = new Map(vRanked.map((id, i) => [id, i + 1]));
      const scored = cands.map((c) => {
        const inputs = {
          trust: Number(c.doc.trust ?? 0.5),
          timesUsed: Number(c.doc.times_used ?? 0),
          maxUsed,
          daysSinceAccess: daysBetween(c.doc.last_accessed_at ?? c.doc.created_at, now),
          superseded: asOf !== null ? false : outdated(c.doc),
        };
        const parts = boostParts(inputs);
        return {
          ...c,
          score: plain ? c.base : c.base * parts.multiplier, // plain = pure RRF (the bench's A/B control)
          why: explain
            ? {
                ftsRank: ftsRankOf.get(c.id) ?? null,
                vecRank: vecRankOf.get(c.id) ?? null,
                rrf: c.base,
                recency: Number(parts.recency.toFixed(3)),
                usage: Number(parts.usage.toFixed(3)),
                trust: parts.trust,
                multiplier: plain ? 1 : Number(parts.multiplier.toFixed(3)),
                outdated: parts.outdated,
                asOf: asOf !== null ? new Date(asOf).toISOString() : null,
              }
            : undefined,
        };
      });

      const top = scored.sort((a, b) => b.score - a.score).slice(0, limit);
      const nowIso = new Date().toISOString();
      for (const r of top) touchStmt.run(nowIso, r.id); // recency reinforcement + observability
      const results = top.map((r) => ({
        id: r.id,
        content: String(r.doc.content).slice(0, 2000),
        type: "learning",
        source: r.doc.source ?? "fts",
        superseded_by: r.doc.superseded_by ?? undefined,
        invalid_at: r.doc.invalid_at ?? undefined,
        valid_at: r.doc.valid_at ?? undefined,
        trust: Number(r.doc.trust ?? 0.5),
        score: r.score,
        why: r.why,
      }));
      return Response.json({ results, total: results.length, query: q, mode, vectors: vectorsOn, embedder, as_of: asOf !== null ? new Date(asOf).toISOString() : undefined });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`oracle-lite (FTS5${vectorsOn ? ` + LanceDB vectors/${embedder}` : ", FTS-only"}) on http://localhost:${server.port}  db=${DB_PATH}`);
