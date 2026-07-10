// Search: live semantic recall — exactly what a worker gets back, ranked the way the worker receives it.
// RRF scores live in a ~0.0007-wide band, so printing "score 0.020" fifteen times made the ranking
// unverifiable; the rank number + a bar relative to the top hit is the honest rendering. Superseded notes
// are flagged, not hidden. Results clamp at three lines (they used to be walls of raw content).
import { useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronUp, SearchX, TriangleAlert } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { CopyButton, SectionTitle } from "@/components/bits"
import { sourceBadge } from "@/components/meta"
import { search, type SearchResult } from "@/lib/api"

export function SearchPage({ project }: { project: string }) {
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

  const maxScore = results?.reduce((m, r) => Math.max(m, r.score ?? 0), 0) ?? 0

  return (
    <Card>
      <CardHeader className="pb-1">
        <SectionTitle sub="semantic recall — exactly what a worker gets back">search</SectionTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={(e) => { e.preventDefault(); run() }} className="flex gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="how do we authenticate users?"
            aria-label="search the brain"
            className="max-sm:h-10"
          />
          <Button type="submit" disabled={busy} className="max-sm:h-10">
            {busy ? <><Spinner className="size-3.5" /> searching…</> : "search"}
          </Button>
        </form>

        {error && (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden />
            <AlertTitle className="font-normal">can't reach oracle-lite ({error}) — retry the search.</AlertTitle>
          </Alert>
        )}

        {results?.length === 0 && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><SearchX aria-hidden /></EmptyMedia>
              <EmptyTitle>nothing in the brain for that query</EmptyTitle>
              <EmptyDescription>try broader words — workers phrase findings as facts, not questions.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}

        <ol className="space-y-2">
          {results?.map((r, i) => {
            const src = sourceBadge(r.source ?? "")
            const rel = maxScore > 0 && r.score != null ? Math.max(4, (r.score / maxScore) * 100) : null
            return (
              <li key={r.id} className="rounded-md border p-2.5 text-sm">
                <div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-semibold text-foreground tabular-nums">#{i + 1}</span>
                  {rel != null && (
                    <span className="flex items-center gap-1.5" title={`relative to the top hit (raw score ${r.score?.toFixed(4)})`}>
                      <Progress value={rel} className="w-20 gap-0" aria-label={`relevance ${Math.round(rel)}% of the top hit`} />
                      <span>relevance</span>
                    </span>
                  )}
                  <Badge variant="secondary" className={`h-4 px-1.5 text-[10px] ${src.cls}`}>{src.label}</Badge>
                  {r.superseded_by && <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-amber-400" title={`superseded by ${r.superseded_by}`}>superseded</Badge>}
                  <span className="ml-auto flex min-w-0 items-center gap-1">
                    <span className="min-w-0 truncate font-mono">{r.id}</span>
                    <CopyButton text={r.id} label="copy finding id" />
                  </span>
                </div>
                <details className="group">
                  <summary className="cursor-pointer list-none">
                    <span className="line-clamp-3 text-muted-foreground group-open:hidden">{r.content}</span>
                    <span className="hidden whitespace-pre-wrap text-foreground/90 group-open:block">{r.content}</span>
                    <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-primary/80">
                      <span className="inline-flex items-center gap-0.5 group-open:hidden"><ChevronDown className="size-3" aria-hidden /> more</span>
                      <span className="hidden items-center gap-0.5 group-open:inline-flex"><ChevronUp className="size-3" aria-hidden /> less</span>
                    </span>
                  </summary>
                </details>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
