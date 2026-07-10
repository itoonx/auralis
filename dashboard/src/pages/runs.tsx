// Runs: history + per-run scorecard, with the selected run opened *on this page* (selecting a row used to
// silently rewrite the overview feed on another tab, with an invisible 8/255 background bump as the only
// feedback). Selection is loud here — outline + "viewing" badge — and "open in overview feed" makes the
// cross-page effect an explicit action instead of a side effect.
import { ArrowRight, History } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { CopyButton, ErrorStrip, InfoTip, KindChip, Num, SectionTitle } from "@/components/bits"
import { getRuns, getTiming, type RunSummary, type TimelineEvent } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { clock, dateTime, fmtDur, fmtMs } from "@/lib/time"
import { cn } from "@/lib/utils"

const TIPS = {
  tasks: "distinct task nodes the fleet worked on in this run",
  deduped: "duplicate work caught before it ran twice — the brain paying for itself",
  overlaps: "two workers touched the same target — a coordination miss worth reading",
  repairs: "a worker repaired another worker's output",
  pa: "session-capture runs: prompts the human sent · answers recorded (fleet counters don't apply to them)",
}

// Session-capture runs have prompts/answers; fleet runs have task counters. Show whichever is real.
const pa = (r: RunSummary) => ((r.prompts ?? 0) + (r.answers ?? 0) > 0 ? `${r.prompts ?? 0} · ${r.answers ?? 0}` : null)

function ScoreChips({ r }: { r: RunSummary }) {
  const chip = (label: string, v: number | undefined, cls?: string) =>
    (v ?? 0) > 0 && (
      <Badge key={label} variant="outline" className={cn("gap-1 tabular-nums", cls)}>
        {label} <b className="font-semibold">{v}</b>
      </Badge>
    )
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chip("tasks", r.tasks)}
      {chip("deduped", r.deduped, "text-amber-400")}
      {chip("overlaps", r.overlaps, "text-red-400")}
      {chip("repairs", r.repairs, "text-orange-400")}
      {chip("prompts", r.prompts, "text-sky-400")}
      {chip("answers", r.answers, "text-emerald-300")}
      <Badge variant="outline" className="gap-1 tabular-nums">events <b className="font-semibold">{r.events}</b></Badge>
      {r.firstTs !== r.lastTs && <Badge variant="outline" className="gap-1 tabular-nums">wall <b className="font-semibold">{fmtDur(r.firstTs, r.lastTs)}</b></Badge>}
    </div>
  )
}

