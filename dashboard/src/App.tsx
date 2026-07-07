import { useEffect, useState, type ReactNode } from "react"
import { Activity, Database, GitBranch, Network, Pause, Play, RefreshCw } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DecisionsPanel, GraphPanel, RunsPanel, SearchPanel, TimingPanel } from "@/components/panels"
import { getDocs, getProjects, getStats, getTimeline, scorecard } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"

// Glyph + accent per event kind — mirrors the CLI reader so the timeline reads the same in both places.
const KIND: Record<string, { glyph: string; cls: string }> = {
  phase: { glyph: "━", cls: "text-muted-foreground" },
  intent: { glyph: "▸", cls: "text-blue-400" },
  note: { glyph: "✎", cls: "text-violet-400" },
  finding: { glyph: "✓", cls: "text-emerald-400" },
  dedup: { glyph: "⇄", cls: "text-amber-400" },
  overlap: { glyph: "⚠", cls: "text-red-400" },
  repair: { glyph: "↻", cls: "text-orange-400" },
  // Session capture + worker tool steps: what the human asked, each tool action, and the answer.
  prompt: { glyph: "🗣", cls: "text-sky-400" },
  trace: { glyph: "»", cls: "text-muted-foreground" },
  answer: { glyph: "✦", cls: "text-emerald-300" },
}
const clock = (ts?: string) => (ts ?? "").slice(11, 19) || "--:--:--"

// Findings carry their provenance — badge per source family (mirrors the trust tiers at the ingress).
function sourceBadge(source: string): { label: string; cls: string } {
  if (source.startsWith("human")) return { label: "human", cls: "text-sky-300" }
  if (source === "auralis:retro") return { label: "retro", cls: "text-orange-300" }
  if (source === "auralis:decision") return { label: "decision", cls: "text-violet-300" }
  if (source === "auralis:distilled") return { label: "distilled", cls: "text-emerald-300" }
  if (source === "session:assistant") return { label: "assistant", cls: "text-muted-foreground" }
  if (source.startsWith("auralis:worker")) return { label: source.replace("auralis:worker:", "worker·"), cls: "text-muted-foreground" }
  return { label: source || "note", cls: "text-muted-foreground" }
}

