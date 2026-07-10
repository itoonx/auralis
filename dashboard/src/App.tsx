// The studio shell: header (project scope, live state, one clock) + left rail nav on desktop / bottom
// tab bar on phones, with one page mounted at a time. IA note: "timing" is not a top-level page — the
// timing sink is process-wide, so it lives inside the Runs page, labeled honestly, instead of posing as
// a project-scoped tab. The rail replaced a scrolling tab row that clipped on phones.
import { useEffect, useState, type ReactNode } from "react"
import { Activity, History, LayoutDashboard, ListChecks, Network, Pause, Play, RefreshCw, Search } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Toggle } from "@/components/ui/toggle"
import { getDocs, getProjects, getStats, getTimeline } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { clock } from "@/lib/time"
import { cn } from "@/lib/utils"
import { OverviewPage } from "@/pages/overview"
import { RunsPage } from "@/pages/runs"
import { GraphPage } from "@/pages/graph"
import { DecisionsPage } from "@/pages/decisions"
import { SearchPage } from "@/pages/search"

type View = "overview" | "runs" | "graph" | "decisions" | "search"

const VIEWS: View[] = ["overview", "runs", "graph", "decisions", "search"]

// The active page lives in the URL (?tab=runs) so a refresh — or a shared link — lands on the same page.
// Unknown/absent values fall back to overview; the param is dropped there to keep the default URL clean.
const initialView = (): View => {
  const t = new URLSearchParams(window.location.search).get("tab")
  return VIEWS.includes(t as View) ? (t as View) : "overview"
}

const NAV: { view: View; label: string; icon: ReactNode }[] = [
  { view: "overview", label: "overview", icon: <LayoutDashboard className="size-4" aria-hidden /> },
  { view: "runs", label: "runs", icon: <History className="size-4" aria-hidden /> },
  { view: "graph", label: "graph", icon: <Network className="size-4" aria-hidden /> },
  { view: "decisions", label: "decisions", icon: <ListChecks className="size-4" aria-hidden /> },
  { view: "search", label: "search", icon: <Search className="size-4" aria-hidden /> },
]

