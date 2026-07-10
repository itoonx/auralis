// Small shared pieces used across every studio page — thin compositions of the shadcn primitives, so the
// repeated fiddly bits (real headings, honest zeros, copyable ids, per-panel errors) live here once.
import { useState, type ReactNode } from "react"
import { Check, Copy, Info, TriangleAlert } from "lucide-react"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { kindOf } from "@/components/meta"
import { cn } from "@/lib/utils"

/** Event-kind chip — lucide icon + word, never a bare glyph (a lone 🗣 meant nothing to a first-time viewer). */
export function KindChip({ kind }: { kind: string }) {
  const k = kindOf(kind)
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border border-current/20 bg-current/8 px-1.5 py-0.5 font-mono text-[10px] leading-none font-medium", k.cls)}>
      <k.icon className="size-3" aria-hidden /> {k.word}
    </span>
  )
}

/** Real heading — panels used to have zero <h*> elements, so screen readers saw one flat page. */
export function SectionTitle({ children, sub, className }: { children: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <h2 className={cn("font-heading text-base leading-snug font-medium", className)}>
      {children}
      {sub != null && <span className="ml-2 text-xs font-normal text-muted-foreground">{sub}</span>}
    </h2>
  )
}

/** ⓘ affordance for header math that used to go unexplained (reuse %, overlaps, deduped …). */
export function InfoTip({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        aria-label={text}
        className={cn("inline-flex size-4 items-center justify-center rounded-full align-[-2px] text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50", className)}
      >
        <Info className="size-3.5" aria-hidden />
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{text}</TooltipContent>
    </Tooltip>
  )
}

/** Honest zeros: color only speaks when a value is non-zero; zero renders as a muted em dash. */
export function Num({ v, cls }: { v: number | undefined | null; cls?: string }) {
  if (!v) return <span className="text-muted-foreground/40">—</span>
  return <span className={cn("tabular-nums", cls)}>{v}</span>
}

/** Copy-to-clipboard for ids — run ids and finding ids are useless truncated unless you can copy them. */
export function CopyButton({ text, label = "copy id" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className="size-5 text-muted-foreground"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(() => {
                setDone(true)
                setTimeout(() => setDone(false), 1200)
              })
            }}
          >
            {done ? <Check className="size-3 text-primary" aria-hidden /> : <Copy className="size-3" aria-hidden />}
          </Button>
        }
      />
      <TooltipContent>{done ? "copied" : label}</TooltipContent>
    </Tooltip>
  )
}

/** Per-panel fetch error — surfaced where it happens, while the panel keeps its last good data. */
export function ErrorStrip({ what, error }: { what: string; error: string }) {
  return (
    <Alert className="border-amber-400/25 bg-amber-400/8 py-1.5 text-amber-300/90">
      <TriangleAlert aria-hidden />
      <AlertTitle className="text-xs font-normal">
        can't reach the brain for <b className="font-medium">{what}</b> ({error}) — retrying, showing last data
      </AlertTitle>
    </Alert>
  )
}