export function RunsPage({ project, tick, selected, onSelect, onOpenInFeed, tl }: {
  project: string
  tick: number
  selected: string
  onSelect: (runId: string) => void
  onOpenInFeed: (runId: string) => void
  tl: { run: string; events: TimelineEvent[] } | null
}) {
  const { data, error } = usePoll(project ? (s) => getRuns(project, s) : null, [project, tick])
  const runs = data?.runs ?? []
  const selRun = runs.find((r) => r.runId === selected) ?? null

  // The timing sink is per oracle *process* — spans carry no run/project tag, so this section says so
  // instead of posing as run-scoped numbers (it used to hide behind the project picker as a whole tab).
  const tm = usePoll((s) => getTiming(s), [tick])
  const top = tm.data?.phases.reduce((m, p) => Math.max(m, p.total), 0) || 1

  // The shell polls the timeline for the selected run — reuse it for the detail preview (no second fetch).
  const detailEvents = selected && tl?.run === selected ? [...tl.events].reverse().filter((e) => e.kind !== "trace").slice(0, 8) : null

  return (
    <div className="space-y-4 sm:space-y-6">
      <Card>
        <CardHeader className="pb-1">
          <SectionTitle sub="select one to open it below — the overview feed only changes when you send it there">runs</SectionTitle>
          {error && <ErrorStrip what="runs" error={error} />}
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <Empty className="m-4 border">
              <EmptyHeader>
                <EmptyMedia variant="icon"><History aria-hidden /></EmptyMedia>
                <EmptyTitle>no runs yet</EmptyTitle>
                <EmptyDescription>run <code className="font-mono">pnpm dev</code> against a repo — each run lands here with its scorecard.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <>
              {/* Desktop: the full scorecard table. */}
              <div className="max-md:hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>run</TableHead>
                      <TableHead className="text-right">tasks <InfoTip text={TIPS.tasks} /></TableHead>
                      <TableHead className="text-right">deduped <InfoTip text={TIPS.deduped} /></TableHead>
                      <TableHead className="text-right">overlaps <InfoTip text={TIPS.overlaps} /></TableHead>
                      <TableHead className="text-right">repairs <InfoTip text={TIPS.repairs} /></TableHead>
                      <TableHead className="text-right">prompts · answers <InfoTip text={TIPS.pa} /></TableHead>
                      <TableHead className="text-right">events</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((r) => {
                      const isSel = selected === r.runId
                      return (
                        <TableRow
                          key={r.runId}
                          data-state={isSel ? "selected" : undefined}
                          onClick={() => onSelect(r.runId)}
                          className={cn("cursor-pointer", isSel && "bg-primary/8 outline-2 -outline-offset-2 outline-primary/50 hover:bg-primary/10")}
                        >
                          <TableCell className="font-mono text-xs">
                            <div className="flex items-center gap-1.5">
                              {/* The row is clickable for mice; this button is the keyboard path (Tab + Enter). */}
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onSelect(r.runId) }}
                                title={r.runId}
                                className="max-w-[300px] truncate rounded text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                              >
                                {r.runId}
                              </button>
                              {isSel && <Badge className="h-4 shrink-0 px-1.5 text-[10px]">viewing</Badge>}
                            </div>
                            <div className="mt-0.5 text-muted-foreground" title="local time, 24h">{dateTime(r.lastTs)}</div>
                          </TableCell>
                          <TableCell className="text-right"><Num v={r.tasks} /></TableCell>
                          <TableCell className="text-right"><Num v={r.deduped} cls="text-amber-400" /></TableCell>
                          <TableCell className="text-right"><Num v={r.overlaps} cls="font-medium text-red-400" /></TableCell>
                          <TableCell className="text-right"><Num v={r.repairs} cls="text-orange-400" /></TableCell>
                          <TableCell className="text-right">{pa(r) ? <span className="text-sky-400/90 tabular-nums">{pa(r)}</span> : <span className="text-muted-foreground/40">—</span>}</TableCell>
                          <TableCell className="text-right"><Num v={r.events} cls="text-muted-foreground" /></TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
              {/* Phones: cards showing only the values a run actually has — the 7-column table clipped at 375. */}
              <ul className="space-y-2 px-4 pb-1 md:hidden">
                {runs.map((r) => {
                  const isSel = selected === r.runId
                  return (
                    <li key={r.runId}>
                      <button
                        type="button"
                        onClick={() => onSelect(r.runId)}
                        aria-pressed={isSel}
                        className={cn(
                          "w-full rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
                          isSel ? "border-primary/50 bg-primary/8" : "hover:bg-muted/40",
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate font-mono text-xs">{r.runId}</span>
                          {isSel && <Badge className="h-4 shrink-0 px-1.5 text-[10px]">viewing</Badge>}
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">{dateTime(r.lastTs)}</div>
                        <div className="mt-2"><ScoreChips r={r} /></div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 sm:gap-6 lg:grid-cols-2">
        {selRun ? (
          <Card>
            <CardHeader className="pb-1">
              <SectionTitle>run detail</SectionTitle>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={selRun.runId}>{selRun.runId}</span>
                <CopyButton text={selRun.runId} label="copy run id" />
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <ScoreChips r={selRun} />
              <div>
                <h3 className="mb-2 text-xs font-medium text-muted-foreground">latest moments <span className="font-normal">· local 24h · same vocabulary as the overview feed</span></h3>
                {detailEvents ? (
                  <ol className="space-y-1.5">
                    {detailEvents.length === 0 && <li className="text-sm text-muted-foreground">no events beyond tool steps in this run.</li>}
                    {detailEvents.map((e) => (
                      <li key={e.seq} className="flex items-start gap-2.5 text-sm">
                        <span className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums" title={e.ts}>{clock(e.ts)}</span>
                        <KindChip kind={e.kind} />
                        <span className="min-w-0 flex-1 truncate" title={e.human}>{e.human.replace(/^\S+\s/, "")}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="space-y-1.5">
                    {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}
                  </div>
                )}
              </div>
              <Button variant="outline" size="sm" onClick={() => onOpenInFeed(selRun.runId)}>
                open in overview feed <ArrowRight className="size-3.5" aria-hidden />
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed bg-transparent ring-0">
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              select a run above to open its scorecard and latest moments here.
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-1">
            <SectionTitle sub={tm.data ? `wall ${fmtMs(tm.data.wall)} · ${tm.data.spans} spans` : undefined}>
              where time goes
              {" "}
              <InfoTip text="from the oracle process's timing sink — it covers every run this brain process has served and is NOT scoped to the project picker or a single run (spans carry no run tag)" />
            </SectionTitle>
            {tm.error && <ErrorStrip what="timing" error={tm.error} />}
          </CardHeader>
          <CardContent className="space-y-2.5">
            {(!tm.data || tm.data.phases.length === 0) && (
              <p className="text-sm text-muted-foreground">no timing yet — run <code className="font-mono">pnpm dev</code>, which writes the timing sink.</p>
            )}
            {tm.data?.phases.map((p) => (
              <div key={p.name} className="text-sm">
                <div className="mb-1 flex justify-between gap-2">
                  <span className="min-w-0 truncate font-mono">{p.name} <span className="text-xs text-muted-foreground">×{p.n}</span></span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{fmtMs(p.total)} · {(p.share * 100).toFixed(1)}%</span>
                </div>
                <Progress value={Math.max(2, (p.total / top) * 100)} aria-label={`${p.name}: ${(p.share * 100).toFixed(1)}% of wall`} />
              </div>
            ))}
            {tm.data && tm.data.phases.length > 0 && (
              <p className="pt-1 text-xs text-muted-foreground">bars are relative to the biggest phase; share is of wall (can exceed 100% when tasks run in parallel — spans nest).</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
