// Decisions: the honest ADR log straight from the brain. Superseded ones are kept and flagged (reversed,
// never deleted) — the values layer, visible. Bodies are long; they clamp and expand per card.
import { ChevronDown, ChevronUp, ListChecks } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { CopyButton, ErrorStrip, SectionTitle } from "@/components/bits"
import { getDecisions } from "@/lib/api"
import { usePoll } from "@/lib/use-poll"
import { ago, dateTime } from "@/lib/time"

export function DecisionsPage({ project, tick }: { project: string; tick: number }) {
  const { data, error } = usePoll(project ? (s) => getDecisions(project, s) : null, [project, tick])
  const decisions = data?.decisions ?? []
  return (
    <Card>
      <CardHeader className="pb-1">
        <SectionTitle sub="honest ADRs — superseded, never deleted">decisions</SectionTitle>
        {error && <ErrorStrip what="decisions" error={error} />}
      </CardHeader>
      <CardContent className="space-y-3">
        {decisions.length === 0 && (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><ListChecks aria-hidden /></EmptyMedia>
              <EmptyTitle>no decisions yet</EmptyTitle>
              <EmptyDescription>agents record them via the <code className="font-mono">decide</code> tool as they work.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {decisions.map((d) => {
          const title = d.content.split("\n")[0].replace(/^Architecture Decision Record:\s*/, "")
          return (
            <div key={d.id} className={`rounded-md border p-3 ${d.supersededBy ? "opacity-70" : ""}`}>
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{title}</h3>
                {d.supersededBy && <Badge variant="outline" className="h-4 px-1.5 text-[10px] text-amber-400">reversed</Badge>}
                <span className="ml-auto text-[11px] text-muted-foreground" title={dateTime(d.createdAt)}>{ago(d.createdAt)}</span>
                <CopyButton text={d.id} label="copy decision id" />
              </div>
              {d.supersededReason && <div className="mb-1.5 text-[11px] text-amber-400/80">{d.supersededReason}</div>}
              <details className="group">
                <summary className="cursor-pointer list-none">
                  <pre className="line-clamp-4 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground group-open:hidden">{d.content}</pre>
                  <pre className="hidden font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground group-open:block">{d.content}</pre>
                  <span className="mt-1 inline-flex items-center gap-0.5 text-[10px] text-primary/80">
                    <span className="inline-flex items-center gap-0.5 group-open:hidden"><ChevronDown className="size-3" aria-hidden /> full record</span>
                    <span className="hidden items-center gap-0.5 group-open:inline-flex"><ChevronUp className="size-3" aria-hidden /> collapse</span>
                  </span>
                </summary>
              </details>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
