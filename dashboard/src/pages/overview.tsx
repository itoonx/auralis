// Overview: the "what is happening" page — stat strip, live activity feed, and the findings column.
// The feed and findings scroll independently; every panel surfaces its own fetch error while keeping the
// last good data on screen (a blip must not blank the page).
import { useState, type ReactNode } from "react"
import { ChevronDown, ChevronUp, Pin } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { CopyButton, ErrorStrip, InfoTip, KindChip, SectionTitle } from "@/components/bits"
import { KIND, sourceBadge } from "@/components/meta"
import { getRuns, scorecard, type Finding, type Stats, type TimelineEvent } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { ago, clock } from "@/lib/time"

function Stat({ label, value, sub, tip }: { label: string; value: ReactNode; sub?: ReactNode; tip?: string }) {
  return (
    <Card size="sm">
      <CardContent>
        <div className="text-2xl leading-none font-semibold tabular-nums">{value}</div>
        <div className="mt-1.5 text-xs text-muted-foreground">
          {label}
          {sub != null && <> · {sub}</>}
          {tip && <> <InfoTip text={tip} /></>}
        </div>
      </CardContent>
    </Card>
  )
}

export function OverviewPage({ project, tick, tl, stats, docs, error, updatedAtMs, runSel, onClearRun }: {
  project: string
  tick: number
  tl: { run: string; events: TimelineEvent[] } | null
  stats: Stats | null
  docs: Finding[]
  error: string | null
  updatedAtMs: number
  runSel: string
  onClearRun: () => void
}) {
  const [showTraces, setShowTraces] = useState(false)
  const events = tl?.events ?? []
  const runId = tl?.run ?? ""

  const rn = usePoll(project ? (s) => getRuns(project, s) : null, [project, tick])
  const runs = rn.data?.runs ?? []

  const sc = scorecard(events)
  const nPrompts = events.filter((e) => e.kind === "prompt").length
  const nAnswers = events.filter((e) => e.kind === "answer").length
  const nTraces = events.filter((e) => e.kind === "trace").length
  // Newest first — the feed must open on what just happened, not on hours-old traces. Tool-step traces are
  // detail-on-demand: counted, hidden by default (they drown prompts/findings), one tap to show.
  const visible = [...events].reverse().filter((e) => showTraces || e.kind !== "trace")
  // The server caps the timeline at 500 — when we hit it, the badge counts describe a window, not the run.
  const capped = events.length >= 500

  const reusePct = stats?.seen ? Math.round(((stats.cited ?? 0) / stats.seen) * 100) : null

  return (
    <div className="space-y-4 sm:space-y-6">
      <h2 className="sr-only">overview</h2>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Stat label="findings in the brain" value={stats?.count ?? "—"} />
        <Stat
          label="reuse"
          value={reusePct == null ? "—" : `${reusePct}%`}
          sub={stats?.seen ? `cited ${stats.cited ?? 0} / seen ${stats.seen}` : undefined}
          tip="seen = times recall served a finding to a worker · cited = a worker credited it as materially helpful"
        />
        <Stat
          label="graph nodes · edges"
          value={stats ? `${stats.nodes} · ${stats.edges}` : "—"}
          tip="the same totals the graph page reports — when its view is capped, it says how much is shown"
        />
        <Stat label="runs recorded" value={runs.length || "—"} sub={runs[0]?.lastTs ? `last ${ago(runs[0].lastTs)}` : undefined} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle sub={updatedAtMs ? `updated ${clock(updatedAtMs)}` : undefined}>activity</SectionTitle>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                {sc.tasks > 0 && <Badge variant="secondary" title="distinct task nodes in this run"><KIND.intent.icon className="size-3 text-blue-400" aria-hidden /> tasks {sc.tasks}</Badge>}
                {sc.deduped > 0 && <Badge variant="secondary" className="text-amber-400" title="duplicate work caught before it ran twice"><KIND.dedup.icon className="size-3" aria-hidden /> deduped {sc.deduped}</Badge>}
                {sc.overlaps > 0 && <Badge variant="secondary" className="text-red-400" title="two workers touched the same target — a coordination miss"><KIND.overlap.icon className="size-3" aria-hidden /> overlaps {sc.overlaps}</Badge>}
                {sc.repairs > 0 && <Badge variant="secondary" className="text-orange-400" title="a worker repaired another's output"><KIND.repair.icon className="size-3" aria-hidden /> repairs {sc.repairs}</Badge>}
                {sc.notes > 0 && <Badge variant="secondary" className="text-violet-400" title="notes published to the shared brain"><KIND.note.icon className="size-3" aria-hidden /> notes {sc.notes}</Badge>}
                {nPrompts > 0 && <Badge variant="secondary" className="text-sky-400"><KIND.prompt.icon className="size-3" aria-hidden /> prompts {nPrompts}</Badge>}
                {nAnswers > 0 && <Badge variant="secondary" className="text-emerald-300"><KIND.answer.icon className="size-3" aria-hidden /> answers {nAnswers}</Badge>}
                {nTraces > 0 && (
                  <button
                    type="button"
                    aria-pressed={showTraces}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 ${showTraces ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => setShowTraces((v) => !v)}
                    title="tool steps (Read/Write per action) — detail on demand"
                  >
                    <KIND.trace.icon className="size-3" aria-hidden /> tools {nTraces} {showTraces ? "shown" : "hidden"}
                  </button>
                )}
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground">
              <span className="truncate">{runId || "—"}</span>
              {runId && <CopyButton text={runId} label="copy run id" />}
              {capped && <span title="the timeline endpoint returns at most 500 events — counts describe this window">· latest 500</span>}
            </div>
          </CardHeader>
          {/* The run-scope banner lives where its effect happens — selecting a run on the runs page used to
              silently rewrite this feed with zero indication. */}
          {runSel && (
            <div className="mx-4 mb-1 flex items-center justify-between gap-2 rounded-lg border border-primary/25 bg-primary/8 px-3 py-2 text-xs">
              <span className="min-w-0 truncate">
                showing run <span className="font-mono">{runSel}</span>
              </span>
              <button type="button" className="shrink-0 text-primary underline-offset-2 hover:underline" onClick={onClearRun}>
                back to latest
              </button>
            </div>
          )}
          {error && <div className="mx-4 mb-1"><ErrorStrip what="activity" error={error} /></div>}
          <Separator />
          <CardContent className="p-0">
            <ScrollArea className="h-[62vh]">
              <ol className="divide-y">
                {visible.length === 0 && (
                  <li className="p-6 text-sm text-muted-foreground">
                    no events yet — run <code className="font-mono">pnpm dev</code> against a repo, then watch them land here.
                  </li>
                )}
                {visible.map((e) => (
                  <li key={e.seq} className="flex items-start gap-3 px-4 py-2.5 hover:bg-muted/30">
                    <span className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums" title={e.ts}>{clock(e.ts)}</span>
                    <KindChip kind={e.kind} />
                    <div className="min-w-0 flex-1">
                      {/* Long events (prompts, answers) clamp to two lines; tap to read it all. */}
                      <details className="group">
                        <summary className="cursor-pointer list-none text-sm">
                          <span className="line-clamp-2 group-open:hidden">{e.human.replace(/^\S+\s/, "")}</span>
                          <span className="hidden whitespace-pre-wrap group-open:block">{e.human.replace(/^\S+\s/, "")}</span>
                        </summary>
                      </details>
                      {(e.nodeId || e.refs?.length) && (
                        <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                          {e.nodeId && <span className="font-mono">{e.nodeId}{e.parentNode?.length ? ` ← ${e.parentNode.join(",")}` : ""}</span>}
                          {e.refs?.length ? <span className="min-w-0 truncate font-mono">· {e.refs.join(", ")}</span> : null}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <SectionTitle sub="in the brain">findings</SectionTitle>
          </CardHeader>
          <Separator />
          <CardContent className="p-0">
            <ScrollArea className="h-[62vh]">
              <ul className="divide-y">
                {docs.length === 0 && <li className="p-6 text-sm text-muted-foreground">no findings for this project yet.</li>}
                {docs.map((d) => {
                  const src = sourceBadge(d.source ?? "")
                  return (
                    <li key={d.id} className="px-4 py-2.5">
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="secondary" className={`h-4 px-1.5 text-[10px] ${src.cls}`}>{src.label}</Badge>
                        {d.tier === "distilled" && <Badge className="h-4 px-1.5 text-[10px]">vetted</Badge>}
                        {d.pinned && <Pin className="size-3 text-amber-300" aria-label="pinned — never forgotten" />}
                        {d.archived && <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-muted-foreground">archived</Badge>}
                        <span className="text-[10px] text-muted-foreground" title="trust prior (by source)">trust {(d.trust ?? 0.5).toFixed(2)}</span>
                        {(d.timesUsed ?? 0) > 0 && <span className="text-[10px] text-emerald-300" title="cited as materially helpful">cited ×{d.timesUsed}</span>}
                        {(d.retrieved ?? 0) > 0 && <span className="text-[10px] text-muted-foreground" title="times served by recall">seen ×{d.retrieved}</span>}
                        <span className="ml-auto text-[10px] text-muted-foreground" title={d.createdAt}>{ago(d.createdAt)}</span>
                      </div>
                      <details className="group">
                        {/* A visible chevron affordance — the clamp used to be silently expandable. */}
                        <summary className="cursor-pointer list-none">
                          <span className="line-clamp-3 text-sm text-muted-foreground group-open:hidden">{d.content}</span>
                          <span className="hidden text-sm whitespace-pre-wrap text-foreground/90 group-open:block">{d.content}</span>
                          <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-primary/80">
                            <span className="inline-flex items-center gap-0.5 group-open:hidden"><ChevronDown className="size-3" aria-hidden /> more</span>
                            <span className="hidden items-center gap-0.5 group-open:inline-flex"><ChevronUp className="size-3" aria-hidden /> less</span>
                          </span>
                        </summary>
                      </details>
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/70">{d.id}</span>
                        <CopyButton text={d.id} label="copy finding id" />
                      </div>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
