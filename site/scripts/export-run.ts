// Export one recorded fleet run from the brain (oracle-lite SQLite) into a
// frozen, sanitized JSON bundle the landing page replays. This file is the
// page's single source of truth for run data — the "no literals in JSX" rule
// depends on it (landing plan §2).
//
//   bun scripts/export-run.ts                     # newest fleet run
//   bun scripts/export-run.ts --run <run_id>
//   bun scripts/export-run.ts --db <path> --out <path>
//
// Determinism: output derives only from the recorded rows (no wall-clock, no
// randomness), so re-running against the same run is byte-identical.
import { Database } from 'bun:sqlite'
import { homedir } from 'node:os'

type Row = {
  seq: number
  run_id: string
  project: string | null
  kind: string
  actor: string | null
  human: string | null
  node_id: string | null
  parent_node: string | null
  ts: string
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag)
  return i > -1 ? process.argv[i + 1] : undefined
}

const dbPath = arg('--db') ?? new URL('../../.auralis-out/brain.sqlite', import.meta.url).pathname
const outPath = arg('--out') ?? new URL('../src/data/run.json', import.meta.url).pathname

const db = new Database(dbPath, { readonly: true })

// Pick the run: explicit --run, else the fleet run (not session capture) with
// the most events, newest first.
const runId =
  arg('--run') ??
  (
    db
      .query(
        `SELECT run_id FROM events WHERE run_id NOT LIKE 'session:%'
         GROUP BY run_id ORDER BY COUNT(*) DESC, MAX(ts) DESC LIMIT 1`,
      )
      .get() as { run_id: string } | null
  )?.run_id

if (!runId) {
  console.error('no fleet runs recorded in the brain — run `pnpm analyze "…"` first, then re-export')
  process.exit(1)
}

const rows = db
  .query(`SELECT seq, run_id, project, kind, actor, human, node_id, parent_node, ts FROM events WHERE run_id = ? ORDER BY seq`)
  .all(runId) as Row[]

// --- sanitize ---------------------------------------------------------------
// The bundle ships publicly: strip machine-local paths and anything
// credential-shaped. Repo-relative paths stay — they're the evidence.
const HOME = homedir()
function sanitize(text: string): string {
  return text
    .replaceAll(HOME, '~')
    .replace(/\/Users\/[A-Za-z0-9._-]+/g, '~')
    .replace(/\/home\/[A-Za-z0-9._-]+/g, '~')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .replace(/\b(sk-[A-Za-z0-9-]{16,}|ghp_[A-Za-z0-9]{16,}|xox[a-z]-[A-Za-z0-9-]{10,})\b/g, '<redacted-token>')
    .replace(/\b[0-9a-f]{40,}\b/gi, '<redacted-hex>')
}

const t0 = Date.parse(rows[0]!.ts)
const events = rows.map((r) => ({
  seq: r.seq,
  // offset ms from run start — the replay's virtual clock
  t: Math.max(0, Date.parse(r.ts) - t0),
  kind: r.kind,
  actor: r.actor ? sanitize(r.actor) : null,
  text: r.human ? sanitize(r.human) : null,
  node: r.node_id,
  parent: r.parent_node,
  ts: r.ts,
}))

// Derived counters — computed from the events, mirroring what the hero shows.
// The page recomputes these live during replay; exporting them lets CI assert
// that what renders matches what was recorded. Count ONLY exact markers (event
// kind, or the CLI glyph the event text starts with) — loose substring matches
// would count a worker grepping for the word "duplicate" as a prevented dupe.
const glyph = (e: { text: string | null }) => (e.text ?? '').trimStart().slice(0, 1)
const byKind: Record<string, number> = {}
for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1
const derived = {
  byKind,
  verified: events.filter((e) => glyph(e) === '✓').length,
  warnings: events.filter((e) => glyph(e) === '⚠').length,
  shares: events.filter((e) => glyph(e) === '⇄').length,
  reworks: events.filter((e) => glyph(e) === '↻').length,
  overlapsFlagged: byKind['overlap'] ?? 0,
  workers: [...new Set(events.map((e) => e.actor).filter((a) => a && !['human', 'conductor', 'planner', 'sentry', 'critic', 'auditor'].includes(a!)))].length,
}

const bundle = {
  $schema: 'auralis-run-export/v1',
  runId: sanitize(runId),
  project: rows[0]!.project,
  recordedAt: rows[0]!.ts,
  finishedAt: rows[rows.length - 1]!.ts,
  eventCount: events.length,
  derived,
  events,
}

await Bun.write(outPath, JSON.stringify(bundle, null, 2) + '\n')
console.log(`exported ${events.length} events from ${runId} → ${outPath}`)
console.log(`derived: ${JSON.stringify(derived)}`)