export default function App() {
  const [project, setProject] = useState("")
  const [view, setView] = useState<View>(initialView)
  const [tick, setTick] = useState(0)
  const [runSel, setRunSel] = useState("") // "" = newest run for the project
  const [live, setLive] = useState(true)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => { document.documentElement.classList.add("dark") }, [])
  // Mirror the active page into ?tab= (replace, not push — switching pages shouldn't grow history).
  useEffect(() => {
    const u = new URL(window.location.href)
    if (view === "overview") u.searchParams.delete("tab")
    else u.searchParams.set("tab", view)
    window.history.replaceState(null, "", u)
  }, [view])
  // One ticking clock drives both the header time and the stale check — same second, same source.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (!live) return
    const id = setInterval(() => setTick((t) => t + 1), 3000)
    return () => clearInterval(id)
  }, [live])

  // Discover which projects actually have data and default to the most-active one, so the dashboard isn't
  // blank on load (the old hardcoded "default" project is almost always empty). Refreshes with the live tick.
  const pr = usePoll((s) => getProjects(s), [tick])
  const projects = pr.data?.projects ?? []
  useEffect(() => {
    if (pr.data) setProject((p) => p || pr.data?.projects[0]?.project || "default")
  }, [pr.data])

  // The main slice — disabled (null fetcher) until the project picker has resolved. Polled here in the
  // shell (not in the overview page) because its freshness is what the header's live/stale state reports.
  const main = usePoll(
    project ? (s) => Promise.all([getTimeline(project, runSel || undefined, s), getStats(project, s), getDocs(project, s)]) : null,
    [project, runSel, tick],
  )
  const [tl, stats, dc] = main.data ?? [null, null, null]

  // Stale = live is on but nothing has landed for >2 poll ticks (+ fetch headroom). The old UI kept the
  // "live" light on while silently frozen; now the header says which one is true.
  const staleMs = live && main.atMs ? now - main.atMs : 0
  const stale = staleMs > 8_000
  const liveState = !live ? "updates paused" : stale ? "updates stalled — retrying" : "live"

  return (
    <div className="min-h-svh bg-background text-foreground">
      {/* Screen-reader status: announces live/paused/stalled transitions without visual noise. */}
      <div aria-live="polite" className="sr-only">{liveState}</div>

      <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6">
          <h1 className="shrink-0 font-heading text-[15px] font-semibold">
            {/* The brand is the "home" affordance: back to overview, unscoped. Real <a href="/"> so
                middle/cmd-click still opens a fresh tab; plain clicks stay in the SPA (no reload). */}
            <a
              href="/"
              className="flex items-center gap-2 rounded focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                e.preventDefault()
                setView("overview")
                setRunSel("")
              }}
            >
              <Activity className="size-5 text-primary" aria-hidden />
              auralis <span className="text-sm font-normal text-muted-foreground">· studio</span>
            </a>
          </h1>
          <div className="flex-1" />
          {/* One vocabulary everywhere: findings + events (the stat cards and pages say the same words). */}
          <Select
            value={project}
            onValueChange={(v: string | null) => { setProject(v ?? ""); setRunSel("") }}
            items={projects.map((p) => ({ value: p.project, label: `${p.project} · ${p.docs} findings${p.events ? ` · ${p.events} events` : ""}` }))}
          >
            <SelectTrigger className="order-last w-full max-sm:h-10 sm:order-none sm:w-72" title="project — only those with data are listed">
              <SelectValue placeholder={projects.length ? "select project" : "no projects with data"} />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.project} value={p.project}>
                  {p.project} <span className="text-muted-foreground">· {p.docs} findings{p.events ? ` · ${p.events} events` : ""}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {stale && (
            <Badge variant="outline" className="border-amber-400/40 text-amber-300" title="live is on but no update has landed — the brain may be busy or unreachable">
              stale {Math.round(staleMs / 1000)}s
            </Badge>
          )}
          {/* max-sm:h-10 = comfortable touch targets on phones without changing the desktop density. */}
          <Toggle
            variant="outline"
            size="sm"
            className={cn("max-sm:h-10", live && !stale && "border-primary/30 text-primary aria-pressed:bg-primary/10")}
            pressed={live}
            onPressedChange={setLive}
            aria-label={live ? "pause live updates" : "resume live updates"}
          >
            {live ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
            {live ? "live" : "paused"}
          </Toggle>
          <Button variant="ghost" size="icon" className="max-sm:size-10" onClick={() => setTick((t) => t + 1)} title="refresh now" aria-label="refresh now">
            <RefreshCw className="size-4" aria-hidden />
          </Button>
          <span
            className="hidden font-mono text-xs text-muted-foreground tabular-nums sm:inline"
            title="your local time, 24h — every timestamp below uses this clock"
          >
            {clock(now)}
          </span>
        </div>
      </header>

      <div className="flex">
        {/* Left rail — desktop nav. On phones the same items live in the bottom tab bar. */}
        <nav aria-label="studio pages" className="sticky top-[57px] hidden h-[calc(100svh-57px)] w-48 shrink-0 flex-col gap-1 self-start border-r px-3 py-4 md:flex">
          {NAV.map((n) => (
            <Button
              key={n.view}
              variant="ghost"
              aria-current={view === n.view ? "page" : undefined}
              onClick={() => setView(n.view)}
              className={cn(
                "w-full justify-start gap-2.5",
                view === n.view ? "bg-primary/10 font-medium text-primary hover:bg-primary/15 hover:text-primary" : "text-muted-foreground",
              )}
            >
              {n.icon}
              {n.label}
            </Button>
          ))}
          <div className="flex-1" />
          {/* Brain health, labeled — this used to be a stat card shouting "builtin" with no context. */}
          <Card size="sm" className="bg-card/60">
            <CardContent className="space-y-1 text-xs">
              <div className="font-medium text-muted-foreground">brain</div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">recall engine</span>
                <span className="truncate font-mono">{stats?.embedder ?? "—"}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">vector index</span>
                <span className={stats?.vectors ? "text-primary" : "text-muted-foreground"}>{stats ? (stats.vectors ? "ok" : "fts only") : "—"}</span>
              </div>
            </CardContent>
          </Card>
        </nav>

        <main className="min-w-0 flex-1 p-4 pb-24 sm:p-6 md:pb-6">
          {/* Projects failing means the whole brain is unreachable — that one is global, not per-panel. */}
          {pr.error && (
            <Card className="mb-4 ring-destructive/40">
              <CardContent className="py-3 text-sm text-destructive">
                can't reach oracle-lite ({pr.error}). start it with <code className="font-mono">pnpm oracle</code> or run <code className="font-mono">pnpm dev</code>.
              </CardContent>
            </Card>
          )}

          {view === "overview" && (
            <OverviewPage
              project={project}
              tick={tick}
              tl={tl}
              stats={stats}
              docs={dc?.docs ?? []}
              error={main.error}
              updatedAtMs={main.atMs}
              runSel={runSel}
              onClearRun={() => setRunSel("")}
            />
          )}
          {view === "runs" && (
            <RunsPage
              project={project}
              tick={tick}
              selected={runSel}
              onSelect={setRunSel}
              onOpenInFeed={(id) => { setRunSel(id); setView("overview") }}
              tl={tl}
            />
          )}
          {view === "graph" && <GraphPage project={project} tick={tick} stats={stats} />}
          {view === "decisions" && <DecisionsPage project={project} tick={tick} />}
          {view === "search" && <SearchPage project={project} />}
        </main>
      </div>

      {/* Bottom tab bar — thumb reach on phones; replaces the cramped scrolling tab row. */}
      <nav aria-label="studio pages" className="fixed inset-x-0 bottom-0 z-20 flex border-t bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
        {NAV.map((n) => (
          <button
            key={n.view}
            type="button"
            aria-current={view === n.view ? "page" : undefined}
            onClick={() => setView(n.view)}
            className={cn(
              "flex flex-1 flex-col items-center gap-1 py-2 text-[10px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
              view === n.view ? "text-primary" : "text-muted-foreground",
            )}
          >
            {n.icon}
            {n.label}
          </button>
        ))}
      </nav>
    </div>
  )
}
