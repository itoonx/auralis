import { useCallback, useEffect, useState, type ReactNode } from "react"
import { Activity, Database, GitBranch, Network, Pause, Play, RefreshCw } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DecisionsPanel, GraphPanel, RunsPanel, SearchPanel, TimingPanel } from "@/components/panels"
import { getDocs, getProjects, getStats, getTimeline, scorecard, type Finding, type ProjectInfo, type Stats, type TimelineEvent } from "@/lib/api"

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
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [tick, setTick] = useState(0)
  const [runSel, setRunSel] = useState("") // "" = newest run for the project
  const [events, setEvents] = useState<TimelineEvent[]>([])
  const [runId, setRunId] = useState("")
  const [stats, setStats] = useState<Stats | null>(null)
  const [docs, setDocs] = useState<Finding[]>([])
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState(true)
  const [updatedAt, setUpdatedAt] = useState("")

  useEffect(() => { document.documentElement.classList.add("dark") }, [])

  // Discover which projects actually have data and default to the most-active one, so the dashboard isn't
  // blank on load (the old hardcoded "default" project is almost always empty). Refreshes with the live tick.
  useEffect(() => {
    getProjects().then(({ projects }) => {
      setProjects(projects)
      setProject((p) => p || projects[0]?.project || "default")
    }).catch(() => {})
  }, [tick])

  const load = useCallback(async () => {
    if (!project) return // wait until the project picker has resolved (avoids a blank project= query)
    try {
      const [tl, st, dc] = await Promise.all([getTimeline(project, runSel || undefined), getStats(project), getDocs(project)])
      setEvents(tl.events)
      setRunId(tl.run ?? "")
      setStats(st)
      setDocs(dc.docs)
      setError(null)
      setUpdatedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setError((e as Error).message)
    }
  }, [project, runSel])

  useEffect(() => { load() }, [load, tick])
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTick((t) => t + 1), 3000)
    return () => clearInterval(id)
  }, [live])

  const sc = scorecard(events)

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b sticky top-0 z-10 bg-background/80 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-3 flex items-center gap-4">
          <div className="flex items-center gap-2 font-semibold">
            <Activity className="size-5 text-primary" /> auralis
            <span className="text-muted-foreground font-normal text-sm">· brain</span>
          </div>
          <div className="flex-1" />
          <Select
            value={project}
            onValueChange={(v: string | null) => { setProject(v ?? ""); setRunSel("") }}
            items={projects.map((p) => ({ value: p.project, label: `${p.project} · ${p.docs} docs${p.events ? ` · ${p.events} ev` : ""}` }))}
          >
            <SelectTrigger className="w-64" title="project (only those with data are listed)">
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
          <Button variant="outline" size="sm" onClick={() => setLive((v) => !v)}>
            {live ? <Pause className="size-4" /> : <Play className="size-4" />}
            {live ? "live" : "paused"}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => setTick((t) => t + 1)} title="refresh">
            <RefreshCw className="size-4" />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl p-6 space-y-6">
        {error && (
          <Card className="border-destructive/50">
            <CardContent className="py-3 text-sm text-destructive">
              can't reach oracle-lite ({error}). start it with <code className="font-mono">pnpm oracle</code> or run <code className="font-mono">pnpm dev</code>.
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Stat icon={<Database className="size-5" />} label="findings" value={stats?.count ?? "–"} />
          <Stat icon={<Network className="size-5" />} label="graph nodes" value={stats?.nodes ?? "–"} />
          <Stat icon={<GitBranch className="size-5" />} label="edges" value={stats?.edges ?? "–"} />
          <Stat icon={<Activity className="size-5" />} label="recall" value={stats?.embedder ?? "–"} sub={stats?.vectors ? "vectors" : "fts"} />
        </div>

        <Tabs defaultValue="activity" className="space-y-4">
          <TabsList>
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
                  <div className="flex items-center gap-1.5 text-xs">
                    <Badge variant="secondary">{sc.tasks} tasks</Badge>
                    <Badge variant="secondary" className="text-amber-400">deduped {sc.deduped}</Badge>
                    <Badge variant="secondary" className="text-red-400">overlaps {sc.overlaps}</Badge>
                    <Badge variant="secondary" className="text-orange-400">repairs {sc.repairs}</Badge>
                    <Badge variant="secondary" className="text-violet-400">notes {sc.notes}</Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="font-mono truncate">{runId || "—"}</span>
                  {runSel && <button className="text-primary underline" onClick={() => setRunSel("")}>back to latest</button>}
                </div>
              </CardHeader>
              <Separator />
              <CardContent className="p-0">
                <ScrollArea className="h-[60vh]">
                  <ol className="divide-y">
                    {events.length === 0 && (
                      <li className="p-6 text-sm text-muted-foreground">
                        no events yet — run <code className="font-mono">pnpm dev</code> against a repo, then watch them land here.
                      </li>
                    )}
                    {events.map((e) => {
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
                    {docs.map((d) => (
                      <li key={d.id} className="px-4 py-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          {d.tier === "distilled" && <Badge className="h-4 px-1.5 text-[10px]">vetted</Badge>}
                          <span className="font-mono text-[11px] text-muted-foreground truncate">{d.id}</span>
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-3">{d.content}</p>
                      </li>
                    ))}
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