function ago(iso?: string): string {
  if (!iso) return ""
  const s = (Date.now() - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return ""
  if (s < 90) return `${Math.max(1, Math.round(s))}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 129600) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

function Stat({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-4">
        <div className="text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <div className="text-2xl font-semibold leading-none">{value}</div>
          <div className="text-xs text-muted-foreground mt-1">{label}{sub ? ` · ${sub}` : ""}</div>
        </div>
      </CardContent>
    </Card>
  )
}

export default function App() {
  const [project, setProject] = useState("")
  const [tick, setTick] = useState(0)
  const [runSel, setRunSel] = useState("") // "" = newest run for the project
  const [live, setLive] = useState(true)
  const [showTraces, setShowTraces] = useState(false)

  useEffect(() => { document.documentElement.classList.add("dark") }, [])

  // Discover which projects actually have data and default to the most-active one, so the dashboard isn't
  // blank on load (the old hardcoded "default" project is almost always empty). Refreshes with the live tick.
  const pr = usePoll(getProjects, [tick])
  const projects = pr.data?.projects ?? []
  useEffect(() => {
    if (pr.data) setProject((p) => p || pr.data?.projects[0]?.project || "default")
  }, [pr.data])

  // The main slice — disabled (null fetcher) until the project picker has resolved.
  const main = usePoll(
    project ? () => Promise.all([getTimeline(project, runSel || undefined), getStats(project), getDocs(project)]) : null,
    [project, runSel, tick],
  )
  const [tl, stats, dc] = main.data ?? [null, null, null]
  const events = tl?.events ?? []
  const runId = tl?.run ?? ""
  const docs = dc?.docs ?? []
  const updatedAt = main.at
  // Either failing fetch means the brain is unreachable — surface it (a dead oracle used to render a
  // silently blank dashboard, because the main load never ran without a resolved project).
  const error = pr.error ?? main.error

  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTick((t) => t + 1), 3000)
    return () => clearInterval(id)
  }, [live])

  const sc = scorecard(events)
  // Newest first — the feed must open on what just happened, not on hours-old traces. Tool-step traces are
  // detail-on-demand: counted, hidden by default (they drown prompts/findings), one tap to show.
  const nPrompts = events.filter((e) => e.kind === "prompt").length
  const nAnswers = events.filter((e) => e.kind === "answer").length
  const nTraces = events.filter((e) => e.kind === "trace").length
  const visible = [...events].reverse().filter((e) => showTraces || e.kind !== "trace")

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b sticky top-0 z-10 bg-background/80 backdrop-blur">
        {/* Wraps on narrow screens: brand + controls stay on row one, the project picker drops to its own
            full-width row (it's the primary scoping control — truncating it to a sliver would be worse). */}
        <div className="mx-auto max-w-6xl px-4 sm:px-6 py-3 flex flex-wrap items-center gap-x-3 gap-y-2 sm:gap-x-4">
          <div className="flex items-center gap-2 font-semibold shrink-0">
            <Activity className="size-5 text-primary" /> auralis
            <span className="text-muted-foreground font-normal text-sm">· brain</span>
          </div>
          <div className="flex-1" />
          <Select
            value={project}
            onValueChange={(v: string | null) => { setProject(v ?? ""); setRunSel("") }}
            items={projects.map((p) => ({ value: p.project, label: `${p.project} · ${p.docs} docs${p.events ? ` · ${p.events} ev` : ""}` }))}
          >
            <SelectTrigger className="order-last w-full max-sm:h-10 sm:order-none sm:w-64" title="project (only those with data are listed)">
              <SelectValue placeholder={projects.length ? "select project" : "no projects with data"} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.project} value={p.project}>
                  {p.project} <span className="text-muted-foreground">· {p.docs} docs{p.events ? ` · ${p.events} ev` : ""}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* max-sm:h-10 = comfortable touch targets on phones without changing the desktop density. */}
          <Button variant="outline" size="sm" className="max-sm:h-10" onClick={() => setLive((v) => !v)}>
            {live ? <Pause className="size-4" /> : <Play className="size-4" />}
            {live ? "live" : "paused"}
          </Button>
          <Button variant="ghost" size="icon" className="max-sm:size-10" onClick={() => setTick((t) => t + 1)} title="refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-4 sm:p-6 space-y-6">
        {error && (
          <Card className="border-destructive/50">
            <CardContent className="py-3 text-sm text-destructive">
              can't reach oracle-lite ({error}). start it with <code className="font-mono">pnpm oracle</code> or run <code className="font-mono">pnpm dev</code>.
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat icon={<Database className="size-5" />} label="findings" value={stats?.count ?? "–"} sub={stats?.seen ? `cited ${stats.cited ?? 0} / seen ${stats.seen} (${(((stats.cited ?? 0) / stats.seen) * 100).toFixed(0)}%)` : undefined} />
          <Stat icon={<Network className="size-5" />} label="graph nodes" value={stats?.nodes ?? "–"} />
          <Stat icon={<GitBranch className="size-5" />} label="edges" value={stats?.edges ?? "–"} />
          <Stat icon={<Activity className="size-5" />} label="recall" value={stats?.embedder ?? "–"} sub={stats?.vectors ? "vectors" : "fts"} />
        </div>

        <Tabs defaultValue="activity" className="space-y-4">
          {/* Six triggers don't fit a phone; scroll the bar instead of wrapping it (single-row nav).
              The scrollbar is hidden — the clipped last trigger is the affordance that there's more. */}
          <TabsList className="max-w-full justify-start overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="timing">Timing</TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="decisions">Decisions</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
          </TabsList>

          <TabsContent value="activity" className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-0">
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="flex items-center gap-2">
                    Activity Timeline
                    {updatedAt && <span className="text-xs font-normal text-muted-foreground">updated {updatedAt}</span>}
                  </CardTitle>
                  <div className="flex items-center gap-1.5 text-xs flex-wrap">
                    {sc.tasks > 0 && <Badge variant="secondary">{sc.tasks} tasks</Badge>}
                    {sc.deduped > 0 && <Badge variant="secondary" className="text-amber-400">deduped {sc.deduped}</Badge>}
                    {sc.overlaps > 0 && <Badge variant="secondary" className="text-red-400">overlaps {sc.overlaps}</Badge>}
                    {sc.repairs > 0 && <Badge variant="secondary" className="text-orange-400">repairs {sc.repairs}</Badge>}
                    {sc.notes > 0 && <Badge variant="secondary" className="text-violet-400">notes {sc.notes}</Badge>}
                    {nPrompts > 0 && <Badge variant="secondary" className="text-sky-400">🗣 {nPrompts}</Badge>}
                    {nAnswers > 0 && <Badge variant="secondary" className="text-emerald-300">✦ {nAnswers}</Badge>}
                    {nTraces > 0 && (
                      <button
                        className={`rounded-md border px-2 py-0.5 ${showTraces ? "text-foreground" : "text-muted-foreground"}`}
                        onClick={() => setShowTraces((v) => !v)}
                        title="tool steps (Read/Write per action) — detail on demand"
                      >
                        » {nTraces} {showTraces ? "shown" : "hidden"}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono truncate min-w-0">{runId || "—"}</span>
                  {runSel && <button className="text-primary underline" onClick={() => setRunSel("")}>back to latest</button>}
                </div>
              </CardHeader>
              <Separator />
              <CardContent className="p-0">
                <ScrollArea className="h-[60vh]">
                  <ol className="divide-y">
                    {visible.length === 0 && (
                      <li className="p-6 text-sm text-muted-foreground">
                        no events yet — run <code className="font-mono">pnpm dev</code> against a repo, then watch them land here.
                      </li>
                    )}
                    {visible.map((e) => {
                      const k = KIND[e.kind] ?? { glyph: "·", cls: "text-muted-foreground" }
                      return (
                        <li key={e.seq} className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/40">
                          <span className="font-mono text-xs text-muted-foreground pt-0.5 tabular-nums">{clock(e.ts)}</span>
                          <span className={`font-mono text-base leading-none pt-0.5 ${k.cls}`}>{k.glyph}</span>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm">{e.human.replace(/^\S+\s/, "")}</div>
                            <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                              <span className={k.cls}>{e.kind}</span>
                              {e.nodeId && <span className="font-mono">· {e.nodeId}{e.parentNode?.length ? ` ← ${e.parentNode.join(",")}` : ""}</span>}
                              {e.refs?.length ? <span className="font-mono truncate">· {e.refs.join(", ")}</span> : null}
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ol>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Findings <span className="text-xs font-normal text-muted-foreground">in the brain</span></CardTitle>
              </CardHeader>
              <Separator />
              <CardContent className="p-0">
                <ScrollArea className="h-[60vh]">
                  <ul className="divide-y">
                    {docs.length === 0 && <li className="p-6 text-sm text-muted-foreground">no findings for this project yet.</li>}
                    {docs.map((d) => {
                      const src = sourceBadge(d.source ?? "")
                      return (
                        <li key={d.id} className="px-4 py-2.5">
                          <div className="flex items-center gap-1.5 mb-1 flex-wrap">
                            <Badge variant="secondary" className={`h-4 px-1.5 text-[10px] ${src.cls}`}>{src.label}</Badge>
                            {d.tier === "distilled" && <Badge className="h-4 px-1.5 text-[10px]">vetted</Badge>}
                            {d.pinned && <span title="pinned — never forgotten">📌</span>}
                            {d.archived && <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-muted-foreground">archived</Badge>}
                            <span className="text-[10px] text-muted-foreground" title="trust prior (by source)">trust {(d.trust ?? 0.5).toFixed(2)}</span>
                            {(d.timesUsed ?? 0) > 0 && <span className="text-[10px] text-emerald-300" title="cited as materially helpful">cited ×{d.timesUsed}</span>}
                            {(d.retrieved ?? 0) > 0 && <span className="text-[10px] text-muted-foreground" title="times served by recall">seen ×{d.retrieved}</span>}
                            <span className="text-[10px] text-muted-foreground ml-auto">{ago(d.createdAt)}</span>
                          </div>
                          <details className="group">
                            <summary className="cursor-pointer list-none text-sm text-muted-foreground">
                              <span className="group-open:hidden line-clamp-3">{d.content}</span>
                              <span className="hidden group-open:block whitespace-pre-wrap text-foreground/90">{d.content}</span>
                            </summary>
                          </details>
                          <div className="mt-1 font-mono text-[10px] text-muted-foreground/70 truncate">{d.id}</div>
                        </li>
                      )
                    })}
                  </ul>
                </ScrollArea>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="timing" className="mt-0"><TimingPanel tick={tick} /></TabsContent>
          <TabsContent value="runs" className="mt-0"><RunsPanel project={project} tick={tick} selected={runSel} onSelect={setRunSel} /></TabsContent>
          <TabsContent value="graph" className="mt-0"><GraphPanel project={project} tick={tick} /></TabsContent>
          <TabsContent value="decisions" className="mt-0"><DecisionsPanel project={project} tick={tick} /></TabsContent>
          <TabsContent value="search" className="mt-0"><SearchPanel project={project} /></TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
