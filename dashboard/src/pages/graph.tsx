// Graph: the whole knowledge graph as a full-bleed force view — the canvas takes the entire page area and
// the controls float over it (backdrop-blurred), like a map UI. The panels carry the honesty and keyboard
// paths the canvas alone can't provide: a "showing N of M" header that matches the stat cards, a
// find-a-node box (the graph used to be 100% pointer-operated), the top hubs as a ranked list (what the
// old giant discs were trying to say), and an inspector for the selected node.
import { useMemo, useState } from "react"
import { Network, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { ErrorStrip, SectionTitle } from "@/components/bits"
import { ForceGraph } from "@/components/force-graph"
import { getGraphAll, type GraphAllEdge, type Stats } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { cn } from "@/lib/utils"

// The floating panels share one look: translucent card + backdrop blur, so the graph stays visible.
const FLOAT = "bg-card/70 backdrop-blur-sm"

export function GraphPage({ project, tick, stats }: { project: string; tick: number; stats: Stats | null }) {
  const [limit, setLimit] = useState(400)
  const { data, error } = usePoll(project ? (s) => getGraphAll(project, limit, s) : null, [project, tick, limit])
  // Every poll returns a fresh array; keying the memo on content keeps the reference stable when the
  // graph hasn't actually changed, so ForceGraph doesn't rebuild (and reheat its simulation) each tick.
  const edgesKey = JSON.stringify(data?.edges ?? [])
  const edges = useMemo(() => JSON.parse(edgesKey) as GraphAllEdge[], [edgesKey])

  const [sel, setSel] = useState("")
  const [find, setFind] = useState("")
  const [focus, setFocus] = useState<{ seq: number; key: string } | null>(null)
  const [allEdges, setAllEdges] = useState(false)

  const nodeList = useMemo(() => {
    const m = new Map<string, { key: string; label: string; deg: number }>()
    for (const e of edges) {
      for (const [k, label] of [[e.subj_key, e.subject], [e.obj_key, e.object]] as const) {
        const n = m.get(k) ?? { key: k, label, deg: 0 }
        n.deg++
        m.set(k, n)
      }
    }
    return [...m.values()].sort((a, b) => b.deg - a.deg)
  }, [edges])

  const hubs = nodeList.slice(0, 8)
  const selNode = nodeList.find((n) => n.key === sel) ?? null
  const nbr = sel ? edges.filter((e) => e.subj_key === sel || e.obj_key === sel) : []
  const matches = find.trim()
    ? nodeList.filter((n) => n.label.toLowerCase().includes(find.trim().toLowerCase())).slice(0, 8)
    : []

  // Select + center — used by the find box and the hubs list. Canvas clicks only select (no view yank).
  const jumpTo = (key: string) => {
    setSel(key)
    setFocus((f) => ({ seq: (f?.seq ?? 0) + 1, key }))
    setFind("")
  }

  // Honest counts: the same totals as the overview stat card, with the cap stated inline when it bites.
  const totalEdges = stats?.edges
  const capped = totalEdges != null && edges.length < totalEdges
  const counts = totalEdges != null
    ? `showing ${edges.length}${capped ? ` of ${totalEdges}` : ""} edges · ${nodeList.length}${stats?.nodes && nodeList.length < stats.nodes ? ` of ${stats.nodes}` : ""} nodes`
    : `${nodeList.length} nodes · ${edges.length} edges`

  // Order swapped on request: hubs (orientation) above the inspector (drill-down).
  const panels = (
    <>
      <Card size="sm" className={FLOAT}>
        <CardHeader className="pb-1">
          <SectionTitle className="text-sm">find a node</SectionTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && matches[0]) jumpTo(matches[0].key) }}
              placeholder="type a name…"
              aria-label="find a node by name"
              className="bg-background/50 pl-8"
            />
          </div>
          {matches.length > 0 && (
            <ul className="space-y-0.5">
              {matches.map((m) => (
                <li key={m.key}>
                  <button
                    type="button"
                    onClick={() => jumpTo(m.key)}
                    className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                  >
                    <span className="min-w-0 truncate font-mono">{m.label}</span>
                    <span className="shrink-0 text-muted-foreground">deg {m.deg}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {find.trim() && matches.length === 0 && <p className="px-1 text-xs text-muted-foreground">no node matches "{find.trim()}".</p>}
        </CardContent>
      </Card>

      <Card size="sm" className={FLOAT}>
        <CardHeader className="pb-1">
          <SectionTitle className="text-sm" sub="most-connected entities">top hubs</SectionTitle>
        </CardHeader>
        <CardContent>
          <ol className="space-y-0.5">
            {hubs.map((h, i) => (
              <li key={h.key}>
                <button
                  type="button"
                  onClick={() => jumpTo(h.key)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                    sel === h.key && "bg-primary/10 text-primary",
                  )}
                >
                  <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{h.label}</span>
                  <Badge variant="secondary" className="h-4 shrink-0 px-1.5 text-[10px] tabular-nums">deg {h.deg}</Badge>
                </button>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card size="sm" className={FLOAT}>
        <CardHeader className="pb-1">
          <SectionTitle className="text-sm" sub={selNode ? `deg ${selNode.deg}` : undefined}>
            {selNode ? <span className="font-mono">{selNode.label}</span> : "inspector"}
          </SectionTitle>
        </CardHeader>
        <CardContent>
          {!selNode ? (
            <p className="text-xs text-muted-foreground">click a node — or find one above — to list its edges here.</p>
          ) : (
            <ul className="space-y-1 font-mono text-xs">
              {nbr.slice(0, 12).map((e, i) => (
                <li key={i} className="truncate" title={`${e.subject} —${e.predicate}→ ${e.object}`}>
                  <span className={e.subj_key === sel ? "text-foreground" : ""}>{e.subject}</span>
                  <span className="text-violet-400"> —{e.predicate}→ </span>
                  <span className={e.obj_key === sel ? "text-foreground" : ""}>{e.object}</span>
                </li>
              ))}
              {nbr.length > 12 && <li className="text-muted-foreground">… {nbr.length - 12} more edges</li>}
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  )

  if (edges.length === 0) {
    return (
      <Card className="flex h-[calc(100svh-140px)] min-h-[420px] items-center justify-center">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Network aria-hidden /></EmptyMedia>
            <EmptyTitle>no graph yet</EmptyTitle>
            <EmptyDescription>run <code className="font-mono">pnpm build-graph</code> to extract entities and edges from the brain.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Full-bleed canvas; everything else floats over it. */}
      <div className="relative h-[55svh] md:h-[calc(100svh-140px)] md:min-h-[520px]">
        <ForceGraph edges={edges} selected={sel} focus={focus} onSelect={setSel} className="h-full" />

        {/* Floating header — title, honest counts, cap escape hatch. */}
        <div className="pointer-events-none absolute top-3 left-3 max-w-[calc(100%-1.5rem)] space-y-2 md:max-w-[calc(100%-22rem)]">
          <div className={`pointer-events-auto rounded-xl px-4 py-2.5 ring-1 ring-foreground/10 ${FLOAT}`}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <SectionTitle sub={counts}>knowledge graph</SectionTitle>
              {capped && (
                <Button variant="outline" size="xs" className="bg-background/50" onClick={() => { setLimit(2000); setAllEdges(true) }} disabled={allEdges}>
                  {allEdges ? "loaded server max" : "load all"}
                </Button>
              )}
            </div>
            <p className="mt-0.5 hidden text-xs text-muted-foreground sm:block">drag to pin · double-click to unpin · wheel to zoom · Tab walks nodes, Enter selects</p>
          </div>
          {error && <div className="pointer-events-auto"><ErrorStrip what="graph" error={error} /></div>}
        </div>

        {/* Floating panels (desktop): find → hubs → inspector, scrolling within the canvas height. */}
        <div className="pointer-events-none absolute top-3 right-3 bottom-3 hidden w-80 md:block">
          <div className="pointer-events-auto flex max-h-full flex-col gap-3 overflow-y-auto pr-0.5">{panels}</div>
        </div>
      </div>

      {/* Phones: the same panels in normal flow — floating would bury the graph at 375px. */}
      <div className="space-y-3 md:hidden">{panels}</div>
    </div>
  )
}
