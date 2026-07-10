// The analytical panels behind the dashboard tabs. Each fetches its own slice of the brain via usePoll
// (stale-guarded) and refetches on the shared `tick` the parent bumps while live. Kept in one file —
// they're small and always shipped together.
import { useEffect, useMemo, useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getDecisions, getGraphAll, getRuns, getTiming, search, type GraphAllEdge, type SearchResult } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { ForceGraph } from "@/components/force-graph"

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(ms < 10 ? 1 : 0)}ms`)

// ── Timing: where wall-clock actually went. Bars relative to the biggest phase; the point is that the LLM dominates.
export function TimingPanel({ tick }: { tick: number }) {
  const { data: t } = usePoll(getTiming, [tick])
  const top = t?.phases.reduce((m, p) => Math.max(m, p.total), 0) || 1
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">Where time goes
          {t && <span className="text-xs font-normal text-muted-foreground">wall {fmt(t.wall)} · {t.spans} spans</span>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {(!t || t.phases.length === 0) && (
          <p className="text-sm text-muted-foreground">no timing yet — run <code className="font-mono">pnpm dev</code>, which writes the timing sink.</p>
        )}
        {t?.phases.map((p) => (
          <div key={p.name} className="text-sm">
            <div className="flex justify-between mb-1">
              <span className="font-mono">{p.name} <span className="text-muted-foreground text-xs">×{p.n}</span></span>
              <span className="tabular-nums text-muted-foreground">{fmt(p.total)} · {(p.share * 100).toFixed(1)}%</span>
            </div>
            <div className="h-2 rounded bg-muted overflow-hidden">
              <div className="h-full bg-primary" style={{ width: `${Math.max(2, (p.total / top) * 100)}%` }} />
            </div>
          </div>
        ))}
        {t && t.phases.length > 0 && (
          <p className="text-xs text-muted-foreground pt-1">bars are relative to the biggest phase; share is of wall (can exceed 100% when tasks run in parallel — spans nest).</p>
        )}
      </CardContent>
    </Card>
  )
}

// ── Runs: history + per-run scorecard. Click a row to drive the timeline (compare by eyeballing the columns).
export function RunsPanel({ project, tick, selected, onSelect }: { project: string; tick: number; selected: string; onSelect: (runId: string) => void }) {
  const { data } = usePoll(() => getRuns(project), [project, tick])
  const runs = data?.runs ?? []
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle>Runs <span className="text-xs font-normal text-muted-foreground">click one to drive the timeline</span></CardTitle></CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>run</TableHead>
              <TableHead className="text-right">tasks</TableHead>
              <TableHead className="text-right">deduped</TableHead>
              <TableHead className="text-right">overlaps</TableHead>
              <TableHead className="text-right">repairs</TableHead>
              <TableHead className="text-right">events</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && <TableRow><TableCell colSpan={6} className="text-muted-foreground">no runs yet.</TableCell></TableRow>}
            {runs.map((r) => (
              <TableRow key={r.runId} onClick={() => onSelect(r.runId)} className={`cursor-pointer ${selected === r.runId ? "bg-muted/60" : ""}`}>
                <TableCell className="font-mono text-xs">
                  <div className="truncate max-w-[240px]">{r.runId}</div>
                  <div className="text-muted-foreground">{r.lastTs?.slice(0, 19).replace("T", " ")}</div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.tasks}</TableCell>
                <TableCell className="text-right tabular-nums text-amber-400">{r.deduped}</TableCell>
                <TableCell className="text-right tabular-nums text-red-400">{r.overlaps}</TableCell>
                <TableCell className="text-right tabular-nums text-orange-400">{r.repairs}</TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">{r.events}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}

// ── Graph: the whole knowledge graph as a force-directed view. Drag to pin, hover to spotlight a node's
// neighborhood, click a node to list its edges below.
export function GraphPanel({ project, tick }: { project: string; tick: number }) {
  const { data } = usePoll(() => getGraphAll(project), [project, tick])
  // Every poll returns a fresh array; keying the memo on content keeps the reference stable when the
  // graph hasn't actually changed, so ForceGraph doesn't rebuild (and restart its simulation) each tick.
  const edgesKey = JSON.stringify(data?.edges ?? [])
  const edges = useMemo(() => JSON.parse(edgesKey) as GraphAllEdge[], [edgesKey])
  const [sel, setSel] = useState("")
  const nodeCount = new Set(edges.flatMap((e) => [e.subj_key, e.obj_key])).size
  const nbr = sel ? edges.filter((e) => e.subj_key === sel || e.obj_key === sel) : []
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Knowledge graph
          <span className="text-xs font-normal text-muted-foreground"> {nodeCount} nodes · {edges.length} edges · drag to pin · double-click to unpin</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {edges.length === 0
          ? <p className="text-sm text-muted-foreground">no graph yet — run <code className="font-mono">pnpm build-graph</code>.</p>
          : <ForceGraph edges={edges} onSelect={setSel} />}
        {sel && (
          <div>
            <div className="text-xs text-muted-foreground mb-1">neighborhood of {sel}</div>
            <ul className="space-y-1">
              {nbr.map((e, i) => (
                <li key={i} className="font-mono text-xs">
                  <span>{e.subject}</span>
                  <span className="text-violet-400"> —{e.predicate}→ </span>
                  <span>{e.object}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Decisions: the honest ADR log straight from the brain. Superseded ones are kept and flagged (reversed,
// never deleted) — the values layer, visible.
export function DecisionsPanel({ project, tick }: { project: string; tick: number }) {
  const { data } = usePoll(() => getDecisions(project), [project, tick])
  const decisions = data?.decisions ?? []
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Decisions <span className="text-xs font-normal text-muted-foreground">honest ADRs — superseded, never deleted</span></CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {decisions.length === 0 && (
          <p className="text-sm text-muted-foreground">no decisions yet — agents record them via the <code className="font-mono">decide</code> tool.</p>
        )}
        {decisions.map((d) => {
          const title = d.content.split("\n")[0].replace(/^Architecture Decision Record:\s*/, "")
          return (
            <div key={d.id} className={`rounded-md border p-3 ${d.supersededBy ? "opacity-70" : ""}`}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className="font-medium text-sm">{title}</span>
                {d.supersededBy && <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-amber-400">reversed</Badge>}
              </div>
              {d.supersededReason && <div className="text-[11px] text-amber-400/80 mb-1.5">{d.supersededReason}</div>}
              <pre className="whitespace-pre-wrap font-mono text-[11px] text-muted-foreground leading-relaxed">{d.content}</pre>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}

// ── Search: live semantic recall — exactly what a worker gets back. Superseded notes flagged, not hidden.
export function SearchPanel({ project }: { project: string }) {
  const [q, setQ] = useState("")
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const req = useRef(0)
  // Results are per-project — clear them (and invalidate any in-flight search) when the picker changes,
  // so another project's hits never linger. Same request-id guard as usePoll; kept manual because search
  // is user-triggered, not polled.
  useEffect(() => { req.current++; setResults(null); setError(null); setBusy(false) }, [project])
  const run = async () => {
    if (!q.trim()) return
    const id = ++req.current
    setBusy(true)
    setError(null)
    try {
      const r = await search(q, project)
      if (id === req.current) setResults(r.results)
    } catch (e) {
      // A failed search is an error, not an empty brain — don't render it as "nothing found".
      if (id === req.current) { setResults(null); setError((e as Error).message) }
    } finally {
      if (id === req.current) setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader className="pb-3"><CardTitle>Search <span className="text-xs font-normal text-muted-foreground">semantic recall — what a worker sees</span></CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={(e) => { e.preventDefault(); run() }} className="flex gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="how do we authenticate users?" className="max-sm:h-10" />
          <Button type="submit" disabled={busy} className="max-sm:h-10">{busy ? "…" : "search"}</Button>
        </form>
        {error && <p className="text-sm text-destructive">can't reach oracle-lite ({error}).</p>}
        <ul className="space-y-2">
          {results?.length === 0 && <li className="text-sm text-muted-foreground">nothing in the brain for that query.</li>}
          {results?.map((r) => (
            <li key={r.id} className="text-sm border rounded-md p-2.5">
              <div className="flex items-center gap-2 mb-1 text-[11px] text-muted-foreground">
                {r.superseded_by && <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-amber-400">superseded</Badge>}
                {r.score != null && <span className="tabular-nums">score {r.score.toFixed(3)}</span>}
                <span className="font-mono truncate">{r.id}</span>
              </div>
              <p className="text-muted-foreground">{r.content}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  )
}
